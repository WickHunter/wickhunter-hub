#!/usr/bin/env python3
"""deploy-hub-0491.py — reviewed, single-pass, no-rollback Hub-only deployment operator.

Replaces the unexecuted draft that lived on the previous team's workstation.
It is the successor of scripts/deploy-audit-hub.py (0.4.62 / 0.4.64) and keeps
that operator's shape — a root-owned 0700 STAGE directory on a persistent
filesystem holding manifest.json plus every artifact at its Hub-relative path,
before/after SHA-256 per file, private verified copies, a durable code backup —
and adds what the review of the draft required:

  * typed, never-empty checklists (every check is named and pass/fail/unknown);
  * the ORIGINAL service's PID, systemd invocation id, cgroup and process start
    time are captured BEFORE the stop; after `systemctl stop` the operator
    proves a natural exit (ExecMainCode=1 — systemd's si_code digit for
    CLD_EXITED, which `systemctl status` renders as "code=exited" — ExecMainStatus=0,
    Result=success), that the PID is gone (or reused by a different process),
    and that the cgroup is drained (cgroup.procs empty, cgroup.events
    populated 0, descendants included) inside a bounded wait — any ambiguity
    refuses;
  * every subprocess call is bounded by a timeout, argv-only, shell=False, with
    a fixed minimal environment and no proxy variables;
  * health is fetched over literal loopback (http.client to "127.0.0.1", which
    cannot consult proxies), proxy variables are scrubbed anyway, redirects are
    refused, the body is bounded, and the answer is tied to the NEW MainPID and
    NEW InvocationID (the listener on the Hub port must belong to that PID and
    PID/invocation/NRestarts must be stable around the request) and to the
    EXACT expected version and commit;
  * the service name, unit file, user/group, install directory, environment
    file, port, data and releases directories are bound fresh from
    `systemctl show` and the bound environment file at run time;
  * temporary files are created O_EXCL|O_NOFOLLOW|O_CLOEXEC inside the trusted
    stage (or the target's own trusted parent), never in /tmp;
  * the receipt carries the SHA-256 of the source tarball, of the runtime bundle
    (manifest afters AND the installed bytes), and of the qualification
    evidence file, with timestamps, PIDs, invocation ids, commit and version;
  * a verified recoverable backup (data/ as a tarball whose every member is
    re-read and re-hashed, the replaced runtime files, the environment file, a
    recovery.json with the manual restore recipe) exists BEFORE any file is
    replaced;
  * data/, licence files, the release shelf, the Alpha tree and the Marketplace
    identity files are never written (one named exception: data/hub-build.v1.json,
    the non-secret installed-build record the health route reads the commit
    from, exactly as install-hub.sh writes it), and nothing is ever deleted —
    not even this operator's own failure evidence;
  * no automatic retry and no automatic rollback: on failure it stops, writes
    failure evidence, prints the manual rollback recipe and exits non-zero;
  * an idempotency guard refuses a stage that carries an in-progress marker, a
    receipt or failure evidence from an earlier run.

Modes (see docs/claude-review-2026-10-09/DEPLOY-HUB-0491-RUNBOOK.md):

  baseline  --out FILE                      on the box, root, read-only
  package   --build-dir DIR --baseline FILE --out STAGE --commit SHA ...   off-box
  preflight --stage DIR                     on the box, root, read-only
  deploy    --stage DIR --confirm-version V on the box, root, the one mutation
  verify    --stage DIR                     on the box, root, read-only
  print-rollback --stage DIR                prints the manual recipe, runs nothing
  --self-test                               runs scripts/deploy-hub-0491-selftest.py

Standard library only. Python 3.9+. Credentials never go in arguments, receipts
or logs; the only secret-bearing file the operator copies is the environment
file, into the root-only 0700 stage, and only its hash is recorded.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import io
import json
import os
import pwd
import grp
import re
import secrets
import stat
import subprocess
import sys
import tarfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

OPERATOR_VERSION = "deploy-hub-0491.py/1"
MANIFEST_SCHEMA = "wickhunter-hub.deploy-manifest.v1"
BASELINE_SCHEMA = "wickhunter-hub.deploy-baseline.v1"
RECEIPT_SCHEMA = "wickhunter-hub.deploy-receipt.v1"
DEFAULT_SERVICE = "wickhunter-hub.service"
DEFAULT_EXPECTED_VERSION = "0.4.91"
DEFAULT_BASELINE_VERSION = "0.4.90"
# Services that must be running before and after and must not restart.
# `postgresql` carries the Marketplace database on the box; its unit name
# varies by distribution, so absent units report `absent` (typed), never pass.
DEFAULT_PROTECTED_SERVICES = (
    "liqhunter.service",
    "liqhunter-marketplace-api.service",
    "liqhunter-marketplace-worker.service",
    "nginx.service",
    "postgresql.service",
)
ALPHA_DIR = "/opt/liqhunter"
ALPHA_PROTECTED = ("dist", "src", "public", "scripts", "migrations", "package.json",
                   "package-lock.json", ".deployed-commit", ".deployed-at", "bin", "native", ".native")
# Marketplace / Alpha identity files (bin/root-helper.ts, install-hub.sh,
# README "Marketplace operations bridge"). Never read for content, never
# written; their lstat facts + SHA-256 are fingerprinted before and after.
IDENTITY_FILES = (
    "/etc/wickhunter-hub/marketplace-state.env",   # root-only masked Marketplace state (intent signing identity)
    "/etc/wickhunter-hub/marketplace.env",         # Hub->private status bridge credential
    "/etc/wickhunter-hub/support.env",             # optional support bridge
    "/etc/liqhunter/marketplace-common.env",
    "/etc/liqhunter/marketplace-api.env",
    "/etc/liqhunter/marketplace-worker.env",
    "/etc/liqhunter/marketplace-migrate.env",
    "/etc/liqhunter/marketplace.env",              # legacy combined file
)
# Hub runtime roots a package may touch; data/ and releases/ are live state
# (README "Where the data lives", releases/README.md) and are never targets.
PACKAGE_ROOTS = ("dist", "public", "templates", "nginx", "scripts", "bin")
PACKAGE_TOP_FILES = ("package.json", "package-lock.json", "README.md", "tsconfig.json")
DEFAULT_PACKAGE_INCLUDE = ("dist", "public", "templates", "package.json", "package-lock.json")
HUB_PROTECTED_ROOTS = ("dist", "src", "public", "templates", "nginx", "scripts", "bin",
                       "migrations", "package.json", "package-lock.json")
BUILD_RECORD = "hub-build.v1.json"
LICENSES_FILE = "licenses.json"
REVOKED_FILE = "revoked.json"
MARKER_IN_PROGRESS = "deploy-in-progress.json"
RECEIPT_FILE = "receipt.json"
RECOVERY_FILE = "recovery.json"
FAILURE_PREFIX = "deploy-failed-"
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")
COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")
VERSION_RE = re.compile(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\Z")
UNIT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9@._:-]{0,200}\.service\Z")
RELATIVE_RE = re.compile(r"(?:[A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_.][A-Za-z0-9_.-]*\Z")
SAFE_ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C", "LC_ALL": "C",
    "SYSTEMD_PAGER": "", "SYSTEMD_COLORS": "0", "SYSTEMD_URLIFY": "0",
}
PROXY_VARS = ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy",
              "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY")
SUBPROCESS_TIMEOUT = 60
STOP_SETTLE_SECONDS = 45
READY_SECONDS = 240
# 2026-10-09, first live run on the Hub box: the Hub's event loop blocks for 45–50 s
# while it builds a `bitget 1440m x30` candle snapshot, so a 15 s probe timed out on
# a healthy service. One request now waits long enough for that block to end; the
# ready loop still retries transport errors inside READY_SECONDS. The block itself is
# a Hub defect (a snapshot build on the event loop), noted in the runbook, not hidden.
HEALTH_TIMEOUT = 90
# `systemctl show -p ExecMainCode` prints the exit's si_code as a DIGIT (1 = CLD_EXITED,
# 2 = CLD_KILLED, 3 = CLD_DUMPED, 0 = not exited); the word "exited" is what
# `systemctl status` renders, never what `show` answers. Found on the first live stop
# (2026-10-09): a natural stop was refused as `ExecMainCode='1' (want 'exited')`.
EXEC_MAIN_CODE_EXITED = "1"
HEALTH_BODY_MAX = 1024 * 1024
STABILITY_WINDOW_SECONDS = 3
MAX_FILE_BYTES = 512 * 1024 * 1024


class DeployError(RuntimeError):
    """A refusal. The message names the failed fact; nothing is retried."""


def require(ok: bool, message: str) -> None:
    if not ok:
        raise DeployError(message)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def scrub_proxy_env() -> List[str]:
    """Remove every proxy variable from this process. Returns what was removed."""
    removed = []
    for name in PROXY_VARS:
        if name in os.environ:
            removed.append(name)
            del os.environ[name]
    return removed


# ── typed checklist ──────────────────────────────────────────────────────────
class Check:
    __slots__ = ("name", "status", "detail")

    def __init__(self, name: str, status: str, detail: str) -> None:
        require(status in ("pass", "fail", "unknown"), "internal: check status must be typed")
        require(bool(name) and bool(detail), "internal: a check needs a name and a detail")
        self.name, self.status, self.detail = name, status, detail

    def row(self) -> Dict[str, str]:
        return {"name": self.name, "status": self.status, "detail": self.detail}


class Checklist:
    def __init__(self, title: str) -> None:
        self.title = title
        self.checks: List[Check] = []

    def add(self, name: str, status: str, detail: str) -> Check:
        c = Check(name, status, detail)
        self.checks.append(c)
        return c

    def passed(self) -> bool:
        return bool(self.checks) and all(c.status == "pass" for c in self.checks)

    def failures(self) -> List[Check]:
        return [c for c in self.checks if c.status != "pass"]

    def rows(self) -> List[Dict[str, str]]:
        return [c.row() for c in self.checks]

    def render(self) -> str:
        require(bool(self.checks), "internal: a checklist is never printed empty")
        lines = [f"== {self.title}: {len(self.checks)} check(s), "
                 f"{sum(1 for c in self.checks if c.status == 'pass')} pass, "
                 f"{sum(1 for c in self.checks if c.status == 'fail')} fail, "
                 f"{sum(1 for c in self.checks if c.status == 'unknown')} unknown"]
        for c in self.checks:
            lines.append(f"[{c.status:>7}] {c.name} — {c.detail}")
        return "\n".join(lines)


# ── hashing and private file I/O ─────────────────────────────────────────────
def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open_regular_nofollow(path) as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value))


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def pretty_json(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=False) + "\n").encode()


def lstat_or_none(path: Path) -> Optional[os.stat_result]:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def open_regular_nofollow(path: Path) -> io.BufferedReader:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode), f"refusing a non-regular file: {path}")
    except BaseException:
        os.close(fd)
        raise
    return os.fdopen(fd, "rb")


def read_regular(path: Path, max_bytes: int = MAX_FILE_BYTES) -> bytes:
    """Read a regular file without following a symlink, proving it did not change meanwhile."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode), f"refusing a non-regular file: {path}")
        require(before.st_size <= max_bytes, f"file larger than the operator's ceiling: {path}")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read()
        after = os.fstat(fd)
        named = path.lstat()
        require(stat.S_ISREG(named.st_mode) and named.st_dev == before.st_dev and named.st_ino == before.st_ino
                and before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns
                and len(data) == before.st_size, f"file changed while being read: {path}")
        return data
    finally:
        os.close(fd)


def sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_exclusive(path: Path, data: bytes, mode: int = 0o600, owner: Optional[Tuple[int, int]] = None) -> str:
    """Create `path` exclusively (never following a symlink), fsync it and its directory.

    A failed write is left in place under `<name>.partial-<random>` and named in
    the error — the operator never deletes anything, evidence included.
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(data)
            out.flush()
            os.fsync(fd)
            if owner is not None:
                os.fchown(fd, owner[0], owner[1])
            os.fchmod(fd, mode)
    except BaseException as err:
        os.close(fd)
        parked = path.with_name(f"{path.name}.partial-{secrets.token_hex(4)}")
        try:
            os.replace(path, parked)
        except OSError:
            parked = path
        raise DeployError(f"private write failed and was parked at {parked}: {err}") from err
    os.close(fd)
    sync_dir(path.parent)
    return sha256_bytes(data)


def exclusive_temp(directory: Path, prefix: str, mode: int = 0o600) -> Tuple[int, Path]:
    """Open an exclusive, no-follow temporary file inside a TRUSTED directory."""
    for _ in range(16):
        candidate = directory / f".{prefix}-{secrets.token_hex(8)}.tmp"
        try:
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
            return fd, candidate
        except FileExistsError:
            continue
    raise DeployError(f"could not create an exclusive temporary file in {directory}")


def mkdir_private(path: Path, trusted_uid: int) -> None:
    """Create a 0700 directory (or accept an existing real one owned by the trusted uid)."""
    st = lstat_or_none(path)
    if st is None:
        os.mkdir(path, 0o700)
        return
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == trusted_uid and not (stat.S_IMODE(st.st_mode) & 0o077),
            f"expected a private directory owned by uid {trusted_uid}: {path}")


# ── parsing helpers ──────────────────────────────────────────────────────────
def parse_show_output(text: str) -> Dict[str, List[str]]:
    """`systemctl show` prints Key=Value lines; a repeated key (EnvironmentFiles) is a list."""
    out: Dict[str, List[str]] = {}
    for raw in text.splitlines():
        if not raw or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        out.setdefault(key, []).append(value)
    return out


def show_value(props: Dict[str, List[str]], key: str) -> str:
    values = props.get(key, [])
    return values[0] if values else ""


def parse_env_file(data: bytes) -> Dict[str, str]:
    """systemd EnvironmentFile= grammar subset: KEY=VALUE, optional quotes, # comments."""
    out: Dict[str, str] = {}
    for line in data.decode("utf-8", "replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, value = s.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key] = value
    return out


def parse_exec_argv(exec_start: str) -> List[str]:
    """`ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node dist/src/main.js ; ... }`."""
    m = re.search(r"argv\[\]=(.*?)\s;\s", exec_start)
    if not m:
        return []
    return m.group(1).split()


def parse_timeout_usec(text: str) -> float:
    """`1min 30s` / `90s` / `infinity` → seconds (bounded by the operator anyway)."""
    if not text or text == "infinity":
        return 600.0
    total = 0.0
    for num, unit in re.findall(r"(\d+(?:\.\d+)?)\s*(ms|us|s|min|h|d|w|y|µs)", text):
        value = float(num)
        total += {"us": value / 1e6, "µs": value / 1e6, "ms": value / 1e3, "s": value, "min": value * 60,
                  "h": value * 3600, "d": value * 86400, "w": value * 604800, "y": value * 31557600}[unit]
    return total if total > 0 else 90.0


def count_registry(data: Optional[bytes]) -> Optional[int]:
    if data is None:
        return None
    try:
        value = json.loads(data)
    except ValueError:
        return None
    if isinstance(value, dict):
        return len(value)
    if isinstance(value, list):
        return len(value)
    return None


def safe_relative(relative: str) -> str:
    require(isinstance(relative, str) and RELATIVE_RE.fullmatch(relative) is not None
            and ".." not in relative.split("/") and not relative.startswith("/"),
            f"unsafe relative path: {relative!r}")
    return relative


def package_path_allowed(relative: str, include: Iterable[str]) -> bool:
    relative = safe_relative(relative)
    roots = set(include)
    first = relative.split("/", 1)[0]
    if "/" in relative:
        return first in roots and first in PACKAGE_ROOTS
    return relative in roots and relative in PACKAGE_TOP_FILES


# ── host boundary: every system interaction goes through here ────────────────
class Host:
    """Real host. Subclassed by the self-test to mock systemd and cgroups."""

    def euid(self) -> int:
        return os.geteuid()

    def trusted_uid(self) -> int:
        return 0

    def run(self, argv: List[str], timeout: float = SUBPROCESS_TIMEOUT, cwd: Optional[Path] = None) -> subprocess.CompletedProcess:
        require(all(isinstance(a, str) and "\0" not in a for a in argv) and argv, "internal: argv must be strings")
        return subprocess.run(argv, shell=False, check=False, capture_output=True, timeout=timeout,
                              env=dict(SAFE_ENV), cwd=str(cwd) if cwd else None, stdin=subprocess.DEVNULL)

    def systemctl_show(self, unit: str, props: Iterable[str], timeout: float = 20) -> Dict[str, List[str]]:
        require(UNIT_RE.fullmatch(unit) is not None, f"refusing an unexpected unit name: {unit!r}")
        p = self.run(["systemctl", "show", "--no-pager", "--all", "--property=" + ",".join(props), unit], timeout=timeout)
        require(p.returncode == 0, f"systemctl show {unit} failed (exit {p.returncode}): {p.stderr.decode('utf-8', 'replace').strip()[:300]}")
        return parse_show_output(p.stdout.decode("utf-8", "replace"))

    def systemctl(self, verb: str, unit: str, timeout: float) -> subprocess.CompletedProcess:
        require(verb in ("stop", "start"), "internal: only stop/start are issued")
        require(UNIT_RE.fullmatch(unit) is not None, f"refusing an unexpected unit name: {unit!r}")
        return self.run(["systemctl", verb, unit], timeout=timeout)

    def proc_starttime(self, pid: int) -> Optional[int]:
        try:
            data = Path(f"/proc/{pid}/stat").read_bytes()
        except OSError:
            return None
        tail = data[data.rfind(b")") + 2:].split()
        return int(tail[19]) if len(tail) > 19 else None

    def proc_cgroup(self, pid: int) -> Optional[str]:
        try:
            for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines():
                parts = line.split(":", 2)
                if len(parts) == 3 and parts[0] == "0":
                    return parts[2]
        except OSError:
            return None
        return None

    def proc_socket_inodes(self, pid: int) -> set:
        inodes = set()
        base = Path(f"/proc/{pid}/fd")
        try:
            names = os.listdir(base)
        except OSError:
            return inodes
        for name in names:
            try:
                target = os.readlink(base / name)
            except OSError:
                continue
            m = re.fullmatch(r"socket:\[(\d+)\]", target)
            if m:
                inodes.add(int(m.group(1)))
        return inodes

    def tcp_listeners(self, port: int) -> List[Dict[str, Any]]:
        found = []
        for table, family in (("/proc/net/tcp", 4), ("/proc/net/tcp6", 6)):
            try:
                lines = Path(table).read_text().splitlines()[1:]
            except OSError:
                continue
            for line in lines:
                cols = line.split()
                if len(cols) < 10 or cols[3] != "0A":
                    continue
                addr, hexport = cols[1].rsplit(":", 1)
                if int(hexport, 16) != port:
                    continue
                found.append({"family": family, "addr": addr, "inode": int(cols[9]),
                              "loopback": addr in ("0100007F", "00000000000000000000000001000000",
                                                    "0000000000000000FFFF00000100007F")})
        return found

    def cgroup_state(self, cgroup: str) -> Dict[str, Any]:
        """{'exists', 'procs', 'populated', 'dirs'} for a cgroup v2 path and its descendants."""
        # cgroup v2 (unified) first; the v1 named systemd hierarchy as a fallback, where
        # `cgroup.events` does not exist and "populated" is derived from cgroup.procs.
        root = None
        for base in ("/sys/fs/cgroup", "/sys/fs/cgroup/unified", "/sys/fs/cgroup/systemd"):
            candidate = Path(base) / cgroup.lstrip("/")
            if lstat_or_none(candidate) is not None and (candidate / "cgroup.procs").exists():
                root = candidate
                break
        if root is None:
            return {"exists": False, "procs": [], "populated": "0", "dirs": 0}
        procs: List[int] = []
        populated = "0"
        dirs = 0
        stack = [root]
        while stack:
            d = stack.pop()
            dirs += 1
            require(dirs <= 512, "cgroup tree larger than the operator's ceiling")
            try:
                here = [int(x) for x in (d / "cgroup.procs").read_text().split()]
                procs += here
                if (d / "cgroup.events").exists():
                    for row in (d / "cgroup.events").read_text().splitlines():
                        k, _, v = row.partition(" ")
                        if k == "populated" and v.strip() != "0":
                            populated = v.strip()
                elif here:
                    populated = "1"
            except OSError:
                populated = "unreadable"
            for child in d.iterdir():
                if child.is_dir() and not child.is_symlink():
                    stack.append(child)
        return {"exists": True, "procs": sorted(procs), "populated": populated, "dirs": dirs, "root": str(root)}

    def mount_fstype(self, path: Path) -> Optional[str]:
        target = str(path.resolve())
        best: Tuple[int, Optional[str]] = (-1, None)
        try:
            rows = Path("/proc/self/mountinfo").read_text().splitlines()
        except OSError:
            return None
        for row in rows:
            fields = row.split()
            if len(fields) < 10 or " - " not in row:
                continue
            mount_point = fields[4].replace("\\040", " ")
            fstype = row.split(" - ", 1)[1].split()[0]
            if (target == mount_point or target.startswith(mount_point.rstrip("/") + "/")) and len(mount_point) > best[0]:
                best = (len(mount_point), fstype)
        return best[1]

    def user_ids(self, user: str, group: str) -> Tuple[int, int]:
        return pwd.getpwnam(user).pw_uid, grp.getgrnam(group).gr_gid

    def disk_free(self, path: Path) -> int:
        st = os.statvfs(path)
        return st.f_bavail * st.f_frsize

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def monotonic(self) -> float:
        return time.monotonic()


# ── fingerprints (precedent: deploy-audit-hub.py) ────────────────────────────
def fingerprint(root: Path, exclude: Iterable[str] = ()) -> Optional[str]:
    """Hash bytes, symlink text and ownership/modes of a tree; None when absent."""
    if lstat_or_none(root) is None:
        return None
    h = hashlib.sha256()
    excluded = set(exclude)

    def walk(path: Path, relative: str) -> None:
        if relative in excluded:
            return
        s = path.lstat()
        h.update(json.dumps([relative, s.st_mode, s.st_uid, s.st_gid]).encode())
        if stat.S_ISLNK(s.st_mode):
            h.update(os.readlink(path).encode())
        elif stat.S_ISREG(s.st_mode):
            h.update(sha256_file(path).encode())
        elif stat.S_ISDIR(s.st_mode):
            for child in sorted(path.iterdir()):
                walk(child, child.relative_to(root).as_posix())
        else:
            raise DeployError(f"unsupported protected file type: {path}")

    walk(root, ".")
    return h.hexdigest()


def file_facts(path: Path) -> Optional[Dict[str, Any]]:
    """lstat facts plus SHA-256 for a regular file; content is never retained."""
    s = lstat_or_none(path)
    if s is None:
        return None
    facts: Dict[str, Any] = {"mode": stat.S_IMODE(s.st_mode), "uid": s.st_uid, "gid": s.st_gid,
                             "type": "regular" if stat.S_ISREG(s.st_mode) else "symlink" if stat.S_ISLNK(s.st_mode)
                             else "directory" if stat.S_ISDIR(s.st_mode) else "other", "size": s.st_size}
    if stat.S_ISREG(s.st_mode):
        facts["sha256"] = sha256_file(path)
    return facts


def tree_listing(root: Path, with_hash: bool) -> Dict[str, Dict[str, Any]]:
    """Every entry under root (relative → facts). Regular files get a sha256 when asked."""
    out: Dict[str, Dict[str, Any]] = {}
    require(lstat_or_none(root) is not None and stat.S_ISDIR(root.lstat().st_mode), f"not a directory: {root}")
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        d = Path(dirpath)
        dirnames.sort()
        for name in sorted(dirnames + filenames):
            p = d / name
            rel = p.relative_to(root).as_posix()
            s = p.lstat()
            row: Dict[str, Any] = {"mode": stat.S_IMODE(s.st_mode), "uid": s.st_uid, "gid": s.st_gid,
                                   "ino": s.st_ino, "dev": s.st_dev, "size": s.st_size, "mtimeNs": s.st_mtime_ns,
                                   "type": "directory" if stat.S_ISDIR(s.st_mode) else "regular" if stat.S_ISREG(s.st_mode)
                                   else "symlink" if stat.S_ISLNK(s.st_mode) else "other"}
            if with_hash and row["type"] == "regular":
                row["sha256"] = sha256_file(p)
            out[rel] = row
    return out


def listing_diff(before: Dict[str, Dict[str, Any]], after: Dict[str, Dict[str, Any]], keys: Iterable[str]) -> List[str]:
    keys = list(keys)
    changed = []
    for rel in sorted(set(before) | set(after)):
        a, b = before.get(rel), after.get(rel)
        if a is None or b is None:
            changed.append(rel)
        elif any(a.get(k) != b.get(k) for k in keys):
            changed.append(rel)
    return changed


# ── fresh service binding ────────────────────────────────────────────────────
SERVICE_PROPS = ("Id", "LoadState", "UnitFileState", "FragmentPath", "DropInPaths", "NeedDaemonReload", "User", "Group",
                 "WorkingDirectory", "EnvironmentFiles", "ExecStart", "ActiveState", "SubState", "MainPID", "ControlPID",
                 "Job", "InvocationID", "ControlGroup", "NRestarts", "Result", "ExecMainCode", "ExecMainStatus",
                 "KillSignal", "KillMode", "TimeoutStopUSec", "ExecMainStartTimestampMonotonic")
UNIT_DIRS = ("/etc/systemd/system/", "/lib/systemd/system/", "/usr/lib/systemd/system/")
RUNTIME_PROPS = ("ActiveState", "SubState", "MainPID", "ControlPID", "Job", "InvocationID", "ControlGroup",
                 "NRestarts", "Result", "ExecMainCode", "ExecMainStatus", "ExecMainStartTimestampMonotonic")


class ServiceFacts:
    def __init__(self, host: Host, unit: str) -> None:
        props = host.systemctl_show(unit, SERVICE_PROPS)
        self.unit = unit
        self.props = props
        require(show_value(props, "LoadState") == "loaded", f"{unit} is not loaded (LoadState={show_value(props, 'LoadState')!r})")
        require(show_value(props, "NeedDaemonReload") in ("no", ""), f"{unit} needs daemon-reload; refuse until the unit on disk is what runs")
        fragment = show_value(props, "FragmentPath")
        require(any(fragment.startswith(d) for d in UNIT_DIRS), f"{unit} fragment path is not a system unit: {fragment!r}")
        self.fragment_path = Path(fragment)
        self.fragment_facts = file_facts(self.fragment_path)
        require(self.fragment_facts is not None and self.fragment_facts["type"] == "regular", f"unit file is not a regular file: {fragment}")
        self.drop_ins = [d for d in show_value(props, "DropInPaths").split() if d]
        self.drop_in_facts = {d: file_facts(Path(d)) for d in self.drop_ins}
        self.user = show_value(props, "User")
        self.group = show_value(props, "Group") or self.user
        require(bool(self.user), f"{unit} declares no User=; the Hub runs unprivileged by design")
        self.uid, self.gid = host.user_ids(self.user, self.group)
        workdir = show_value(props, "WorkingDirectory")
        require(workdir.startswith("/"), f"{unit} has no absolute WorkingDirectory")
        self.install_dir = Path(workdir)
        st = self.install_dir.lstat()
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == host.trusted_uid() and not (stat.S_IMODE(st.st_mode) & 0o022),
                f"install directory must be a real directory owned by uid {host.trusted_uid()} and not group/other writable: {workdir}")
        env_files = []
        for entry in props.get("EnvironmentFiles", []):
            m = re.fullmatch(r"(\S+) \(ignore_errors=(yes|no)\)", entry.strip())
            if m:
                env_files.append((Path(m.group(1)), m.group(2) == "yes"))
        required = [p for p, ignore in env_files if not ignore]
        require(len(required) >= 1, f"{unit} declares no required EnvironmentFile=")
        self.env_file = required[0]
        self.env_files = env_files
        env_facts = file_facts(self.env_file)
        require(env_facts is not None and env_facts["type"] == "regular" and not (env_facts["mode"] & 0o077),
                f"environment file must be a regular 0600-class file: {self.env_file}")
        self.env_facts = env_facts
        self.env = parse_env_file(read_regular(self.env_file))
        port_text = self.env.get("HUB_PORT", "8091")
        require(re.fullmatch(r"\d{1,5}", port_text) is not None and 1 <= int(port_text) <= 65535, f"HUB_PORT in {self.env_file} is not a port: {port_text!r}")
        self.port = int(port_text)
        self.data_dir = Path(self.env.get("HUB_DATA_DIR") or (self.install_dir / "data"))
        self.releases_dir = Path(self.env.get("HUB_RELEASES_DIR") or (self.install_dir / "releases"))
        self.public_dir = Path(self.env.get("HUB_PUBLIC_DIR") or (self.install_dir / "public"))
        for label, d in (("data", self.data_dir), ("releases", self.releases_dir)):
            s = lstat_or_none(d)
            require(s is not None and stat.S_ISDIR(s.st_mode), f"{label} directory is not a real directory: {d}")
        self.exec_argv = parse_exec_argv(show_value(props, "ExecStart"))
        require(len(self.exec_argv) >= 2, f"{unit} ExecStart could not be parsed: {show_value(props, 'ExecStart')!r}")
        entry = self.exec_argv[-1]
        entry_path = Path(entry) if entry.startswith("/") else self.install_dir / entry
        require(entry_path == self.install_dir / "dist/src/main.js", f"{unit} does not start the Hub entry dist/src/main.js (argv={self.exec_argv})")
        self.node = self.exec_argv[0]
        self.kill_signal = show_value(props, "KillSignal")
        self.kill_mode = show_value(props, "KillMode")
        self.stop_budget = min(600.0, parse_timeout_usec(show_value(props, "TimeoutStopUSec")) + 30.0)

    def runtime(self, host: Host) -> Dict[str, str]:
        props = host.systemctl_show(self.unit, RUNTIME_PROPS)
        return {k: show_value(props, k) for k in RUNTIME_PROPS}

    def summary(self) -> Dict[str, Any]:
        return {"unit": self.unit, "fragmentPath": str(self.fragment_path), "fragment": self.fragment_facts,
                "dropIns": self.drop_in_facts, "user": self.user, "group": self.group, "uid": self.uid, "gid": self.gid,
                "installDir": str(self.install_dir), "envFile": str(self.env_file), "envFileFacts": self.env_facts,
                "optionalEnvFiles": [str(p) for p, ignore in self.env_files if ignore], "port": self.port,
                "dataDir": str(self.data_dir), "releasesDir": str(self.releases_dir), "node": self.node,
                "execArgv": self.exec_argv, "killSignal": self.kill_signal, "killMode": self.kill_mode,
                "stopBudgetSeconds": self.stop_budget}


def protected_service_facts(host: Host, units: Iterable[str]) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    for unit in units:
        props = host.systemctl_show(unit, ("LoadState", "ActiveState", "SubState", "MainPID", "InvocationID", "NRestarts"))
        row = {k: show_value(props, k) for k in ("LoadState", "ActiveState", "SubState", "MainPID", "InvocationID", "NRestarts")}
        row["presence"] = "present" if row["LoadState"] == "loaded" else "absent"
        out[unit] = row
    return out


# ── stop proof ───────────────────────────────────────────────────────────────
def judge_stop_state(rt: Dict[str, str]) -> Optional[str]:
    """None when the unit shows a complete natural stop; else the first disagreeing fact."""
    expectations = (("ActiveState", "inactive"), ("SubState", "dead"), ("MainPID", "0"), ("ControlPID", "0"),
                    ("Job", ""), ("Result", "success"), ("ExecMainCode", EXEC_MAIN_CODE_EXITED), ("ExecMainStatus", "0"))
    for key, want in expectations:
        if rt.get(key, "") != want:
            return f"{key}={rt.get(key, '')!r} (want {want!r})"
    return None


def capture_original(host: Host, facts: ServiceFacts) -> Dict[str, Any]:
    rt = facts.runtime(host)
    require(rt["ActiveState"] == "active" and rt["SubState"] == "running", f"{facts.unit} is not active/running before the stop ({rt['ActiveState']}/{rt['SubState']})")
    pid = int(rt["MainPID"] or "0")
    require(pid > 1, f"{facts.unit} has no MainPID before the stop")
    require(re.fullmatch(r"[0-9a-f]{32}", rt["InvocationID"] or "") is not None, f"{facts.unit} has no InvocationID before the stop")
    require(rt["ControlGroup"].startswith("/"), f"{facts.unit} reports no control group")
    starttime = host.proc_starttime(pid)
    require(starttime is not None, f"could not read /proc/{pid}/stat for the original Hub process")
    cg_now = host.cgroup_state(rt["ControlGroup"])
    require(pid in cg_now["procs"], f"MainPID {pid} is not inside its own cgroup {rt['ControlGroup']}")
    return {"pid": pid, "invocationId": rt["InvocationID"], "cgroup": rt["ControlGroup"], "startTime": starttime,
            "nRestarts": rt["NRestarts"], "execMainStartMonotonic": rt["ExecMainStartTimestampMonotonic"],
            "procCgroup": host.proc_cgroup(pid), "cgroupProcs": cg_now["procs"], "capturedAt": now_iso()}


def stop_and_prove(host: Host, facts: ServiceFacts, original: Dict[str, Any]) -> Dict[str, Any]:
    """`systemctl stop` then prove natural exit, PID gone, cgroup drained — bounded, no retry."""
    started = host.monotonic()
    p = host.systemctl("stop", facts.unit, timeout=facts.stop_budget)
    require(p.returncode == 0, f"systemctl stop {facts.unit} exited {p.returncode}: {p.stderr.decode('utf-8', 'replace').strip()[:300]}")
    deadline = host.monotonic() + STOP_SETTLE_SECONDS
    rt = facts.runtime(host)
    while judge_stop_state(rt) is not None and host.monotonic() < deadline \
            and (rt.get("Job", "") != "" or rt.get("ActiveState") in ("deactivating", "active")):
        host.sleep(0.5)
        rt = facts.runtime(host)
    disagreement = judge_stop_state(rt)
    require(disagreement is None, f"{facts.unit} did not stop naturally: {disagreement}; original MainPID {original['pid']} "
                                   f"(ExecMainCode={rt.get('ExecMainCode')!r} ExecMainStatus={rt.get('ExecMainStatus')!r} Result={rt.get('Result')!r})")
    pid = original["pid"]
    pid_fate = None
    while host.monotonic() < deadline:
        st = host.proc_starttime(pid)
        if st is None:
            pid_fate = "gone"
            break
        if st != original["startTime"]:
            pid_fate = "reused-by-another-process"
            break
        host.sleep(0.25)
    require(pid_fate is not None, f"original Hub PID {pid} still exists with its original start time after the stop")
    cg = host.cgroup_state(original["cgroup"])
    while (cg["exists"] and (cg["procs"] or cg["populated"] != "0")) and host.monotonic() < deadline:
        host.sleep(0.25)
        cg = host.cgroup_state(original["cgroup"])
    require(not cg["exists"] or (not cg["procs"] and cg["populated"] == "0"),
            f"cgroup {original['cgroup']} is not drained: procs={cg['procs']} populated={cg['populated']}")
    return {"stoppedAt": now_iso(), "stopSeconds": round(host.monotonic() - started, 3), "unitState": rt,
            "pidFate": pid_fate, "cgroupState": cg, "naturalExit": True}


# ── listener and health, tied to the new PID / invocation ────────────────────
def prove_listener(host: Host, port: int, pid: int) -> Dict[str, Any]:
    listeners = host.tcp_listeners(port)
    require(listeners, f"nothing listens on port {port}")
    owned = host.proc_socket_inodes(pid)
    foreign = [l for l in listeners if l["inode"] not in owned]
    require(not foreign, f"a listener on port {port} is not owned by MainPID {pid}: {foreign}")
    return {"port": port, "pid": pid, "listeners": listeners, "allLoopback": all(l["loopback"] for l in listeners)}


def fetch_health(port: int, timeout: float = HEALTH_TIMEOUT) -> Dict[str, Any]:
    """Literal loopback, no proxy (http.client never consults one), no redirect, bounded body."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("GET", "/api/health", headers={"Host": f"127.0.0.1:{port}", "Connection": "close", "Accept": "application/json"})
        resp = conn.getresponse()
        require(resp.status == 200, f"health answered HTTP {resp.status}{' (redirect refused)' if 300 <= resp.status < 400 else ''}")
        body = resp.read(HEALTH_BODY_MAX + 1)
        require(len(body) <= HEALTH_BODY_MAX, "health body exceeds the operator's ceiling")
    finally:
        conn.close()
    try:
        value = json.loads(body)
    except ValueError as err:
        raise DeployError(f"health body is not JSON: {err}") from err
    require(isinstance(value, dict), "health body is not an object")
    return value


def judge_health_body(body: Dict[str, Any], version: str, commit: Optional[str]) -> Optional[str]:
    """None when the body carries exactly the expected identity; else the first disagreeing fact."""
    if body.get("ok") is not True:
        return f"ok={body.get('ok')!r}"
    if body.get("version") != version:
        return f"version={body.get('version')!r} (want {version!r})"
    if "packageVersion" in body and body.get("packageVersion") != version:
        return f"packageVersion={body.get('packageVersion')!r} (want {version!r})"
    build = body.get("build")
    if not isinstance(build, dict):
        return "build record absent from health"
    if build.get("packageVersion") != version:
        return f"build.packageVersion={build.get('packageVersion')!r} (want {version!r})"
    if commit is not None and build.get("commit") != commit:
        return f"build.commit={build.get('commit')!r} (want {commit!r})"
    return None


def await_ready(host: Host, facts: ServiceFacts, version: str, commit: Optional[str], not_pid: Optional[int],
                not_invocation: Optional[str], budget: float = READY_SECONDS) -> Dict[str, Any]:
    """Wait (bounded) for a NEW MainPID/InvocationID answering the exact identity, stable across the probe."""
    deadline = host.monotonic() + budget
    last = "service not yet active"
    while host.monotonic() < deadline:
        rt = facts.runtime(host)
        pid = int(rt["MainPID"] or "0")
        if rt["ActiveState"] == "active" and rt["SubState"] == "running" and pid > 1 and pid != not_pid \
                and rt["InvocationID"] and rt["InvocationID"] != not_invocation:
            try:
                body = fetch_health(facts.port)
                verdict = judge_health_body(body, version, commit)
                require(verdict is None, f"health identity mismatch: {verdict}")
                listener = prove_listener(host, facts.port, pid)
                after = facts.runtime(host)
                require(after["MainPID"] == rt["MainPID"] and after["InvocationID"] == rt["InvocationID"]
                        and after["NRestarts"] == rt["NRestarts"], f"service identity moved during the probe: {rt} -> {after}")
                host.sleep(STABILITY_WINDOW_SECONDS)
                settled = facts.runtime(host)
                require(settled["MainPID"] == rt["MainPID"] and settled["InvocationID"] == rt["InvocationID"]
                        and settled["NRestarts"] == rt["NRestarts"] and settled["ActiveState"] == "active",
                        f"service identity moved inside the stability window: {rt} -> {settled}")
                return {"pid": pid, "invocationId": rt["InvocationID"], "nRestarts": rt["NRestarts"], "cgroup": rt["ControlGroup"],
                        "health": {"version": body.get("version"), "packageVersion": body.get("packageVersion"), "build": body.get("build"),
                                   "sourceVsRuntime": body.get("sourceVsRuntime")}, "listener": listener, "readyAt": now_iso(),
                        "execMainStartMonotonic": rt["ExecMainStartTimestampMonotonic"]}
            except (OSError, http.client.HTTPException) as err:
                # Only transport errors (connection refused/reset while Node binds) are waited out.
                # Any DeployError — wrong status, redirect, wrong identity, foreign listener — is definitive.
                last = f"{type(err).__name__}: {err}"
        else:
            last = f"ActiveState={rt['ActiveState']} SubState={rt['SubState']} MainPID={rt['MainPID']} Invocation={rt['InvocationID'][:8]}"
        host.sleep(1.0)
    raise DeployError(f"{facts.unit} did not reach a verified ready state inside {budget:.0f}s; last: {last}")


# ── stage and manifest ───────────────────────────────────────────────────────
def check_stage_dir(host: Host, stage: Path) -> Path:
    st = lstat_or_none(stage)
    require(st is not None, f"stage does not exist: {stage}")
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == host.trusted_uid() and stat.S_IMODE(st.st_mode) == 0o700,
            f"stage must be a real directory owned by uid {host.trusted_uid()} with mode 0700: {stage}")
    resolved = stage.resolve()
    fstype = host.mount_fstype(resolved)
    require(fstype not in ("tmpfs", "ramfs", "devtmpfs"), f"stage sits on a volatile filesystem ({fstype}); use a persistent directory such as /root/<change>-<date>")
    return resolved


def check_stage_tree(host: Host, stage: Path) -> int:
    """Every entry under the stage: owned by the trusted uid, not group/other writable, no symlinks."""
    count = 0
    for dirpath, dirnames, filenames in os.walk(stage, followlinks=False):
        d = Path(dirpath)
        for name in dirnames + filenames:
            p = d / name
            s = p.lstat()
            require(not stat.S_ISLNK(s.st_mode), f"stage contains a symlink: {p}")
            require(stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode), f"stage contains a special file: {p}")
            require(s.st_uid == host.trusted_uid() and not (stat.S_IMODE(s.st_mode) & 0o022),
                    f"stage entry must be owned by uid {host.trusted_uid()} and not group/other writable: {p}")
            count += 1
    return count


def stage_file(stage: Path, relative: str) -> Path:
    """A stage artifact: trusted ancestors (no symlinks, not writable by others), regular file."""
    current = stage
    for part in Path(safe_relative(relative)).parts[:-1]:
        current = current / part
        s = current.lstat()
        require(stat.S_ISDIR(s.st_mode) and not (stat.S_IMODE(s.st_mode) & 0o022), f"stage path contains an unsafe directory: {current}")
    path = stage / relative
    s = path.lstat()
    require(stat.S_ISREG(s.st_mode) and not (stat.S_IMODE(s.st_mode) & 0o022), f"stage artifact must be a regular, non-writable-by-others file: {path}")
    return path


def validate_manifest(value: Any) -> Dict[str, Any]:
    require(isinstance(value, dict), "manifest is not an object")
    require(value.get("schema") == MANIFEST_SCHEMA, f"manifest schema is not {MANIFEST_SCHEMA}")
    for key in ("expectedVersion", "baselineVersion"):
        require(isinstance(value.get(key), str) and VERSION_RE.fullmatch(value[key]) is not None, f"manifest {key} is not a version")
    require(value["expectedVersion"] != value["baselineVersion"], "manifest expectedVersion equals baselineVersion")
    require(isinstance(value.get("sourceCommit"), str) and COMMIT_RE.fullmatch(value["sourceCommit"]) is not None, "manifest sourceCommit is not a 40-hex commit")
    require(value.get("sourceCommit") != "0" * 40, "manifest sourceCommit is the placeholder; the qualified commit has not been filled in")
    tree = value.get("sourceTree")
    require(tree is None or (isinstance(tree, str) and COMMIT_RE.fullmatch(tree) is not None), "manifest sourceTree is not a 40-hex tree id")
    branch = value.get("sourceBranch")
    require(branch is None or (isinstance(branch, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}", branch)), "manifest sourceBranch is invalid")
    tarball = value.get("sourceTarball")
    require(tarball is None or (isinstance(tarball, str) and safe_relative(tarball) and isinstance(value.get("sourceTarballSha256"), str)
                                 and SHA_RE.fullmatch(value["sourceTarballSha256"]) is not None), "manifest sourceTarball needs a relative path and a sha256")
    require(isinstance(value.get("qualification"), str) and safe_relative(value["qualification"]) is not None, "manifest qualification path is missing")
    require(isinstance(value.get("qualificationSha256"), str) and SHA_RE.fullmatch(value["qualificationSha256"]) is not None, "manifest qualificationSha256 is invalid")
    require(isinstance(value.get("baselineSha256"), str) and SHA_RE.fullmatch(value["baselineSha256"]) is not None, "manifest baselineSha256 is invalid")
    files = value.get("files")
    require(isinstance(files, dict) and files, "manifest has no files")
    include = value.get("include")
    require(isinstance(include, list) and include and all(isinstance(i, str) for i in include), "manifest include list is invalid")
    for relative, evidence in files.items():
        require(package_path_allowed(relative, include), f"manifest names a path outside the allowed runtime roots: {relative}")
        require(isinstance(evidence, dict) and isinstance(evidence.get("after"), str) and SHA_RE.fullmatch(evidence["after"]) is not None,
                f"invalid after hash for {relative}")
        require(evidence.get("before") is None or (isinstance(evidence["before"], str) and SHA_RE.fullmatch(evidence["before"]) is not None),
                f"invalid before hash for {relative}")
        require(evidence.get("before") != evidence.get("after"), f"{relative} lists identical before/after hashes")
        require(isinstance(evidence.get("mode"), int) and 0 <= evidence["mode"] <= 0o777, f"invalid mode for {relative}")
    removals = value.get("removals", {})
    require(isinstance(removals, dict), "manifest removals is not an object")
    for relative, evidence in removals.items():
        require(package_path_allowed(relative, include) and relative not in files, f"invalid removal path: {relative}")
        require(isinstance(evidence, dict) and isinstance(evidence.get("before"), str) and SHA_RE.fullmatch(evidence["before"]) is not None,
                f"invalid before hash for removal {relative}")
    require(isinstance(value.get("runtimeBundleSha256"), str) and value["runtimeBundleSha256"] == runtime_bundle_digest(files),
            "manifest runtimeBundleSha256 does not equal the digest of its own after hashes")
    require(isinstance(value.get("buildTreeSha256"), str) and SHA_RE.fullmatch(value["buildTreeSha256"]) is not None, "manifest buildTreeSha256 is invalid")
    require(isinstance(value.get("fullTree"), bool), "manifest fullTree must be a boolean")
    return value


def runtime_bundle_digest(files: Dict[str, Dict[str, Any]], key: str = "after") -> str:
    h = hashlib.sha256()
    for relative in sorted(files):
        h.update(f"{relative}\0{files[relative][key]}\n".encode())
    return h.hexdigest()


def tree_digest(hashes: Dict[str, str]) -> str:
    h = hashlib.sha256()
    for relative in sorted(hashes):
        h.update(f"{relative}\0{hashes[relative]}\n".encode())
    return h.hexdigest()


def runtime_tree_hashes(root: Path, include: Iterable[str]) -> Dict[str, str]:
    """sha256 of every regular file under the included runtime roots (never data/, releases/, node_modules)."""
    include = list(include)
    out: Dict[str, str] = {}
    for item in include:
        if item in PACKAGE_TOP_FILES:
            p = root / item
            if lstat_or_none(p) is not None and stat.S_ISREG(p.lstat().st_mode):
                out[item] = sha256_file(p)
            continue
        require(item in PACKAGE_ROOTS, f"include names an unsupported root: {item}")
        base = root / item
        if lstat_or_none(base) is None:
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames if d != "node_modules")
            for name in sorted(filenames):
                p = Path(dirpath) / name
                s = p.lstat()
                if stat.S_ISREG(s.st_mode):
                    out[p.relative_to(root).as_posix()] = sha256_file(p)
    return out


def safe_target(host: Host, install_dir: Path, relative: str) -> Path:
    """The live path for a manifest entry: every ancestor a real, trusted, non-writable-by-others directory."""
    relative = safe_relative(relative)
    current = install_dir
    for part in Path(relative).parts[:-1]:
        current = current / part
        s = lstat_or_none(current)
        require(s is not None and stat.S_ISDIR(s.st_mode) and s.st_uid == host.trusted_uid() and not (stat.S_IMODE(s.st_mode) & 0o022),
                f"live path contains a missing, symlinked, foreign-owned or writable directory: {current}")
    target = install_dir / relative
    s = lstat_or_none(target)
    require(s is None or stat.S_ISREG(s.st_mode), f"live target is not a regular file: {target}")
    return target


def read_stage_manifest(host: Host, stage: Path) -> Tuple[Dict[str, Any], str]:
    data = read_regular(stage_file(stage, "manifest.json"))
    return validate_manifest(json.loads(data)), sha256_bytes(data)


def load_stage(host: Host, stage_arg: Path) -> Dict[str, Any]:
    """Everything the preflight and the deploy read from the stage, validated once."""
    stage = check_stage_dir(host, stage_arg)
    entries = check_stage_tree(host, stage)
    manifest, manifest_sha = read_stage_manifest(host, stage)
    qualification_path = stage_file(stage, manifest["qualification"])
    qualification = read_regular(qualification_path)
    require(sha256_bytes(qualification) == manifest["qualificationSha256"], "qualification evidence does not match the manifest hash")
    try:
        qual_value = json.loads(qualification)
    except ValueError as err:
        raise DeployError(f"qualification evidence is not JSON: {err}") from err
    require(isinstance(qual_value, dict), "qualification evidence is not an object")
    for key, want in (("sourceCommit", manifest["sourceCommit"]), ("version", manifest["expectedVersion"]), ("expectedVersion", manifest["expectedVersion"])):
        if key in qual_value:
            require(qual_value[key] == want, f"qualification {key}={qual_value[key]!r} disagrees with the manifest ({want!r})")
    baseline_path = stage_file(stage, "baseline.json")
    baseline_bytes = read_regular(baseline_path)
    require(sha256_bytes(baseline_bytes) == manifest["baselineSha256"], "baseline.json does not match the manifest hash")
    baseline = json.loads(baseline_bytes)
    require(isinstance(baseline, dict) and baseline.get("schema") == BASELINE_SCHEMA, "baseline.json has the wrong schema")
    source_sha = None
    if manifest.get("sourceTarball"):
        source_sha = sha256_file(stage_file(stage, manifest["sourceTarball"]))
        require(source_sha == manifest["sourceTarballSha256"], "source tarball does not match the manifest hash")
    artifacts: Dict[str, Path] = {}
    for relative, evidence in sorted(manifest["files"].items()):
        path = stage_file(stage, "files/" + relative)
        require(sha256_file(path) == evidence["after"], f"staged artifact mismatch: {relative}")
        artifacts[relative] = path
    return {"stage": stage, "entries": entries, "manifest": manifest, "manifestSha256": manifest_sha,
            "qualificationSha256": manifest["qualificationSha256"], "qualification": qual_value,
            "baseline": baseline, "sourceTarballSha256": source_sha, "artifacts": artifacts}


def stage_markers(stage: Path) -> List[str]:
    found = []
    for name in sorted(os.listdir(stage)):
        if name in (MARKER_IN_PROGRESS, RECEIPT_FILE) or name.startswith(FAILURE_PREFIX) or name.startswith("deploy-finished"):
            found.append(name)
    return found


# ── live baseline comparison ─────────────────────────────────────────────────
def compare_live_baseline(host: Host, facts: ServiceFacts, manifest: Dict[str, Any]) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
    """Live file facts for every manifest entry; returns (metadata, disagreements)."""
    metadata: Dict[str, Dict[str, Any]] = {}
    problems: List[str] = []
    for relative, evidence in sorted(manifest["files"].items()):
        target = safe_target(host, facts.install_dir, relative)
        existing = lstat_or_none(target)
        if evidence["before"] is None:
            if existing is not None:
                problems.append(f"{relative}: expected a new file but one exists")
            parent = target.parent.stat()
            metadata[relative] = {"existed": False, "mode": evidence["mode"] or 0o644, "uid": parent.st_uid, "gid": parent.st_gid}
        else:
            if existing is None:
                problems.append(f"{relative}: expected baseline file is absent")
                continue
            live = sha256_file(target)
            if live != evidence["before"]:
                problems.append(f"{relative}: live sha256 {live[:12]}… differs from manifest before {evidence['before'][:12]}…")
            metadata[relative] = {"existed": True, "mode": stat.S_IMODE(existing.st_mode), "uid": existing.st_uid, "gid": existing.st_gid}
    for relative, evidence in sorted(manifest.get("removals", {}).items()):
        target = safe_target(host, facts.install_dir, relative)
        existing = lstat_or_none(target)
        if existing is None:
            problems.append(f"{relative}: expected file to remove is already absent")
            continue
        live = sha256_file(target)
        if live != evidence["before"]:
            problems.append(f"{relative}: removal target sha256 differs from manifest before")
        metadata[relative] = {"existed": True, "remove": True, "mode": stat.S_IMODE(existing.st_mode), "uid": existing.st_uid, "gid": existing.st_gid}
    return metadata, problems


def protected_fingerprints(facts: ServiceFacts, manifest: Dict[str, Any], alpha_dir: Path) -> Dict[str, Optional[str]]:
    touched = set(manifest["files"]) | set(manifest.get("removals", {}))
    out: Dict[str, Optional[str]] = {}
    for relative in ALPHA_PROTECTED:
        out[str(alpha_dir / relative)] = fingerprint(alpha_dir / relative)
    for relative in HUB_PROTECTED_ROOTS:
        path = facts.install_dir / relative
        if relative in touched:
            continue
        exclusions = [name[len(relative) + 1:] for name in touched if name.startswith(relative + "/")]
        out[str(path)] = fingerprint(path, exclusions)
    out[str(facts.releases_dir)] = fingerprint(facts.releases_dir)
    for identity in IDENTITY_FILES + (str(facts.env_file), str(facts.fragment_path)) + tuple(facts.drop_ins):
        facts_row = file_facts(Path(identity))
        out[identity] = None if facts_row is None else sha256_json(facts_row)
    return out


# ── backups (verified before any replacement) ────────────────────────────────
def backup_data_dir(host: Host, data_dir: Path, backup_dir: Path, exclude: Iterable[str] = ()) -> Dict[str, Any]:
    """Tar data/ (root-only, 0600) and prove every member re-reads to the hash taken from the source."""
    excluded = set(exclude)
    listing = tree_listing(data_dir, with_hash=True)
    members = {rel: row for rel, row in listing.items() if not any(rel == e or rel.startswith(e + "/") for e in excluded)}
    tar_path = backup_dir / f"data-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{secrets.token_hex(3)}.tar.gz"
    require(lstat_or_none(tar_path) is None, f"backup archive name already exists: {tar_path}")
    fd, temp = exclusive_temp(backup_dir, "data-backup")
    name = data_dir.name
    try:
        with os.fdopen(fd, "wb") as raw, tarfile.open(fileobj=raw, mode="w:gz", format=tarfile.PAX_FORMAT) as tar:
            tar.add(data_dir, arcname=name, recursive=False)
            for rel in sorted(members):
                row = members[rel]
                p = data_dir / rel
                if row["type"] == "regular":
                    with open_regular_nofollow(p) as source:
                        info = tar.gettarinfo(p, arcname=f"{name}/{rel}")
                        require(info.isreg() and info.size == row["size"], f"data file changed before backup: {rel}")
                        tar.addfile(info, source)
                else:
                    tar.add(p, arcname=f"{name}/{rel}", recursive=False)
            raw.flush()
            os.fsync(raw.fileno())
        os.link(temp, tar_path)  # link, never replace: an existing archive is never overwritten
        os.unlink(temp)
        sync_dir(backup_dir)
    except BaseException as err:
        raise DeployError(f"data backup failed; partial archive left at {temp}: {err}") from err
    verification = verify_data_backup(tar_path, name, members)
    listing_path = backup_dir / "data-listing.json"
    write_exclusive(listing_path, pretty_json({"schema": "wickhunter-hub.deploy-data-listing.v1", "dataDir": str(data_dir),
                                               "capturedAt": now_iso(), "excluded": sorted(excluded), "entries": listing}))
    return {"archive": str(tar_path), "archiveSha256": sha256_file(tar_path), "archiveBytes": tar_path.stat().st_size,
            "members": len(members), "regularFiles": sum(1 for r in members.values() if r["type"] == "regular"),
            "bytes": sum(r["size"] for r in members.values() if r["type"] == "regular"), "excluded": sorted(excluded),
            "verified": verification, "listing": str(listing_path), "listingEntries": len(listing), "entries": listing}


def verify_data_backup(tar_path: Path, name: str, members: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Re-read the archive end to end: every regular member hashes to the source hash, nothing missing or extra."""
    seen = set()
    with open_regular_nofollow(tar_path) as raw, tarfile.open(fileobj=raw, mode="r:gz") as tar:
        for info in tar:
            rel = info.name[len(name) + 1:] if info.name.startswith(name + "/") else ("" if info.name == name else None)
            require(rel is not None, f"backup member outside the data prefix: {info.name}")
            if rel == "":
                continue
            require(rel in members, f"backup carries an unexpected member: {rel}")
            row = members[rel]
            seen.add(rel)
            if row["type"] == "regular":
                require(info.isreg(), f"backup member type changed: {rel}")
                h = hashlib.sha256()
                stream = tar.extractfile(info)
                require(stream is not None, f"backup member unreadable: {rel}")
                total = 0
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    h.update(chunk)
                    total += len(chunk)
                require(total == row["size"] and h.hexdigest() == row["sha256"], f"backup member does not round-trip: {rel}")
    missing = sorted(set(members) - seen)
    if missing:
        raise DeployError(f"backup is missing {len(missing)} member(s), first: {missing[0]}")
    return {"ok": True, "members": len(seen), "verifiedAt": now_iso()}


def backup_runtime_files(host: Host, facts: ServiceFacts, manifest: Dict[str, Any], metadata: Dict[str, Dict[str, Any]],
                         backup_dir: Path) -> Dict[str, Any]:
    runtime_dir = backup_dir / "runtime"
    mkdir_private(runtime_dir, host.trusted_uid())
    saved: Dict[str, str] = {}
    targets = {**manifest["files"], **manifest.get("removals", {})}
    for relative, evidence in sorted(targets.items()):
        if evidence.get("before") is None:
            continue
        source = safe_target(host, facts.install_dir, relative)
        data = read_regular(source)
        require(sha256_bytes(data) == evidence["before"], f"live file changed before backup: {relative}")
        destination = runtime_dir / relative
        current = runtime_dir
        for part in Path(relative).parts[:-1]:
            current = current / part
            mkdir_private(current, host.trusted_uid())
        write_exclusive(destination, data)
        require(sha256_file(destination) == evidence["before"], f"runtime backup verification failed: {relative}")
        saved[relative] = evidence["before"]
    env_copy = backup_dir / "env-file"
    env_sha = write_exclusive(env_copy, read_regular(facts.env_file))
    require(env_sha == facts.env_facts["sha256"], "environment file changed while being backed up")
    return {"runtimeDir": str(runtime_dir), "files": saved, "envFileCopy": str(env_copy), "envFileSha256": env_sha}


def write_recovery(backup_dir: Path, facts: ServiceFacts, manifest: Dict[str, Any], metadata: Dict[str, Dict[str, Any]],
                   data_backup: Dict[str, Any], runtime_backup: Dict[str, Any], build_record_before: Optional[Dict[str, Any]]) -> Path:
    recovery = {"schema": "wickhunter-hub.deploy-recovery.v1", "writtenAt": now_iso(), "service": facts.unit,
                "installDir": str(facts.install_dir), "dataDir": str(facts.data_dir), "envFile": str(facts.env_file),
                "baselineVersion": manifest["baselineVersion"], "expectedVersion": manifest["expectedVersion"],
                "sourceCommit": manifest["sourceCommit"], "files": manifest["files"], "removals": manifest.get("removals", {}),
                "metadata": metadata, "dataBackup": data_backup, "runtimeBackup": runtime_backup,
                "buildRecordBefore": build_record_before, "serviceUser": facts.user, "serviceGroup": facts.group,
                "manualRollback": rollback_recipe(backup_dir, facts, manifest, metadata, build_record_before)}
    path = backup_dir / RECOVERY_FILE
    write_exclusive(path, pretty_json(recovery))
    return path


def rollback_recipe(backup_dir: Path, facts: ServiceFacts, manifest: Dict[str, Any], metadata: Dict[str, Dict[str, Any]],
                    build_record_before: Optional[Dict[str, Any]]) -> List[str]:
    """The manual rollback, as commands the operator runs by hand. Nothing here is ever executed by this script."""
    lines = [f"# Manual rollback of {facts.unit} to {manifest['baselineVersion']} — run as root, one line at a time, read each result.",
             f"systemctl stop {facts.unit}",
             f"systemctl show {facts.unit} --property=ActiveState,SubState,MainPID,ControlPID,Job,Result,ExecMainCode,ExecMainStatus   # want inactive/dead/0/0//success/1/0 (ExecMainCode is the si_code digit: 1 = CLD_EXITED)"]
    for relative, evidence in sorted(manifest["files"].items()):
        target = facts.install_dir / relative
        meta = metadata.get(relative, {})
        if evidence["before"] is None:
            lines.append(f"mv -n {sh(str(target))} {sh(str(backup_dir / 'rolled-back-new-files' / relative))}   # new in {manifest['expectedVersion']}: move aside (never delete); mkdir -p the destination first")
        else:
            lines.append(f"install -o {meta.get('uid', 0)} -g {meta.get('gid', 0)} -m {meta.get('mode', 0o644):o} {sh(str(backup_dir / 'runtime' / relative))} {sh(str(target))}")
            lines.append(f"sha256sum {sh(str(target))}   # want {evidence['before']}")
    for relative, evidence in sorted(manifest.get("removals", {}).items()):
        meta = metadata.get(relative, {})
        target = facts.install_dir / relative
        lines.append(f"install -o {meta.get('uid', 0)} -g {meta.get('gid', 0)} -m {meta.get('mode', 0o644):o} {sh(str(backup_dir / 'runtime' / relative))} {sh(str(target))}")
        lines.append(f"sha256sum {sh(str(target))}   # want {evidence['before']}")
    record = facts.data_dir / BUILD_RECORD
    if build_record_before is not None and build_record_before.get("sha256"):
        lines.append(f"install -o {facts.user} -g {facts.group} -m 600 {sh(str(backup_dir / 'build-record-before.json'))} {sh(str(record))}")
        lines.append(f"sha256sum {sh(str(record))}   # want {build_record_before['sha256']}")
    else:
        lines.append(f"mv -n {sh(str(record))} {sh(str(backup_dir / 'rolled-back-build-record.json'))}   # no build record existed before; move aside")
    lines += [f"systemctl start {facts.unit}",
              f"curl -sS --noproxy '*' --max-time 10 http://127.0.0.1:{facts.port}/api/health   # want \"version\":\"{manifest['baselineVersion']}\"",
              f"systemctl show {facts.unit} --property=MainPID,InvocationID,NRestarts,ActiveState",
              f"# data/ is restored ONLY if it was damaged, from {backup_dir / 'data-*.tar.gz'} (tar -tzf first; extract into a scratch dir; compare before copying)."]
    return lines


def sh(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


# ── the build record (the one write under data/) ─────────────────────────────
def read_build_record(data_dir: Path) -> Optional[Dict[str, Any]]:
    path = data_dir / BUILD_RECORD
    if lstat_or_none(path) is None:
        return None
    data = read_regular(path)
    try:
        value = json.loads(data)
    except ValueError:
        value = None
    return {"sha256": sha256_bytes(data), "value": value if isinstance(value, dict) else None, "facts": file_facts(path)}


def write_build_record(host: Host, facts: ServiceFacts, manifest: Dict[str, Any], backup_dir: Path,
                       before: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Write data/hub-build.v1.json the way install-hub.sh + bin/buildinfo.ts do, service-owned, 0600, atomic."""
    if before is not None:
        write_exclusive(backup_dir / "build-record-before.json", read_regular(facts.data_dir / BUILD_RECORD))
    record = {"schemaVersion": 1, "packageVersion": manifest["expectedVersion"], "commit": manifest["sourceCommit"],
              "branch": manifest.get("sourceBranch"), "builtAtMs": int(time.time() * 1000)}
    data = pretty_json(record)
    target = facts.data_dir / BUILD_RECORD
    fd, temp = exclusive_temp(facts.data_dir, "hub-build")
    try:
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(data)
            out.flush()
            os.fsync(fd)
            os.fchown(fd, facts.uid, facts.gid)
            os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
    os.replace(temp, target)
    sync_dir(facts.data_dir)
    after = read_build_record(facts.data_dir)
    require(after is not None and after["sha256"] == sha256_bytes(data) and after["facts"]["uid"] == facts.uid
            and after["facts"]["gid"] == facts.gid and after["facts"]["mode"] == 0o600, "build record did not land as written")
    return {"before": None if before is None else {"sha256": before["sha256"], "value": before["value"]},
            "after": {"sha256": after["sha256"], "value": record}, "path": str(target)}


# ── replacement ──────────────────────────────────────────────────────────────
def install_file(host: Host, source: Path, target: Path, meta: Dict[str, Any], expected_sha: str) -> None:
    data = read_regular(source)
    require(sha256_bytes(data) == expected_sha, f"verified artifact changed before install: {source}")
    fd, temp = exclusive_temp(target.parent, "deploy-0491", mode=0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(data)
            out.flush()
            os.fsync(fd)
            os.fchown(fd, meta["uid"], meta["gid"])
            os.fchmod(fd, meta["mode"])
    finally:
        os.close(fd)
    os.replace(temp, target)
    sync_dir(target.parent)
    s = target.lstat()
    require(stat.S_ISREG(s.st_mode) and sha256_file(target) == expected_sha and stat.S_IMODE(s.st_mode) == meta["mode"]
            and s.st_uid == meta["uid"] and s.st_gid == meta["gid"], f"installed file does not verify: {target}")


def retire_file(target: Path, expected_sha: str, aside_dir: Path, relative: str, trusted_uid: int) -> Path:
    """A manifest removal: the live file is MOVED aside into the stage (never deleted)."""
    require(sha256_file(target) == expected_sha, f"removal target changed before retirement: {target}")
    current = aside_dir
    for part in Path(relative).parts[:-1]:
        current = current / part
        mkdir_private(current, trusted_uid)
    destination = aside_dir / relative
    require(lstat_or_none(destination) is None, f"retirement destination already exists: {destination}")
    try:
        os.rename(target, destination)
    except OSError as err:
        if getattr(err, "errno", None) != 18:  # EXDEV: stage on another filesystem — copy, verify, then unlink the original
            raise
        write_exclusive(destination, read_regular(target))
        require(sha256_file(destination) == expected_sha, f"retirement copy does not verify: {destination}")
        os.unlink(target)
    sync_dir(target.parent)
    sync_dir(destination.parent)
    return destination


# ── mode: baseline (on the box, read-only) ───────────────────────────────────
def run_baseline(host: Host, args: argparse.Namespace) -> int:
    scrub_proxy_env()
    require(host.euid() == host.trusted_uid(), "baseline must run as root on the Hub host")
    facts = ServiceFacts(host, args.service)
    rt = facts.runtime(host)
    body = fetch_health(facts.port)
    require(body.get("ok") is True and isinstance(body.get("version"), str), "live health did not answer ok/version")
    build = body.get("build") if isinstance(body.get("build"), dict) else {}
    include = list(args.include or DEFAULT_PACKAGE_INCLUDE)
    hashes = runtime_tree_hashes(facts.install_dir, include)
    baseline = {"schema": BASELINE_SCHEMA, "capturedAt": now_iso(), "operator": OPERATOR_VERSION,
                "service": facts.summary(), "runtime": rt, "version": body.get("version"),
                "commit": build.get("commit") if isinstance(build.get("commit"), str) else None,
                "healthBuild": build, "include": include, "files": hashes, "treeSha256": tree_digest(hashes),
                "protectedServices": protected_service_facts(host, args.protected_service or list(DEFAULT_PROTECTED_SERVICES)),
                "buildRecord": (read_build_record(facts.data_dir) or {}).get("value")}
    out = Path(args.out)
    sha = write_exclusive(out, pretty_json(baseline))
    print(json.dumps({"ok": True, "baseline": str(out), "sha256": sha, "version": baseline["version"],
                      "commit": baseline["commit"], "files": len(hashes), "treeSha256": baseline["treeSha256"]}))
    return 0


# ── mode: package (off the box) ──────────────────────────────────────────────
def run_package(host: Host, args: argparse.Namespace) -> int:
    build_dir = Path(args.build_dir).resolve()
    require(build_dir.is_dir(), f"build dir is not a directory: {build_dir}")
    include = list(args.include or DEFAULT_PACKAGE_INCLUDE)
    for item in include:
        require(item in PACKAGE_ROOTS or item in PACKAGE_TOP_FILES, f"--include names an unsupported root: {item}")
    version = args.version
    require(VERSION_RE.fullmatch(version) is not None, f"--version is not a version: {version!r}")
    pkg = json.loads(read_regular(build_dir / "package.json"))
    require(pkg.get("version") == version, f"build dir package.json version {pkg.get('version')!r} is not {version!r}")
    version_js = read_regular(build_dir / "dist/src/version.js").decode("utf-8", "replace")
    require(f'HUB_VERSION = "{version}"' in version_js, "dist/src/version.js does not carry the packaged version; rebuild first")
    require((build_dir / "dist/src/main.js").is_file(), "dist/src/main.js is missing from the build dir")
    commit = args.commit
    require(isinstance(commit, str) and COMMIT_RE.fullmatch(commit) is not None, "--commit must be a 40-hex commit")
    source_tree = None
    branch = args.branch
    if (build_dir / ".git").exists() and not args.skip_git:
        head = host.run(["git", "-C", str(build_dir), "rev-parse", "HEAD"], timeout=20)
        require(head.returncode == 0 and head.stdout.decode().strip() == commit,
                f"build dir HEAD {head.stdout.decode().strip()[:40]!r} is not --commit {commit}")
        dirty = host.run(["git", "-C", str(build_dir), "status", "--porcelain", "--untracked-files=no"], timeout=20)
        require(dirty.returncode == 0 and not dirty.stdout.strip(), "build dir has uncommitted tracked changes; package from a clean checkout of the qualified commit")
        tree = host.run(["git", "-C", str(build_dir), "rev-parse", "HEAD^{tree}"], timeout=20)
        require(tree.returncode == 0 and COMMIT_RE.fullmatch(tree.stdout.decode().strip()), "could not read the source tree id")
        source_tree = tree.stdout.decode().strip()
        if branch is None:
            b = host.run(["git", "-C", str(build_dir), "branch", "--show-current"], timeout=20)
            branch = b.stdout.decode().strip() or None
    baseline_path = Path(args.baseline)
    baseline_bytes = read_regular(baseline_path)
    baseline = json.loads(baseline_bytes)
    require(isinstance(baseline, dict) and baseline.get("schema") == BASELINE_SCHEMA, "baseline is not a deploy baseline")
    baseline_version = args.baseline_version or baseline.get("version")
    require(isinstance(baseline_version, str) and VERSION_RE.fullmatch(baseline_version) is not None, "baseline version unknown; pass --baseline-version")
    require(baseline.get("version") == baseline_version, f"baseline.json records version {baseline.get('version')!r}, not {baseline_version!r}")
    require(sorted(baseline.get("include", [])) == sorted(include), f"baseline was captured with include={baseline.get('include')}; pass the same --include set")
    base_files = baseline.get("files")
    require(isinstance(base_files, dict), "baseline has no file hashes")
    build_hashes = runtime_tree_hashes(build_dir, include)
    files: Dict[str, Dict[str, Any]] = {}
    for relative, after in sorted(build_hashes.items()):
        before = base_files.get(relative)
        if before == after:
            continue
        mode = stat.S_IMODE((build_dir / relative).lstat().st_mode)
        files[relative] = {"before": before, "after": after, "mode": 0o755 if mode & 0o111 else 0o644}
    removals = {relative: {"before": sha} for relative, sha in sorted(base_files.items()) if relative not in build_hashes}
    require(files or removals, "the build tree is identical to the baseline; nothing to package")
    qualification_src = Path(args.qualification)
    qualification = read_regular(qualification_src)
    qual_value = json.loads(qualification)
    require(isinstance(qual_value, dict), "qualification evidence must be a JSON object")
    stage = Path(args.out)
    require(lstat_or_none(stage) is None, f"stage already exists: {stage}")
    os.mkdir(stage, 0o700)
    files_dir = stage / "files"
    os.mkdir(files_dir, 0o700)
    for relative in files:
        current = files_dir
        for part in Path(relative).parts[:-1]:
            current = current / part
            if lstat_or_none(current) is None:
                os.mkdir(current, 0o700)
        write_exclusive(files_dir / relative, read_regular(build_dir / relative), mode=0o600)
    write_exclusive(stage / "qualification.json", qualification, mode=0o600)
    write_exclusive(stage / "baseline.json", baseline_bytes, mode=0o600)
    source_name = None
    source_sha = None
    if args.source_tarball:
        source_name = "source.tar.gz"
        source_sha = write_exclusive(stage / source_name, read_regular(Path(args.source_tarball)), mode=0o600)
    manifest = {"schema": MANIFEST_SCHEMA, "operator": OPERATOR_VERSION, "change": args.change or f"Hub {version} runtime update",
                "expectedVersion": version, "baselineVersion": baseline_version, "sourceCommit": commit, "sourceTree": source_tree,
                "sourceBranch": branch, "sourceTarball": source_name, "sourceTarballSha256": source_sha,
                "qualification": "qualification.json", "qualificationSha256": sha256_bytes(qualification),
                "baselineSha256": sha256_bytes(baseline_bytes), "baselineCapturedAt": baseline.get("capturedAt"),
                "include": include, "files": files, "removals": removals, "runtimeBundleSha256": runtime_bundle_digest(files),
                "buildTreeSha256": tree_digest(build_hashes), "fullTree": True, "packagedAt": now_iso()}
    validate_manifest(manifest)
    manifest_sha = write_exclusive(stage / "manifest.json", pretty_json(manifest), mode=0o600)
    print(json.dumps({"ok": True, "stage": str(stage), "manifestSha256": manifest_sha, "files": len(files), "removals": len(removals),
                      "expectedVersion": version, "baselineVersion": baseline_version, "sourceCommit": commit, "sourceTree": source_tree,
                      "runtimeBundleSha256": manifest["runtimeBundleSha256"], "buildTreeSha256": manifest["buildTreeSha256"],
                      "note": "copy the whole stage to the box as root (rsync -a --chown=root:root), chmod 700 it there, then run preflight"}))
    return 0


# ── mode: preflight (on the box, read-only) ──────────────────────────────────
def preflight(host: Host, args: argparse.Namespace) -> Tuple[Checklist, Dict[str, Any]]:
    cl = Checklist(f"preflight {args.stage}")
    ctx: Dict[str, Any] = {}
    removed = scrub_proxy_env()
    cl.add("operator.proxy-env", "pass", f"proxy variables scrubbed from this process: {removed or 'none were set'}")
    if host.euid() == host.trusted_uid():
        cl.add("operator.euid", "pass", f"running as uid {host.euid()}")
    else:
        cl.add("operator.euid", "fail", f"running as uid {host.euid()}, need {host.trusted_uid()}")
        return cl, ctx
    try:
        info = load_stage(host, Path(args.stage))
        ctx["info"] = info
        m = info["manifest"]
        cl.add("stage.directory", "pass", f"{info['stage']} is root-owned 0700 on a persistent filesystem, {info['entries']} entries, no symlinks")
        cl.add("manifest.valid", "pass", f"{m['change']}: {m['baselineVersion']} -> {m['expectedVersion']} at {m['sourceCommit']}, "
                                        f"{len(m['files'])} file(s), {len(m.get('removals', {}))} removal(s), manifest sha256 {info['manifestSha256'][:16]}…")
        removals = sorted(m.get("removals", {}))
        cl.add("manifest.removals", "pass", "no live file is retired" if not removals
               else f"{len(removals)} live file(s) the qualified build no longer carries will be MOVED ASIDE into the stage (never deleted): {removals[:12]}")
        cl.add("qualification.hash", "pass", f"qualification evidence sha256 {info['qualificationSha256'][:16]}… matches the manifest")
        cl.add("baseline.hash", "pass", f"baseline.json sha256 {m['baselineSha256'][:16]}… matches the manifest (captured {m.get('baselineCapturedAt')})")
        if info["sourceTarballSha256"]:
            cl.add("source.tarball", "pass", f"source tarball sha256 {info['sourceTarballSha256'][:16]}… matches the manifest")
        else:
            cl.add("source.tarball", "unknown", "no source tarball shipped in the stage; the receipt will record the commit and tree id only")
        cl.add("artifacts.hash", "pass", f"all {len(info['artifacts'])} staged artifacts match their after hashes; bundle digest {m['runtimeBundleSha256'][:16]}…")
    except (DeployError, OSError, ValueError) as err:
        cl.add("stage.load", "fail", f"{type(err).__name__}: {err}")
        return cl, ctx
    markers = stage_markers(info["stage"])
    if markers:
        cl.add("stage.markers", "fail", f"stage already carries {markers}; a stage is used once — investigate, never re-run it")
    else:
        cl.add("stage.markers", "pass", "no in-progress marker, receipt or failure evidence in the stage")
    try:
        facts = ServiceFacts(host, args.service)
        ctx["facts"] = facts
        cl.add("service.binding", "pass", f"{facts.unit}: unit {facts.fragment_path} (sha256 {facts.fragment_facts['sha256'][:12]}…), "
                                         f"user {facts.user}:{facts.group}, install {facts.install_dir}, env {facts.env_file}, port {facts.port}, "
                                         f"data {facts.data_dir}, releases {facts.releases_dir}, node {facts.node}, drop-ins {facts.drop_ins or 'none'}")
    except DeployError as err:
        cl.add("service.binding", "fail", str(err))
        return cl, ctx
    node = Path(facts.node)
    cl.add("service.node", "pass" if node.is_file() and os.access(node, os.X_OK) else "fail", f"ExecStart interpreter {facts.node}")
    try:
        original = capture_original(host, facts)
        ctx["original"] = original
        cl.add("service.running", "pass", f"MainPID {original['pid']} invocation {original['invocationId']} cgroup {original['cgroup']} "
                                         f"start-time {original['startTime']} NRestarts {original['nRestarts']}")
    except DeployError as err:
        cl.add("service.running", "fail", str(err))
    b = info["baseline"]
    bsvc = b.get("service", {}) if isinstance(b.get("service"), dict) else {}
    agree = [k for k in ("unit", "installDir", "envFile", "port", "dataDir", "releasesDir") if bsvc.get(k) != facts.summary().get(k)]
    cl.add("baseline.service", "pass" if not agree else "fail",
           "baseline.json service facts agree with the live binding" if not agree else f"baseline.json disagrees with the live binding on {agree}")
    cl.add("baseline.version", "pass" if b.get("version") == m["baselineVersion"] else "fail",
           f"baseline.json recorded version {b.get('version')!r}; manifest expects baseline {m['baselineVersion']!r}")
    try:
        body = fetch_health(facts.port)
        ctx["healthBefore"] = body
        verdict = judge_health_body(body, m["baselineVersion"], b.get("commit"))
        cl.add("live.health", "pass" if verdict is None else "fail",
               f"live health version {body.get('version')!r} commit {(body.get('build') or {}).get('commit')!r}" + ("" if verdict is None else f" — {verdict}"))
    except (DeployError, OSError, http.client.HTTPException) as err:
        cl.add("live.health", "fail", f"live health unreadable: {err}")
    if "original" in ctx:
        try:
            listener = prove_listener(host, facts.port, ctx["original"]["pid"])
            cl.add("live.listener", "pass", f"port {facts.port} listener(s) owned by MainPID {ctx['original']['pid']}; all loopback: {listener['allLoopback']}")
        except DeployError as err:
            cl.add("live.listener", "fail", str(err))
    metadata, problems = compare_live_baseline(host, facts, m)
    ctx["metadata"] = metadata
    cl.add("live.files", "pass" if not problems else "fail",
           f"every manifest before-hash matches the live tree ({len(metadata)} entries)" if not problems else "; ".join(problems[:6]))
    units = args.protected_service or list(DEFAULT_PROTECTED_SERVICES)
    services = protected_service_facts(host, units)
    ctx["servicesBefore"] = services
    for unit, row in services.items():
        if row["presence"] == "absent":
            cl.add(f"protected.service.{unit}", "pass" if not args.require_service or unit not in args.require_service else "fail",
                   "absent on this box (unit not loaded)")
        else:
            cl.add(f"protected.service.{unit}", "pass" if row["ActiveState"] == "active" else "fail",
                   f"{row['ActiveState']}/{row['SubState']} MainPID {row['MainPID']} invocation {row['InvocationID'][:8]}… NRestarts {row['NRestarts']}")
    try:
        fps = protected_fingerprints(facts, m, Path(args.alpha_dir))
        ctx["protectedBefore"] = fps
        cl.add("protected.paths", "pass", f"{sum(1 for v in fps.values() if v)} protected paths fingerprinted, {sum(1 for v in fps.values() if v is None)} absent "
                                         f"(Alpha {args.alpha_dir}, Hub code roots, release shelf {facts.releases_dir}, identity/env/unit files)")
    except DeployError as err:
        cl.add("protected.paths", "fail", str(err))
    try:
        data_listing = tree_listing(facts.data_dir, with_hash=False)
        ctx["dataListingPre"] = data_listing
        data_bytes = sum(r["size"] for r in data_listing.values() if r["type"] == "regular")
        lic = count_registry(read_regular(facts.data_dir / LICENSES_FILE) if lstat_or_none(facts.data_dir / LICENSES_FILE) else None)
        rev = count_registry(read_regular(facts.data_dir / REVOKED_FILE) if lstat_or_none(facts.data_dir / REVOKED_FILE) else None)
        ctx["licenceCountsBefore"] = {"licenses": lic, "revoked": rev}
        cl.add("data.readable", "pass" if lic is not None else "fail",
               f"{len(data_listing)} entries, {data_bytes} bytes under {facts.data_dir}; licences {lic}, revoked {rev}")
        record = read_build_record(facts.data_dir)
        ctx["buildRecordBefore"] = record
        cl.add("data.build-record", "pass", f"{BUILD_RECORD}: " + (f"{record['value']}" if record and record['value'] else "absent or unreadable (health then reports commit null)"))
        excluded = list(args.data_backup_exclude or [])
        need = int(data_bytes * 1.1) + sum((facts.install_dir / r).lstat().st_size for r in m["files"] if m["files"][r]["before"]) + 64 * 1024 * 1024
        free = host.disk_free(info["stage"])
        cl.add("stage.free-space", "pass" if free >= need else "fail", f"{free} bytes free on the stage filesystem, {need} needed for the backups"
                                                                         + (f" (data backup excludes {excluded})" if excluded else ""))
    except DeployError as err:
        cl.add("data.readable", "fail", str(err))
    return cl, ctx


def run_preflight(host: Host, args: argparse.Namespace) -> int:
    cl, _ = preflight(host, args)
    print(cl.render())
    if cl.passed():
        print("PREFLIGHT PASS — nothing was changed.")
        return 0
    print("PREFLIGHT NOT PASSED — nothing was changed; do not deploy until every check passes.")
    return 3 if all(c.status != "fail" for c in cl.checks) else 2


# ── mode: deploy (the one mutation; no retry, no rollback) ───────────────────
DATA_PROOF_KEYS = ("type", "size", "mode", "uid", "gid", "ino", "mtimeNs")


def run_deploy(host: Host, args: argparse.Namespace) -> int:
    cl, ctx = preflight(host, args)
    print(cl.render())
    if not cl.passed():
        print("DEPLOY REFUSED — preflight did not pass; nothing was changed.")
        return 2
    info, facts, m = ctx["info"], ctx["facts"], ctx["info"]["manifest"]
    if args.confirm_version != m["expectedVersion"]:
        print(f"DEPLOY REFUSED — --confirm-version {args.confirm_version!r} is not the manifest's expectedVersion {m['expectedVersion']!r}; nothing was changed.")
        return 2
    stage = info["stage"]
    started = now_iso()
    marker = stage / MARKER_IN_PROGRESS
    write_exclusive(marker, pretty_json({"schema": "wickhunter-hub.deploy-marker.v1", "startedAt": started, "operatorPid": os.getpid(),
                                         "manifestSha256": info["manifestSha256"], "expectedVersion": m["expectedVersion"],
                                         "sourceCommit": m["sourceCommit"], "service": facts.unit}))
    backup_dir = stage / "backup"
    mkdir_private(backup_dir, host.trusted_uid())
    evidence: Dict[str, Any] = {
        "schema": RECEIPT_SCHEMA, "operator": OPERATOR_VERSION, "change": m["change"], "startedAt": started,
        "service": facts.summary(), "preflight": cl.rows(),
        "manifest": {"sha256": info["manifestSha256"], "expectedVersion": m["expectedVersion"], "baselineVersion": m["baselineVersion"],
                     "sourceCommit": m["sourceCommit"], "sourceTree": m.get("sourceTree"), "sourceBranch": m.get("sourceBranch"),
                     "sourceTarballSha256": info["sourceTarballSha256"], "qualificationSha256": info["qualificationSha256"],
                     "baselineSha256": m["baselineSha256"], "runtimeBundleSha256": m["runtimeBundleSha256"],
                     "buildTreeSha256": m["buildTreeSha256"], "fullTree": m["fullTree"], "include": m["include"],
                     "files": m["files"], "removals": m.get("removals", {})},
        "original": ctx["original"], "healthBefore": {"version": ctx["healthBefore"].get("version"), "build": ctx["healthBefore"].get("build")},
        "protectedServicesBefore": ctx["servicesBefore"], "protectedFingerprintsBefore": ctx["protectedBefore"],
        "licenceCountsBefore": ctx["licenceCountsBefore"], "dataWrites": [BUILD_RECORD], "replaced": [], "retired": [], "phases": {},
    }
    phase = "capture"
    recovery_path: Optional[Path] = None
    try:
        evidence["phases"]["capture"] = now_iso()
        phase = "runtime-backup"
        runtime_backup = backup_runtime_files(host, facts, m, ctx["metadata"], backup_dir)
        evidence["runtimeBackup"] = runtime_backup
        evidence["phases"]["runtime-backup"] = now_iso()
        phase = "stop"
        stop_proof = stop_and_prove(host, facts, ctx["original"])
        evidence["stopProof"] = stop_proof
        evidence["phases"]["stop"] = now_iso()
        phase = "data-backup"
        data_backup = backup_data_dir(host, facts.data_dir, backup_dir, args.data_backup_exclude or ())
        post_stop_listing = data_backup.pop("entries")
        evidence["dataBackup"] = data_backup
        build_before = read_build_record(facts.data_dir)
        evidence["dataListingAfterStop"] = {"entries": len(post_stop_listing), "sha256": sha256_json(post_stop_listing)}
        recovery_path = write_recovery(backup_dir, facts, m, ctx["metadata"], data_backup, runtime_backup, build_before)
        evidence["recovery"] = str(recovery_path)
        evidence["phases"]["data-backup"] = now_iso()
        metadata_now, problems = compare_live_baseline(host, facts, m)
        require(not problems and metadata_now == ctx["metadata"], f"live runtime changed between preflight and install: {problems or 'metadata moved'}")
        phase = "install"
        for relative in sorted(m["files"]):
            install_file(host, info["artifacts"][relative], safe_target(host, facts.install_dir, relative), ctx["metadata"][relative], m["files"][relative]["after"])
            evidence["replaced"].append(relative)
        aside = backup_dir / "retired"
        if m.get("removals"):
            mkdir_private(aside, host.trusted_uid())
        for relative in sorted(m.get("removals", {})):
            moved = retire_file(safe_target(host, facts.install_dir, relative), m["removals"][relative]["before"], aside, relative, host.trusted_uid())
            evidence["retired"].append({"path": relative, "movedTo": str(moved)})
        installed = {relative: {"after": sha256_file(facts.install_dir / relative)} for relative in m["files"]}
        installed_digest = runtime_bundle_digest(installed)
        require(installed_digest == m["runtimeBundleSha256"], "installed runtime bundle digest differs from the manifest")
        tree_now = runtime_tree_hashes(facts.install_dir, m["include"])
        tree_now_digest = tree_digest(tree_now)
        if m["fullTree"]:
            require(tree_now_digest == m["buildTreeSha256"], f"installed runtime tree digest {tree_now_digest[:16]}… differs from the packaged build tree {m['buildTreeSha256'][:16]}…")
        evidence["installedRuntimeSha256"] = installed_digest
        evidence["installedTreeSha256"] = tree_now_digest
        evidence["installedTreeFiles"] = len(tree_now)
        evidence["phases"]["install"] = now_iso()
        phase = "build-record"
        evidence["buildRecord"] = write_build_record(host, facts, m, backup_dir, build_before)
        evidence["phases"]["build-record"] = now_iso()
        phase = "data-proof"
        pre_start_listing = tree_listing(facts.data_dir, with_hash=False)
        changed = listing_diff(post_stop_listing, pre_start_listing, DATA_PROOF_KEYS)
        require(changed == [BUILD_RECORD], f"data/ changed beyond the build record while the Hub was stopped: {changed}")
        evidence["dataUntouchedExceptBuildRecord"] = True
        evidence["phases"]["data-proof"] = now_iso()
        phase = "start"
        p = host.systemctl("start", facts.unit, timeout=120)
        require(p.returncode == 0, f"systemctl start {facts.unit} exited {p.returncode}: {p.stderr.decode('utf-8', 'replace').strip()[:300]}")
        ready = await_ready(host, facts, m["expectedVersion"], m["sourceCommit"], ctx["original"]["pid"], ctx["original"]["invocationId"])
        evidence["new"] = ready
        evidence["phases"]["start"] = now_iso()
        phase = "post-verify"
        after_fps = protected_fingerprints(facts, m, Path(args.alpha_dir))
        drift = sorted(k for k in set(after_fps) | set(ctx["protectedBefore"]) if after_fps.get(k) != ctx["protectedBefore"].get(k))
        require(not drift, f"protected paths changed during the deployment: {drift}")
        evidence["protectedFingerprintsAfter"] = after_fps
        services_after = protected_service_facts(host, args.protected_service or list(DEFAULT_PROTECTED_SERVICES))
        moved = [u for u, row in services_after.items() if any(row[k] != ctx["servicesBefore"][u][k] for k in ("presence", "ActiveState", "MainPID", "InvocationID"))]
        require(not moved, f"protected services changed during the deployment: {moved}")
        evidence["protectedServicesAfter"] = services_after
        lic = count_registry(read_regular(facts.data_dir / LICENSES_FILE) if lstat_or_none(facts.data_dir / LICENSES_FILE) else None)
        rev = count_registry(read_regular(facts.data_dir / REVOKED_FILE) if lstat_or_none(facts.data_dir / REVOKED_FILE) else None)
        evidence["licenceCountsAfter"] = {"licenses": lic, "revoked": rev}
        require(evidence["licenceCountsAfter"] == ctx["licenceCountsBefore"], f"licence registry counts moved: {ctx['licenceCountsBefore']} -> {evidence['licenceCountsAfter']}")
        for relative in m["files"]:
            require(sha256_file(facts.install_dir / relative) == m["files"][relative]["after"], f"installed file changed after start: {relative}")
        evidence["dataListingAfterStart"] = {"entries": len(tree_listing(facts.data_dir, with_hash=False))}
        evidence["verifiedAt"] = now_iso()
        evidence["phases"]["post-verify"] = evidence["verifiedAt"]
        evidence["result"] = "deployed-and-verified"
        receipt_sha = write_exclusive(stage / RECEIPT_FILE, pretty_json(evidence))
        finished = stage / f"deploy-finished-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json"
        os.rename(marker, finished)
        sync_dir(stage)
        print(json.dumps({"ok": True, "result": evidence["result"], "receipt": str(stage / RECEIPT_FILE), "receiptSha256": receipt_sha,
                          "version": m["expectedVersion"], "commit": m["sourceCommit"], "oldPid": ctx["original"]["pid"],
                          "oldInvocation": ctx["original"]["invocationId"], "newPid": ready["pid"], "newInvocation": ready["invocationId"],
                          "dataBackup": data_backup["archive"], "recovery": str(recovery_path)}))
        return 0
    except Exception as err:  # noqa: BLE001 — ANY failure mid-deploy must leave evidence and the recipe, never a bare traceback
        failure = {"schema": "wickhunter-hub.deploy-failure.v1", "failedAt": now_iso(), "phase": phase, "error": f"{type(err).__name__}: {err}",
                   "replaced": evidence["replaced"], "retired": evidence["retired"], "evidence": evidence,
                   "serviceStateNow": _safe_runtime(host, facts), "recovery": str(recovery_path) if recovery_path else None,
                   "automaticRollback": False, "automaticRetry": False}
        name = stage / f"{FAILURE_PREFIX}{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{secrets.token_hex(3)}.json"
        try:
            write_exclusive(name, pretty_json(failure))
            where = str(name)
        except DeployError as write_err:
            where = f"(could not write failure evidence: {write_err})"
        print(f"DEPLOY FAILED in phase {phase!r}: {failure['error']}", file=sys.stderr)
        print(f"Failure evidence: {where}", file=sys.stderr)
        print(f"Files replaced before the failure: {evidence['replaced'] or 'none'}; retired: {[r['path'] for r in evidence['retired']] or 'none'}", file=sys.stderr)
        print("No rollback and no retry were attempted. The in-progress marker stays in the stage on purpose.", file=sys.stderr)
        if recovery_path is not None:
            print("Manual rollback recipe (also in recovery.json -> manualRollback):", file=sys.stderr)
            for line in json.loads(read_regular(recovery_path))["manualRollback"]:
                print("  " + line, file=sys.stderr)
        else:
            print(f"Nothing under {facts.install_dir} was replaced. If the service is stopped, the old runtime is intact: "
                  f"inspect, then `systemctl start {facts.unit}` by hand and check /api/health reports {m['baselineVersion']}.", file=sys.stderr)
        return 2


def _safe_runtime(host: Host, facts: ServiceFacts) -> Dict[str, str]:
    try:
        return facts.runtime(host)
    except (DeployError, subprocess.SubprocessError, OSError) as err:
        return {"error": str(err)}


# ── mode: verify (on the box, read-only, after a deploy) ─────────────────────
def run_verify(host: Host, args: argparse.Namespace) -> int:
    scrub_proxy_env()
    cl = Checklist(f"verify {args.stage}")
    if host.euid() != host.trusted_uid():
        cl.add("operator.euid", "fail", f"running as uid {host.euid()}, need {host.trusted_uid()}")
        print(cl.render())
        return 2
    try:
        stage = check_stage_dir(host, Path(args.stage))
        receipt = json.loads(read_regular(stage_file(stage, RECEIPT_FILE)))
        require(isinstance(receipt, dict) and receipt.get("schema") == RECEIPT_SCHEMA, "receipt.json has the wrong schema")
        cl.add("receipt.present", "pass", f"{receipt['change']}: {receipt['manifest']['baselineVersion']} -> {receipt['manifest']['expectedVersion']} at {receipt['manifest']['sourceCommit']}, verified {receipt.get('verifiedAt')}")
    except (DeployError, ValueError, KeyError) as err:
        cl.add("receipt.present", "fail", str(err))
        print(cl.render())
        return 2
    m = receipt["manifest"]
    try:
        facts = ServiceFacts(host, args.service)
        cl.add("service.binding", "pass", f"{facts.unit} bound fresh: install {facts.install_dir}, port {facts.port}, data {facts.data_dir}")
    except DeployError as err:
        cl.add("service.binding", "fail", str(err))
        print(cl.render())
        return 2
    rt = facts.runtime(host)
    new = receipt.get("new", {})
    cl.add("service.identity", "pass" if rt["MainPID"] == str(new.get("pid")) and rt["InvocationID"] == new.get("invocationId") and rt["ActiveState"] == "active" else "fail",
           f"MainPID {rt['MainPID']} invocation {rt['InvocationID']} NRestarts {rt['NRestarts']} (receipt: {new.get('pid')} / {new.get('invocationId')})")
    try:
        body = fetch_health(facts.port)
        verdict = judge_health_body(body, m["expectedVersion"], m["sourceCommit"])
        cl.add("health.identity", "pass" if verdict is None else "fail", f"version {body.get('version')!r} commit {(body.get('build') or {}).get('commit')!r}" + ("" if verdict is None else f" — {verdict}"))
        listener = prove_listener(host, facts.port, int(rt["MainPID"] or 0))
        cl.add("health.listener", "pass", f"port {facts.port} owned by MainPID {rt['MainPID']}; loopback only: {listener['allLoopback']}")
    except (DeployError, OSError, http.client.HTTPException) as err:
        cl.add("health.identity", "fail", str(err))
    bad = [r for r, e in m["files"].items() if lstat_or_none(facts.install_dir / r) is None or sha256_file(facts.install_dir / r) != e["after"]]
    bad += [r for r in m.get("removals", {}) if lstat_or_none(facts.install_dir / r) is not None]
    cl.add("runtime.files", "pass" if not bad else "fail", f"{len(m['files'])} installed file(s) match their after hashes; {len(m.get('removals', {}))} removal(s) absent" if not bad else f"mismatch: {bad[:6]}")
    try:
        tree_now = tree_digest(runtime_tree_hashes(facts.install_dir, m["include"]))
        cl.add("runtime.tree", "pass" if tree_now == receipt.get("installedTreeSha256") else "fail", f"runtime tree digest {tree_now[:16]}… (receipt {str(receipt.get('installedTreeSha256'))[:16]}…)")
    except DeployError as err:
        cl.add("runtime.tree", "fail", str(err))
    fps = protected_fingerprints(facts, m, Path(args.alpha_dir))
    drift = sorted(k for k in set(fps) | set(receipt.get("protectedFingerprintsAfter", {})) if fps.get(k) != receipt.get("protectedFingerprintsAfter", {}).get(k))
    cl.add("protected.paths", "pass" if not drift else "fail", "protected paths match the receipt" if not drift else f"drift since the receipt: {drift[:6]}")
    services = protected_service_facts(host, args.protected_service or list(DEFAULT_PROTECTED_SERVICES))
    before = receipt.get("protectedServicesAfter", {})
    for unit, row in services.items():
        ref = before.get(unit, {})
        same = all(row.get(k) == ref.get(k) for k in ("presence", "ActiveState", "MainPID", "InvocationID"))
        cl.add(f"protected.service.{unit}", "pass" if same else "fail", f"{row['presence']} {row['ActiveState']} MainPID {row['MainPID']} (receipt {ref.get('MainPID')})" if ref else "not in receipt")
    lic = count_registry(read_regular(facts.data_dir / LICENSES_FILE) if lstat_or_none(facts.data_dir / LICENSES_FILE) else None)
    rev = count_registry(read_regular(facts.data_dir / REVOKED_FILE) if lstat_or_none(facts.data_dir / REVOKED_FILE) else None)
    want = receipt.get("licenceCountsAfter", {})
    cl.add("data.licences", "pass" if {"licenses": lic, "revoked": rev} == want else "fail", f"licences {lic}, revoked {rev} (receipt {want})")
    record = read_build_record(facts.data_dir)
    cl.add("data.build-record", "pass" if record and record["sha256"] == receipt.get("buildRecord", {}).get("after", {}).get("sha256") else "fail",
           f"{BUILD_RECORD} sha256 {(record or {}).get('sha256', '')[:16]}… value {(record or {}).get('value')}")
    cl.add("data.entries", "pass", f"{len(tree_listing(facts.data_dir, with_hash=False))} entries under {facts.data_dir} now (receipt after start: {receipt.get('dataListingAfterStart', {}).get('entries')})")
    print(cl.render())
    print("VERIFY PASS" if cl.passed() else "VERIFY NOT PASSED")
    return 0 if cl.passed() else 2


def run_print_rollback(host: Host, args: argparse.Namespace) -> int:
    stage = Path(args.stage).resolve()
    recovery = json.loads(read_regular(stage / "backup" / RECOVERY_FILE))
    print("# Nothing below is executed by this script. Read recovery.json first.")
    for line in recovery["manualRollback"]:
        print(line)
    return 0


# ── entry point ──────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deploy-hub-0491.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("--service", default=DEFAULT_SERVICE, help=f"systemd unit (default {DEFAULT_SERVICE})")
    parser.add_argument("--alpha-dir", default=ALPHA_DIR, help=f"protected Alpha tree (default {ALPHA_DIR})")
    parser.add_argument("--protected-service", action="append", help="unit that must be untouched (repeatable; default list in the script)")
    parser.add_argument("--require-service", action="append", help="protected unit that must be PRESENT (repeatable)")
    parser.add_argument("--data-backup-exclude", action="append", help="data/ subpath left out of the backup tarball (repeatable; recorded in the receipt)")
    parser.add_argument("--self-test", action="store_true", help="run scripts/deploy-hub-0491-selftest.py and exit")
    sub = parser.add_subparsers(dest="mode")
    b = sub.add_parser("baseline", help="record the live runtime tree hashes and service facts (read-only)")
    b.add_argument("--out", required=True)
    b.add_argument("--include", action="append")
    p = sub.add_parser("package", help="build a stage directory from a built checkout and a baseline (off-box)")
    p.add_argument("--build-dir", required=True)
    p.add_argument("--baseline", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--commit", required=True)
    p.add_argument("--version", required=True)
    p.add_argument("--baseline-version")
    p.add_argument("--qualification", required=True)
    p.add_argument("--source-tarball")
    p.add_argument("--branch")
    p.add_argument("--change")
    p.add_argument("--include", action="append")
    p.add_argument("--skip-git", action="store_true")
    for name in ("preflight", "deploy", "verify", "print-rollback"):
        s = sub.add_parser(name)
        s.add_argument("--stage", required=True)
        if name == "deploy":
            s.add_argument("--confirm-version", required=True, help="must equal the manifest's expectedVersion")
    sub.add_parser("self-test")
    return parser


def main(argv: Optional[List[str]] = None, host: Optional[Host] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.self_test or args.mode == "self-test":
        sibling = Path(__file__).resolve().with_name("deploy-hub-0491-selftest.py")
        return subprocess.run([sys.executable, "-I", "-B", str(sibling)], check=False).returncode
    host = host or Host()
    runners: Dict[str, Callable[[Host, argparse.Namespace], int]] = {
        "baseline": run_baseline, "package": run_package, "preflight": run_preflight,
        "deploy": run_deploy, "verify": run_verify, "print-rollback": run_print_rollback}
    if args.mode not in runners:
        parser.print_help()
        return 2
    try:
        return runners[args.mode](host, args)
    except (DeployError, OSError, ValueError) as err:
        print(f"REFUSED: {type(err).__name__}: {err}", file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired as err:
        print(f"REFUSED: a bounded subprocess exceeded its timeout: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
