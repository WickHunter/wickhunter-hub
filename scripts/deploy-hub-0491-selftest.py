#!/usr/bin/env python3
"""Self-test for scripts/deploy-hub-0491.py — no systemd, no root, no real Hub.

It stands up a FAKE install tree in a temporary directory, a FAKE systemd (a
Host subclass whose `systemctl` starts/stops a real child process serving
/api/health on loopback, and whose `systemctl show` answers from that state),
and drives the real operator code through baseline -> package -> preflight ->
deploy -> verify, then through every refusal the review demanded: a stop that
was not a natural exit, a lingering PID, an undrained cgroup, a redirecting or
wrong-identity health answer, a tampered stage, a used stage, a used marker.
Decision functions and file handling are unit-tested directly.

Run:  python3 scripts/deploy-hub-0491.py --self-test
"""
from __future__ import annotations

import atexit
import http.server
import importlib.util
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPERATOR = HERE / "deploy-hub-0491.py"
OLD_VERSION, NEW_VERSION = "0.4.90", "0.4.91"
OLD_COMMIT = "a" * 40
NEW_COMMIT = "b" * 39 + "1"
WRONG_COMMIT = "c" * 40


# ── the fake Hub child process ───────────────────────────────────────────────
def run_fake_hub(argv):
    install = Path(argv[argv.index("--install-dir") + 1])
    port = int(argv[argv.index("--port") + 1])
    behaviour = argv[argv.index("--behaviour") + 1] if "--behaviour" in argv else "normal"
    if behaviour != "ignore-term":
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    else:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path != "/api/health":
                self.send_response(404); self.end_headers(); return
            if behaviour == "redirect":
                self.send_response(302); self.send_header("Location", "/api/health"); self.end_headers(); return
            version = re.search(r'HUB_VERSION = "([^"]+)"', (install / "dist/src/version.js").read_text()).group(1)
            try:
                record = json.loads((install / "data/hub-build.v1.json").read_text())
            except (OSError, ValueError):
                record = {}
            build = {"schemaVersion": 1, "packageVersion": record.get("packageVersion", version), "commit": record.get("commit"),
                     "branch": record.get("branch"), "builtAtMs": record.get("builtAtMs", 0)}
            if behaviour.startswith("commit-override:"):
                build["commit"] = behaviour.split(":", 1)[1]
            body = json.dumps({"ok": True, "version": version, "packageVersion": version, "build": build, "sourceVsRuntime": "unknown"}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()


if "--fake-hub" in sys.argv:
    run_fake_hub(sys.argv)
    sys.exit(0)

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("deploy_hub_0491", OPERATOR)
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)
op.STOP_SETTLE_SECONDS = 4
op.STABILITY_WINDOW_SECONDS = 1
op.READY_SECONDS = 20

CHILDREN = []


def reap_children():
    for child in CHILDREN:
        if child.poll() is None:
            child.kill()
            child.wait()


atexit.register(reap_children)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_port(port, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.05)
    return False


# ── the fake systemd ─────────────────────────────────────────────────────────
class FakeHost(op.Host):
    def __init__(self, root, unit, install, port, behaviour="normal", stop_mode="term", extra_units=()):
        self.root, self.unit, self.install, self.port = root, unit, install, port
        self.behaviour, self.stop_mode = behaviour, stop_mode
        self.fragment = root / "units" / unit
        self.fragment.parent.mkdir(exist_ok=True)
        self.fragment.write_text(f"[Service]\nExecStart=/usr/bin/node dist/src/main.js\nWorkingDirectory={install}\n")
        self.env_file = root / "etc" / "env"
        self.child = None
        self.cgroup_stuck = False
        self.extra_units = {u: {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "MainPID": "4242",
                                "InvocationID": "f" * 32, "NRestarts": "0"} for u in extra_units}
        self.state = {"ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "ControlPID": "0", "Job": "", "InvocationID": "",
                      "ControlGroup": f"/system.slice/{unit}", "NRestarts": "0", "Result": "success", "ExecMainCode": "exited",
                      "ExecMainStatus": "0", "ExecMainStartTimestampMonotonic": "0"}
        self.calls = []

    def euid(self):
        return 0

    def trusted_uid(self):
        return os.getuid()

    def user_ids(self, user, group):
        return os.getuid(), os.getgid()

    def mount_fstype(self, path):
        return "ext4"

    def proc_cgroup(self, pid):
        return self.state["ControlGroup"]

    def systemctl_show(self, unit, props, timeout=20):
        self.calls.append(("show", unit))
        if unit in self.extra_units:
            return {k: [v] for k, v in self.extra_units[unit].items() if k in props}
        if unit != self.unit:
            return {k: [""] for k in props} | {"LoadState": ["not-found"], "ActiveState": ["inactive"], "SubState": ["dead"], "MainPID": ["0"]}
        full = {"Id": unit, "LoadState": "loaded", "UnitFileState": "enabled", "FragmentPath": str(self.fragment), "DropInPaths": "",
                "NeedDaemonReload": "no", "User": os.environ.get("USER") or "user", "Group": "", "WorkingDirectory": str(self.install),
                "EnvironmentFiles": f"{self.env_file} (ignore_errors=no)", "ExecStart": "{ path=" + sys.executable + " ; argv[]=" + sys.executable + " dist/src/main.js ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }",
                "KillSignal": "15", "KillMode": "control-group", "TimeoutStopUSec": "1min 30s", **self.state}
        out = {k: [full.get(k, "")] for k in props}
        if "EnvironmentFiles" in props:
            out["EnvironmentFiles"] = [full["EnvironmentFiles"], f"{self.root}/etc/optional.env (ignore_errors=yes)"]
        return out

    def systemctl(self, verb, unit, timeout):
        self.calls.append((verb, unit))
        assert unit == self.unit, unit
        if verb == "start":
            self.child = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "--fake-hub", "--install-dir", str(self.install),
                                           "--port", str(self.port), "--behaviour", self.behaviour], stdin=subprocess.DEVNULL)
            CHILDREN.append(self.child)
            assert wait_port(self.port), "fake hub did not listen"
            self.state.update({"ActiveState": "active", "SubState": "running", "MainPID": str(self.child.pid),
                               "InvocationID": secrets.token_hex(16), "Job": "", "ExecMainStartTimestampMonotonic": str(int(time.monotonic() * 1e6))})
            return subprocess.CompletedProcess(["systemctl", "start", unit], 0, b"", b"")
        child = self.child
        if self.stop_mode == "term":
            child.terminate(); rc = child.wait(timeout)
            self.state.update({"ExecMainCode": "exited" if rc >= 0 else "killed", "ExecMainStatus": str(abs(rc)), "Result": "success"})
        elif self.stop_mode == "kill":
            child.kill(); rc = child.wait(timeout)
            self.state.update({"ExecMainCode": "killed", "ExecMainStatus": "9", "Result": "timeout"})
        elif self.stop_mode == "linger":
            self.state.update({"ExecMainCode": "exited", "ExecMainStatus": "0", "Result": "success"})  # lies: the child keeps running
        self.state.update({"ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "InvocationID": self.state["InvocationID"], "Job": ""})
        return subprocess.CompletedProcess(["systemctl", "stop", unit], 0, b"", b"")

    def cgroup_state(self, cgroup):
        if self.cgroup_stuck and self.state["ActiveState"] == "inactive":
            return {"exists": True, "procs": [999999], "populated": "1", "dirs": 1}
        if self.state["ActiveState"] == "active" and self.child and self.child.poll() is None:
            return {"exists": True, "procs": [self.child.pid], "populated": "1", "dirs": 1}
        return {"exists": False, "procs": [], "populated": "0", "dirs": 0}


# ── fixtures ─────────────────────────────────────────────────────────────────
def write(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    os.chmod(path, mode)


def make_fixture(root, version=OLD_VERSION, commit=OLD_COMMIT):
    install = root / "opt" / "wickhunter-hub"
    write(install / "dist/src/version.js", f'export const HUB_VERSION = "{version}";\n')
    write(install / "dist/src/main.js", "// entry\n")
    write(install / "dist/src/billing/service.js", "export const service = 1;\n")
    write(install / "dist/src/legacy.js", "export const legacy = 1;\n")
    write(install / "public/admin.html", "<html>admin</html>\n")
    write(install / "templates/install.sh", "#!/bin/sh\n", 0o755)
    write(install / "package.json", json.dumps({"name": "wickhunter-hub", "version": version}) + "\n")
    write(install / "package-lock.json", json.dumps({"version": version}) + "\n")
    write(install / "data/licenses.json", json.dumps({"lic-1": {"id": "lic-1"}, "lic-2": {"id": "lic-2"}}), 0o600)
    write(install / "data/revoked.json", json.dumps({}), 0o600)
    write(install / "data/license-signing.key", secrets.token_bytes(32), 0o600)
    write(install / "data/hub-build.v1.json", json.dumps({"schemaVersion": 1, "packageVersion": version, "commit": commit, "branch": "main", "builtAtMs": 1}), 0o600)
    write(install / "data/candles/bybit/BTCUSDT.jsonl", b"{}\n" * 100, 0o600)
    os.chmod(install / "data", 0o700)
    write(install / "releases/latest.json", json.dumps({"version": "0.90.135", "file": "wickhunter-beta-0.90.135.tar.gz", "sha256": "0" * 64}), 0o600)
    write(install / "releases/wickhunter-beta-0.90.135.tar.gz", secrets.token_bytes(64), 0o600)
    os.chmod(install / "releases", 0o700)
    alpha = root / "opt" / "liqhunter"
    write(alpha / "dist/index.js", "alpha\n")
    write(alpha / "package.json", json.dumps({"version": "0.90.152"}))
    write(alpha / ".deployed-commit", "deadbeef\n")
    port = free_port()
    write(root / "etc" / "env", f"HUB_PORT={port}\nHUB_ADMIN_TOKEN=not-a-real-token\nHUB_PUBLIC_ORIGIN=https://example.test/hub\n", 0o600)
    return install, alpha, port


def make_build(root, install):
    build = root / "build"
    for item in ("dist", "public", "templates", "package.json", "package-lock.json"):
        src = install / item
        if src.is_dir():
            shutil.copytree(src, build / item)
        else:
            shutil.copy2(src, build / item)
    write(build / "dist/src/version.js", f'export const HUB_VERSION = "{NEW_VERSION}";\n')
    write(build / "dist/src/billing/service.js", "export const service = 2; // fixed initial paid term\n")
    write(build / "dist/src/billing/initial-term.js", "export const initialTerm = true;\n")
    write(build / "public/admin.html", "<html>admin v2</html>\n")
    write(build / "package.json", json.dumps({"name": "wickhunter-hub", "version": NEW_VERSION}) + "\n")
    write(build / "package-lock.json", json.dumps({"version": NEW_VERSION}) + "\n")
    (build / "dist/src/legacy.js").unlink()
    tarball = root / "source.tar.gz"
    with tarfile.open(tarball, "w:gz") as tar:
        tar.add(build, arcname="wickhunter-hub")
    qualification = root / "HUB-0491-VERIFICATION.json"
    write(qualification, json.dumps({"sourceCommit": NEW_COMMIT, "version": NEW_VERSION, "gateSuites": 1, "gateExit": 0}), 0o600)
    return build, tarball, qualification


class Capture:
    def __init__(self):
        self.out, self.err = "", ""

    def __enter__(self):
        import io
        self._o, self._e = sys.stdout, sys.stderr
        self._bo, self._be = io.StringIO(), io.StringIO()
        sys.stdout, sys.stderr = self._bo, self._be
        return self

    def __exit__(self, *_):
        sys.stdout, sys.stderr = self._o, self._e
        self.out, self.err = self._bo.getvalue(), self._be.getvalue()


def run_op(host, argv):
    with Capture() as cap:
        code = op.main(argv, host=host)
    return code, cap.out, cap.err


def bring_up(root, **host_kwargs):
    install, alpha, port = make_fixture(root)
    unit = "fake-hub.service"
    host = FakeHost(root, unit, install, port, **host_kwargs)
    op.UNIT_DIRS = ("/etc/systemd/system/", str(host.fragment.parent) + "/")
    host.systemctl("start", unit, 10)
    return host, install, alpha, port, unit


def stage_for(root, host, install, alpha, unit, extra_pkg=()):
    base = root / "baseline.json"
    code, out, err = run_op(host, ["--service", unit, "--alpha-dir", str(alpha), "baseline", "--out", str(base)])
    assert code == 0, (out, err)
    build, tarball, qualification = make_build(root, install)
    stage = root / "stage"
    code, out, err = run_op(host, ["package", "--build-dir", str(build), "--baseline", str(base), "--out", str(stage), "--commit", NEW_COMMIT,
                                   "--version", NEW_VERSION, "--qualification", str(qualification), "--source-tarball", str(tarball), "--skip-git", *extra_pkg])
    assert code == 0, (out, err)
    return stage, json.loads(out)


def common_args(unit, alpha):
    return ["--service", unit, "--alpha-dir", str(alpha), "--protected-service", "fake-alpha.service", "--protected-service", "postgresql.service"]


# ── tiny runner ───────────────────────────────────────────────────────────────
RESULTS = {"pass": 0, "fail": 0}


def test(name, fn):
    root = Path(tempfile.mkdtemp(prefix="wh-deploy-0491-selftest-"))
    try:
        fn(root)
        RESULTS["pass"] += 1
        print(f"  ok   {name}")
    except Exception:
        RESULTS["fail"] += 1
        print(f"  FAIL {name}\n{traceback.format_exc()}")
    finally:
        reap_children()
        shutil.rmtree(root, ignore_errors=True)


def assert_typed_checklist(text):
    rows = [l for l in text.splitlines() if l.startswith("[")]
    assert rows, "checklist printed no rows"
    for row in rows:
        assert re.match(r"\[\s*(pass|fail|unknown)\] \S+ — .+", row), row
    return rows


# ── tests: decision functions ─────────────────────────────────────────────────
def t_checklist_and_judges(root):
    cl = op.Checklist("x")
    try:
        cl.render(); raise AssertionError("empty checklist rendered")
    except op.DeployError:
        pass
    try:
        op.Check("n", "maybe", "d"); raise AssertionError("untyped status accepted")
    except op.DeployError:
        pass
    good = {"ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "ControlPID": "0", "Job": "", "Result": "success", "ExecMainCode": "exited", "ExecMainStatus": "0"}
    assert op.judge_stop_state(good) is None
    assert "ExecMainCode" in op.judge_stop_state({**good, "ExecMainCode": "killed", "ExecMainStatus": "9"})
    assert "ExecMainStatus" in op.judge_stop_state({**good, "ExecMainStatus": "1"})
    assert "Job" in op.judge_stop_state({**good, "Job": "123"})
    assert "ControlPID" in op.judge_stop_state({**good, "ControlPID": "77"})
    body = {"ok": True, "version": "0.4.91", "packageVersion": "0.4.91", "build": {"packageVersion": "0.4.91", "commit": NEW_COMMIT}}
    assert op.judge_health_body(body, "0.4.91", NEW_COMMIT) is None
    assert "commit" in op.judge_health_body(body, "0.4.91", WRONG_COMMIT)
    assert "version" in op.judge_health_body(body, "0.4.90", NEW_COMMIT)
    assert "ok" in op.judge_health_body({**body, "ok": False}, "0.4.91", NEW_COMMIT)
    assert "build" in op.judge_health_body({"ok": True, "version": "0.4.91"}, "0.4.91", NEW_COMMIT)
    props = op.parse_show_output("MainPID=12\nEnvironmentFiles=/a (ignore_errors=no)\nEnvironmentFiles=/b (ignore_errors=yes)\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node dist/src/main.js ; ignore_errors=no }\n")
    assert props["EnvironmentFiles"] == ["/a (ignore_errors=no)", "/b (ignore_errors=yes)"]
    assert op.parse_exec_argv(props["ExecStart"][0]) == ["/usr/bin/node", "dist/src/main.js"]
    assert op.parse_env_file(b"# c\nHUB_PORT=8091\nX='q v'\nbad line\n") == {"HUB_PORT": "8091", "X": "q v"}
    assert op.parse_timeout_usec("1min 30s") == 90.0 and op.parse_timeout_usec("infinity") == 600.0
    assert op.count_registry(b'{"a":1,"b":2}') == 2 and op.count_registry(b"[1]") == 1 and op.count_registry(b"nope") is None
    assert op.package_path_allowed("dist/src/x.js", ["dist"]) and not op.package_path_allowed("data/licenses.json", ["dist", "data"])
    for bad in ("../x", "dist/../x", "/etc/passwd", "releases/latest.json"):
        try:
            assert not op.package_path_allowed(bad, ["dist", "releases"])
        except op.DeployError:
            pass
    assert op.sh("a'b") == "'a'\"'\"'b'"


def t_manifest_validation(root):
    files = {"dist/src/version.js": {"before": "1" * 64, "after": "2" * 64, "mode": 0o644}}
    m = {"schema": op.MANIFEST_SCHEMA, "expectedVersion": "0.4.91", "baselineVersion": "0.4.90", "sourceCommit": NEW_COMMIT, "sourceTree": None,
         "qualification": "qualification.json", "qualificationSha256": "3" * 64, "baselineSha256": "4" * 64, "include": ["dist"], "files": files,
         "removals": {}, "runtimeBundleSha256": op.runtime_bundle_digest(files), "buildTreeSha256": "5" * 64, "fullTree": False}
    op.validate_manifest(m)
    for mutate, needle in ((lambda x: x.update(sourceCommit="0" * 40), "placeholder"), (lambda x: x.update(schema="x"), "schema"),
                           (lambda x: x.update(runtimeBundleSha256="9" * 64), "digest"), (lambda x: x["files"].update({"data/x": {"before": None, "after": "2" * 64, "mode": 0o644}}), "outside"),
                           (lambda x: x["files"]["dist/src/version.js"].update(before="2" * 64), "identical"), (lambda x: x.update(expectedVersion="0.4.90"), "equals")):
        copy = json.loads(json.dumps(m)); mutate(copy)
        try:
            op.validate_manifest(copy); raise AssertionError(f"accepted a manifest that should fail on {needle}")
        except op.DeployError as err:
            assert needle in str(err), (needle, err)


def t_private_io(root):
    p = root / "a.json"
    op.write_exclusive(p, b"x")
    assert (p.stat().st_mode & 0o777) == 0o600
    try:
        op.write_exclusive(p, b"y"); raise AssertionError("overwrote an existing file")
    except FileExistsError:
        pass
    link = root / "link"
    os.symlink(root / "elsewhere", link)
    try:
        op.write_exclusive(link, b"y"); raise AssertionError("followed a symlink")
    except (FileExistsError, OSError):
        pass
    try:
        op.read_regular(link); raise AssertionError("read through a symlink")
    except (op.DeployError, OSError):
        pass
    install = root / "install"; (install / "dist/src").mkdir(parents=True)
    os.symlink(root / "evil", install / "dist/link")
    host = FakeHost(root, "fake-hub.service", install, 1)
    op.safe_target(host, install, "dist/src/x.js")
    try:
        op.safe_target(host, install, "dist/link/x.js"); raise AssertionError("accepted a symlinked ancestor")
    except op.DeployError:
        pass
    os.chmod(install / "dist/src", 0o777)
    try:
        op.safe_target(host, install, "dist/src/x.js"); raise AssertionError("accepted a world-writable ancestor")
    except op.DeployError:
        pass
    fd, temp = op.exclusive_temp(root, "t")
    os.close(fd)
    assert temp.name.startswith(".t-") and (temp.stat().st_mode & 0o777) == 0o600


def t_backup_roundtrip_and_tamper(root):
    install, alpha, port = make_fixture(root)
    host = FakeHost(root, "fake-hub.service", install, port)
    backup = root / "backup"; backup.mkdir(mode=0o700)
    result = op.backup_data_dir(host, install / "data", backup, ())
    assert result["verified"]["ok"] and result["regularFiles"] == 5, result
    listing = result.pop("entries")
    archive = Path(result["archive"])
    assert (archive.stat().st_mode & 0o777) == 0o600
    members = {k: v for k, v in listing.items()}
    op.verify_data_backup(archive, "data", members)
    members["licenses.json"]["sha256"] = "0" * 64
    try:
        op.verify_data_backup(archive, "data", members); raise AssertionError("tampered listing verified")
    except op.DeployError as err:
        assert "round-trip" in str(err)
    with tarfile.open(archive, "r:gz") as tar:
        names = tar.getnames()
    assert "data/license-signing.key" in names and "data/candles/bybit/BTCUSDT.jsonl" in names
    try:
        op.backup_data_dir(host, install / "data", backup, ("candles",)); raise AssertionError("a second backup overwrote the listing")
    except (op.DeployError, FileExistsError):
        pass
    backup2 = root / "backup2"; backup2.mkdir(mode=0o700)
    excluded = op.backup_data_dir(host, install / "data", backup2, ("candles",))
    assert excluded["regularFiles"] == 4 and excluded["excluded"] == ["candles"]


def t_proxy_and_loopback_health(root):
    install, alpha, port = make_fixture(root)
    host = FakeHost(root, "fake-hub.service", install, port)
    host.systemctl("start", "fake-hub.service", 10)
    os.environ["HTTP_PROXY"] = "http://127.0.0.1:1"
    os.environ["http_proxy"] = "http://127.0.0.1:1"
    body = op.fetch_health(port)  # http.client never consults a proxy; a dead proxy proves it
    assert body["version"] == OLD_VERSION
    removed = op.scrub_proxy_env()
    assert {"HTTP_PROXY", "http_proxy"} <= set(removed) and not any(v in os.environ for v in op.PROXY_VARS)
    listener = op.prove_listener(host, port, host.child.pid)
    assert listener["allLoopback"] and listener["pid"] == host.child.pid
    try:
        op.prove_listener(host, port, os.getpid()); raise AssertionError("foreign listener accepted")
    except op.DeployError:
        pass
    host.systemctl("stop", "fake-hub.service", 10)
    redirect = FakeHost(root, "fake-hub.service", install, port, behaviour="redirect")
    redirect.systemctl("start", "fake-hub.service", 10)
    try:
        op.fetch_health(port); raise AssertionError("redirect followed or accepted")
    except op.DeployError as err:
        assert "302" in str(err) and "redirect refused" in str(err)


def t_stop_proof_refusals(root):
    for mode, needle in (("kill", "did not stop naturally"), ("linger", "still exists")):
        sub = root / mode; sub.mkdir()
        host, install, alpha, port, unit = bring_up(sub, stop_mode=mode)
        facts = op.ServiceFacts(host, unit)
        original = op.capture_original(host, facts)
        assert original["pid"] == host.child.pid and original["invocationId"]
        try:
            op.stop_and_prove(host, facts, original); raise AssertionError(f"{mode} stop accepted")
        except op.DeployError as err:
            assert needle in str(err), (mode, err)
        reap_children()
    sub = root / "cgroup"; sub.mkdir()
    host, install, alpha, port, unit = bring_up(sub)
    host.cgroup_stuck = True
    facts = op.ServiceFacts(host, unit)
    original = op.capture_original(host, facts)
    try:
        op.stop_and_prove(host, facts, original); raise AssertionError("undrained cgroup accepted")
    except op.DeployError as err:
        assert "not drained" in str(err)
    sub = root / "clean"; sub.mkdir()
    host, install, alpha, port, unit = bring_up(sub)
    facts = op.ServiceFacts(host, unit)
    proof = op.stop_and_prove(host, facts, op.capture_original(host, facts))
    assert proof["naturalExit"] and proof["pidFate"] == "gone" and proof["unitState"]["ExecMainStatus"] == "0"


# ── tests: the whole procedure ────────────────────────────────────────────────
def t_happy_path(root):
    host, install, alpha, port, unit = bring_up(root, extra_units=("fake-alpha.service",))
    old_pid = host.child.pid
    stage, pkg = stage_for(root, host, install, alpha, unit)
    assert pkg["files"] == 6 and pkg["removals"] == 1, pkg
    manifest = json.loads((stage / "manifest.json").read_text())
    assert manifest["files"]["dist/src/billing/initial-term.js"]["before"] is None
    assert "dist/src/legacy.js" in manifest["removals"]
    args = common_args(unit, alpha)
    code, out, err = run_op(host, [*args, "preflight", "--stage", str(stage)])
    rows = assert_typed_checklist(out)
    assert code == 0 and "PREFLIGHT PASS" in out, (out, err)
    assert any("protected.service.postgresql.service" in r and "absent" in r for r in rows)
    assert any("protected.service.fake-alpha.service" in r and "[   pass]" in r for r in rows)
    assert (install / "dist/src/version.js").read_text().count(OLD_VERSION) == 1, "preflight mutated the tree"
    code, out, err = run_op(host, [*args, "deploy", "--stage", str(stage), "--confirm-version", "0.4.90"])
    assert code == 2 and "DEPLOY REFUSED" in out and "confirm-version" in out
    assert not (stage / op.MARKER_IN_PROGRESS).exists()
    code, out, err = run_op(host, [*args, "deploy", "--stage", str(stage), "--confirm-version", NEW_VERSION])
    assert code == 0, (out, err)
    summary = json.loads(out.splitlines()[-1])
    receipt = json.loads((stage / "receipt.json").read_text())
    assert summary["oldPid"] == old_pid and summary["newPid"] == host.child.pid and summary["newPid"] != old_pid
    assert receipt["original"]["invocationId"] != receipt["new"]["invocationId"]
    assert receipt["stopProof"]["naturalExit"] and receipt["stopProof"]["pidFate"] == "gone"
    assert receipt["new"]["health"]["version"] == NEW_VERSION and receipt["new"]["health"]["build"]["commit"] == NEW_COMMIT
    assert receipt["new"]["listener"]["pid"] == host.child.pid
    for key in ("sourceTarballSha256", "qualificationSha256", "runtimeBundleSha256", "buildTreeSha256", "baselineSha256", "sha256"):
        assert re.fullmatch(r"[0-9a-f]{64}", str(receipt["manifest"][key])), key
    assert receipt["installedRuntimeSha256"] == receipt["manifest"]["runtimeBundleSha256"]
    assert receipt["installedTreeSha256"] == receipt["manifest"]["buildTreeSha256"]
    assert receipt["dataUntouchedExceptBuildRecord"] and receipt["dataWrites"] == ["hub-build.v1.json"]
    assert receipt["licenceCountsBefore"] == receipt["licenceCountsAfter"] == {"licenses": 2, "revoked": 0}
    assert receipt["protectedFingerprintsBefore"] == receipt["protectedFingerprintsAfter"]
    assert receipt["protectedServicesBefore"] == receipt["protectedServicesAfter"]
    assert receipt["dataBackup"]["verified"]["ok"] and Path(receipt["dataBackup"]["archive"]).exists()
    assert NEW_VERSION in (install / "dist/src/version.js").read_text()
    assert (install / "dist/src/billing/initial-term.js").exists() and not (install / "dist/src/legacy.js").exists()
    assert (stage / "backup/retired/dist/src/legacy.js").exists()
    assert (stage / "backup/runtime/dist/src/version.js").read_text().count(OLD_VERSION) == 1
    record = json.loads((install / "data/hub-build.v1.json").read_text())
    assert record["commit"] == NEW_COMMIT and record["packageVersion"] == NEW_VERSION
    assert ((install / "data/hub-build.v1.json").stat().st_mode & 0o777) == 0o600
    assert (install / "data/license-signing.key").exists() and (install / "releases/latest.json").exists()
    assert json.loads((stage / "backup/build-record-before.json").read_text())["commit"] == OLD_COMMIT
    recovery = json.loads((stage / "backup/recovery.json").read_text())
    assert any("systemctl start fake-hub.service" in l for l in recovery["manualRollback"])
    assert not (stage / op.MARKER_IN_PROGRESS).exists() and list(stage.glob("deploy-finished-*.json"))
    live = op.fetch_health(port)
    assert live["version"] == NEW_VERSION and live["build"]["commit"] == NEW_COMMIT
    code, out, err = run_op(host, [*args, "verify", "--stage", str(stage)])
    assert_typed_checklist(out)
    assert code == 0 and "VERIFY PASS" in out, (out, err)
    code, out, err = run_op(host, [*args, "print-rollback", "--stage", str(stage)])
    assert code == 0 and "install -o" in out and "sha256sum" in out
    code, out, err = run_op(host, [*args, "deploy", "--stage", str(stage), "--confirm-version", NEW_VERSION])
    assert code == 2 and "stage.markers" in out and "DEPLOY REFUSED" in out, (out, err)
    assert NEW_VERSION in (install / "dist/src/version.js").read_text()
    host.systemctl("stop", unit, 10); host.systemctl("start", unit, 10)  # a later restart must be visible to verify
    code, out, err = run_op(host, [*args, "verify", "--stage", str(stage)])
    assert code == 2 and "service.identity" in out and "[   fail]" in out


def t_failure_after_start_no_rollback(root):
    host, install, alpha, port, unit = bring_up(root)
    stage, _ = stage_for(root, host, install, alpha, unit)
    host.behaviour = f"commit-override:{WRONG_COMMIT}"  # the NEW process will answer a wrong commit
    args = common_args(unit, alpha)
    code, out, err = run_op(host, [*args, "deploy", "--stage", str(stage), "--confirm-version", NEW_VERSION])
    assert code == 2, (out, err)
    assert "DEPLOY FAILED in phase 'start'" in err and "build.commit" in err, err
    assert "No rollback and no retry" in err and "Manual rollback recipe" in err and "install -o" in err
    failures = list(stage.glob("deploy-failed-*.json"))
    assert len(failures) == 1 and not (stage / "receipt.json").exists() and (stage / op.MARKER_IN_PROGRESS).exists()
    failure = json.loads(failures[0].read_text())
    assert failure["phase"] == "start" and failure["automaticRollback"] is False and "dist/src/version.js" in failure["replaced"]
    assert NEW_VERSION in (install / "dist/src/version.js").read_text(), "a rollback happened"
    assert host.child.poll() is None, "the new process was stopped"
    assert (stage / "backup/recovery.json").exists() and Path(failure["evidence"]["dataBackup"]["archive"]).exists()
    assert ("stop", unit) in host.calls and host.calls.count(("start", unit)) == 2 and host.calls.count(("stop", unit)) == 1


def t_failure_before_replacement(root):
    host, install, alpha, port, unit = bring_up(root, stop_mode="kill")
    stage, _ = stage_for(root, host, install, alpha, unit)
    args = common_args(unit, alpha)
    code, out, err = run_op(host, [*args, "deploy", "--stage", str(stage), "--confirm-version", NEW_VERSION])
    assert code == 2 and "DEPLOY FAILED in phase 'stop'" in err and "Nothing under" in err, err
    assert OLD_VERSION in (install / "dist/src/version.js").read_text() and (install / "dist/src/legacy.js").exists()
    assert json.loads((install / "data/hub-build.v1.json").read_text())["commit"] == OLD_COMMIT
    assert (stage / "backup/runtime/dist/src/version.js").exists(), "the runtime backup is taken before the stop"
    assert not list(stage.glob("backup/data-*.tar.gz")), "no data backup is claimed when the stop failed"
    assert host.calls.count(("start", unit)) == 1, "no automatic restart after the failed stop"
    failure = json.loads(next(stage.glob("deploy-failed-*.json")).read_text())
    assert failure["replaced"] == [] and failure["recovery"] is None


def t_tampered_stage_and_markers(root):
    host, install, alpha, port, unit = bring_up(root)
    stage, _ = stage_for(root, host, install, alpha, unit)
    args = common_args(unit, alpha)
    artifact = stage / "files/dist/src/version.js"
    original = artifact.read_bytes()
    artifact.write_bytes(original + b"// tampered\n")
    code, out, err = run_op(host, [*args, "preflight", "--stage", str(stage)])
    assert code == 2 and "stage.load" in out and "artifact mismatch" in out, out
    artifact.write_bytes(original)
    code, out, err = run_op(host, [*args, "preflight", "--stage", str(stage)])
    assert code == 0, out
    (stage / "evil").symlink_to("/etc/passwd")
    code, out, err = run_op(host, [*args, "preflight", "--stage", str(stage)])
    assert code == 2 and "symlink" in out
    (stage / "evil").unlink()
    (stage / op.MARKER_IN_PROGRESS).write_text("{}")
    code, out, err = run_op(host, [*args, "preflight", "--stage", str(stage)])
    assert code == 2 and "stage.markers" in out and "[   fail]" in out
    (stage / op.MARKER_IN_PROGRESS).unlink()
    os.chmod(stage, 0o750)
    code, out, err = run_op(host, [*args, "preflight", "--stage", str(stage)])
    assert code == 2 and "0700" in out
    os.chmod(stage, 0o700)
    (install / "dist/src/billing/service.js").write_text("export const service = 'drifted';\n")
    code, out, err = run_op(host, [*args, "preflight", "--stage", str(stage)])
    assert code == 2 and "live.files" in out and "differs" in out
    assert OLD_VERSION in (install / "dist/src/version.js").read_text()


def t_baseline_disagreement(root):
    host, install, alpha, port, unit = bring_up(root)
    stage, _ = stage_for(root, host, install, alpha, unit)
    args = common_args(unit, alpha)
    (root / "etc/env").write_text(f"HUB_PORT={port}\nHUB_DATA_DIR={install}/data-moved\n")
    (install / "data").rename(install / "data-moved")
    code, out, err = run_op(host, [*args, "preflight", "--stage", str(stage)])
    assert code == 2 and "baseline.service" in out and "dataDir" in out, out


def t_unknown_is_typed(root):
    host, install, alpha, port, unit = bring_up(root)
    stage, _ = stage_for(root, host, install, alpha, unit)
    manifest_path = stage / "manifest.json"
    m = json.loads(manifest_path.read_text())
    m["sourceTarball"] = None; m["sourceTarballSha256"] = None
    manifest_path.write_text(json.dumps(m, indent=2) + "\n")
    code, out, err = run_op(host, [*common_args(unit, alpha), "preflight", "--stage", str(stage)])
    assert code == 3 and "[unknown] source.tarball" in out and "PREFLIGHT NOT PASSED" in out, out


def t_unprivileged_and_missing_stage(root):
    host, install, alpha, port, unit = bring_up(root)
    stage, _ = stage_for(root, host, install, alpha, unit)

    class Unprivileged(FakeHost):
        def euid(self):
            return 1000
    low = Unprivileged(root, unit, install, port)
    code, out, err = run_op(low, [*common_args(unit, alpha), "preflight", "--stage", str(stage)])
    assert code == 2 and "[   fail] operator.euid" in out and "need" in out, out
    code, out, err = run_op(low, [*common_args(unit, alpha), "deploy", "--stage", str(stage), "--confirm-version", NEW_VERSION])
    assert code == 2 and "DEPLOY REFUSED" in out and OLD_VERSION in (install / "dist/src/version.js").read_text()
    code, out, err = run_op(host, [*common_args(unit, alpha), "preflight", "--stage", str(root / "no-such-stage")])
    assert code == 2 and "[   fail] stage.load" in out and "does not exist" in out, out
    code, out, err = run_op(host, [*common_args(unit, alpha), "verify", "--stage", str(root / "no-such-stage")])
    assert code == 2 and "receipt.present" in out and "does not exist" in out, out


def main():
    print(f"deploy-hub-0491 self-test on Python {sys.version.split()[0]}")
    for name, fn in (("decision functions and parsers", t_checklist_and_judges), ("manifest validation", t_manifest_validation),
                     ("private exclusive/no-follow file handling", t_private_io), ("data backup round-trip and tamper detection", t_backup_roundtrip_and_tamper),
                     ("loopback health ignores proxies, refuses redirects, proves the listener", t_proxy_and_loopback_health),
                     ("stop proof refuses SIGKILL, lingering PID and undrained cgroup", t_stop_proof_refusals),
                     ("baseline -> package -> preflight -> deploy -> verify -> used-stage refusal", t_happy_path),
                     ("failure after start: evidence, recipe, no rollback", t_failure_after_start_no_rollback),
                     ("failure before replacement: tree intact, no restart", t_failure_before_replacement),
                     ("tampered stage, symlink, marker, mode and live drift refusals", t_tampered_stage_and_markers),
                     ("baseline/live binding disagreement refusal", t_baseline_disagreement),
                     ("an unknown is printed typed and blocks the gate", t_unknown_is_typed),
                     ("unprivileged caller and missing stage are typed refusals", t_unprivileged_and_missing_stage)):
        test(name, fn)
    line = f"SELF-TEST: {RESULTS['pass']} passed, {RESULTS['fail']} failed"
    print(line)
    return 0 if RESULTS["fail"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
