#!/usr/bin/env python3
"""Install a reviewed Hub audit build without touching Alpha, Beta, or Hub data.

Run as root on the Hub host after placing a root-owned 0700 STAGE_DIR on a
persistent filesystem (not tmpfs), containing
manifest.json and each artifact at its Hub-relative path. The manifest has
sourceCommit, expectedVersion (0.4.62), and files mapping relative paths to
{before: sha256 or null for a new file, after: sha256}. Supply a root-owned
0600 license file through HUB_AUDIT_PROBE_LICENSE_FILE. Credentials never go in
arguments, receipts, or logs. A durable code backup remains in STAGE_DIR.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

HUB = Path('/opt/wickhunter-hub')
ALPHA = Path('/opt/liqhunter')
ALPHA_SERVICES = ('liqhunter', 'liqhunter-marketplace-api', 'liqhunter-marketplace-worker')
EXPECTED_VERSION = '0.4.62'
BASELINE_VERSION = '0.4.61'
ALPHA_VERSION = '0.90.145'
SHA_RE = re.compile(r'[0-9a-f]{64}\Z')
JS_RE = re.compile(r'dist/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+(?:[.-][A-Za-z0-9_-]+)*\.js\Z')
PUBLIC_FILES = {'public/admin.html', 'public/earn.html', 'public/support.html'}
PACKAGE_FILES = {'package.json', 'package-lock.json'}
ALPHA_PROTECTED = ('dist', 'src', 'public', 'scripts', 'migrations', 'package.json',
                   'package-lock.json', '.deployed-commit', '.deployed-at', 'bin', 'native', '.native')
HUB_PROTECTED = ('dist', 'src', 'public', 'scripts', 'migrations', 'package.json',
                 'package-lock.json')


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
    except BaseException:
        Path(path).unlink(missing_ok=True)
        raise


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def path_kind(path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def real_directory(path):
    s = path_kind(path)
    require(s is not None and stat.S_ISDIR(s.st_mode), 'Expected a real directory: ' + str(path))


def safe_target(relative):
    require(isinstance(relative, str) and (JS_RE.fullmatch(relative) or relative in PUBLIC_FILES
            or relative in PACKAGE_FILES), 'Unapproved Hub file path')
    target = HUB / relative
    real_directory(HUB)
    current = HUB
    for part in Path(relative).parts[:-1]:
        current = current / part
        real_directory(current)
    return target


def private_stage_file(path):
    s = path.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and not (stat.S_IMODE(s.st_mode) & 0o022),
            'Stage file must be root-owned, regular, and not group/other writable: ' + str(path))
    return s


def stage_file(stage, relative):
    """Reject symlinked or writable ancestors before reading staged code."""
    current = stage
    for part in Path(relative).parts[:-1]:
        current = current / part
        s = current.lstat()
        require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0
                and not (stat.S_IMODE(s.st_mode) & 0o022),
                'Stage path contains an unsafe directory: ' + str(current))
    path = stage / relative
    private_stage_file(path)
    return path


def read_regular(path, require_stage=False):
    if require_stage:
        private_stage_file(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode), 'Refusing a nonregular file: ' + str(path))
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read()
        after = os.fstat(fd)
        named = path.lstat()
        require(stat.S_ISREG(named.st_mode) and before.st_dev == named.st_dev
                and before.st_ino == named.st_ino and before.st_size == after.st_size
                and before.st_mtime_ns == after.st_mtime_ns,
                'File changed while being copied: ' + str(path))
        return data
    finally:
        os.close(fd)


def fingerprint(root, exclude=()):
    """Hash regular file bytes, symlink text, and ownership/modes, including absences."""
    h = hashlib.sha256()
    excluded = set(exclude)

    def walk(path, relative):
        if relative in excluded:
            return
        s = path.lstat()
        h.update(json.dumps([relative, s.st_mode, s.st_uid, s.st_gid]).encode())
        if stat.S_ISLNK(s.st_mode):
            h.update(os.readlink(path).encode())
        elif stat.S_ISREG(s.st_mode):
            h.update(sha(path).encode())
        elif stat.S_ISDIR(s.st_mode):
            for child in sorted(path.iterdir()):
                walk(child, child.relative_to(root).as_posix())
        else:
            raise RuntimeError('Unsupported protected file type: ' + str(path))

    if path_kind(root) is None:
        return None
    walk(root, '.')
    return h.hexdigest()


def protected_fingerprints(files):
    protected = {}
    for relative in ALPHA_PROTECTED:
        path = ALPHA / relative
        protected[str(path)] = fingerprint(path)
    for relative in HUB_PROTECTED:
        path = HUB / relative
        exclusions = [name[len(relative) + 1:] for name in files if name.startswith(relative + '/')]
        if relative in files:
            continue
        protected[str(path)] = fingerprint(path, exclusions)
    protected[str(HUB / 'releases')] = fingerprint(HUB / 'releases')
    return protected


def run(args):
    return subprocess.run(args, check=True, text=True, capture_output=True,
                          timeout=90).stdout.strip()


def pid(service):
    run(['systemctl', 'is-active', '--quiet', service])
    value = int(run(['systemctl', 'show', '-p', 'MainPID', '--value', service]))
    require(value > 0, 'Service has no running PID: ' + service)
    return value


def request(route, destination, token=None, timeout=20):
    config = 'url = "http://127.0.0.1:8091' + route + '"\n'
    if token:
        config += 'header = "x-license: ' + token + '"\n'
    # The private license is sent through stdin, never argv. Do not print curl
    # exceptions or authenticated bodies; response files live in a 0700 dir.
    p = subprocess.run(['curl', '--silent', '--show-error', '--max-time', str(timeout),
                        '--output', str(destination), '--write-out', '%{http_code}',
                        '--config', '-'], input=config, text=True,
                       capture_output=True, timeout=timeout + 5)
    require(p.returncode == 0, 'Hub probe transport failed')
    return int(p.stdout)


def health(scratch):
    path = scratch / 'health.json'
    try:
        require(request('/api/health', path, timeout=15) == 200, 'Hub health HTTP failure')
        value = json.loads(path.read_text())
        require(value.get('ok') is True and isinstance(value.get('version'), str), 'Hub health payload failure')
        return value['version']
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired):
        return None


def wait_ready(scratch, expected_version, old_pid=None):
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        try:
            current = pid('wickhunter-hub')
            if current != old_pid and health(scratch) == expected_version:
                return current
        except (RuntimeError, ValueError, OSError, subprocess.SubprocessError):
            pass
        time.sleep(3)
    raise RuntimeError('Hub did not pass bounded startup readiness')


def replace(source, target, metadata):
    fd, name = tempfile.mkstemp(prefix='.audit-hub-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as out, source.open('rb') as src:
            shutil.copyfileobj(src, out)
            out.flush()
            os.fchmod(out.fileno(), metadata['mode'])
            os.fchown(out.fileno(), metadata['uid'], metadata['gid'])
            os.fsync(out.fileno())
        os.replace(name, target)
        sync_dir(target.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def remove_new(target):
    require(stat.S_ISREG(target.lstat().st_mode), 'New Hub target is not regular: ' + str(target))
    target.unlink()
    sync_dir(target.parent)


def private_copy_tree_entry(directory, relative, data):
    destination = directory / relative
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_private(destination, data)
    return destination


def sync_tree_directories(root):
    for directory, children, _ in os.walk(root, topdown=False):
        sync_dir(directory)


def main():
    require(os.geteuid() == 0, 'Run as root on the Hub host')
    require(len(sys.argv) == 2, 'Usage: deploy-audit-hub.py STAGE_DIR')
    stage_arg = Path(sys.argv[1])
    stage_stat = stage_arg.lstat()
    require(stat.S_ISDIR(stage_stat.st_mode) and stage_stat.st_uid == 0
            and stat.S_IMODE(stage_stat.st_mode) == 0o700,
            'Stage must be a real root-owned 0700 directory')
    stage = stage_arg.resolve()
    manifest = json.loads(read_regular(stage_file(stage, 'manifest.json'), require_stage=True))
    require(isinstance(manifest, dict) and manifest.get('expectedVersion') == EXPECTED_VERSION,
            'Unexpected Hub release version')
    require(re.fullmatch(r'[0-9a-f]{40}', manifest.get('sourceCommit', '')),
            'Missing or invalid source commit')
    files = manifest.get('files')
    require(isinstance(files, dict) and files, 'Manifest has no files')
    require(path_kind(stage / 'receipt.json') is None, 'Stage already has a deployment receipt')
    for relative, evidence in files.items():
        safe_target(relative)
        require(isinstance(evidence, dict) and SHA_RE.fullmatch(evidence.get('after', '')),
                'Invalid after hash for ' + relative)
        require(evidence.get('before') is None or SHA_RE.fullmatch(evidence['before']),
                'Invalid before hash for ' + relative)

    probe = Path(os.environ['HUB_AUDIT_PROBE_LICENSE_FILE'])
    s = probe.lstat()
    require(stat.S_ISREG(s.st_mode) and stat.S_IMODE(s.st_mode) == 0o600
            and s.st_uid == 0, 'Probe credential must be a root-owned 0600 file')
    token = read_regular(probe).decode().strip()
    require(re.fullmatch(r'[A-Za-z0-9._-]+', token), 'Invalid probe credential shape')
    old_pid = pid('wickhunter-hub')
    alpha_pids = {name: pid(name) for name in ALPHA_SERVICES}
    require(json.loads((ALPHA / 'package.json').read_text()).get('version') == ALPHA_VERSION,
            'Protected Alpha version is not the expected 0.90.145')
    protected = protected_fingerprints(files)
    beta_manifest = json.loads((HUB / 'releases/latest.json').read_text())
    beta_file = beta_manifest['file']
    require(re.fullmatch(r'[A-Za-z0-9._-]+', beta_file), 'Invalid Beta artifact name')
    beta_sha = sha(HUB / 'releases' / beta_file)
    require(beta_manifest['sha256'] == beta_sha, 'Existing Beta checksum mismatch')

    backup = Path(tempfile.mkdtemp(prefix='audit-hub-backup-', dir=stage))
    verified = Path(tempfile.mkdtemp(prefix='audit-hub-verified-', dir=stage))
    scratch = Path(tempfile.mkdtemp(prefix='audit-hub-probe-', dir=stage))
    metadata = {}
    try:
        before_version = health(scratch)
        require(before_version == BASELINE_VERSION, 'Hub health baseline is not the expected 0.4.61')
        for relative, evidence in sorted(files.items()):
            target = safe_target(relative)
            existing = path_kind(target)
            if evidence['before'] is None:
                require(existing is None, 'Expected new Hub file already exists: ' + relative)
                parent = target.parent.stat()
                metadata[relative] = {'existed': False, 'mode': 0o644,
                                      'uid': parent.st_uid, 'gid': parent.st_gid}
            else:
                require(existing is not None and stat.S_ISREG(existing.st_mode),
                        'Expected regular Hub baseline: ' + relative)
                original = read_regular(target)
                require(hashlib.sha256(original).hexdigest() == evidence['before'],
                        'Live baseline mismatch: ' + relative)
                metadata[relative] = {'existed': True, 'mode': stat.S_IMODE(existing.st_mode),
                                      'uid': existing.st_uid, 'gid': existing.st_gid}
                private_copy_tree_entry(backup, relative, original)
            artifact = read_regular(stage_file(stage, relative), require_stage=True)
            require(hashlib.sha256(artifact).hexdigest() == evidence['after'],
                    'Staged artifact mismatch: ' + relative)
            private_copy_tree_entry(verified, relative, artifact)
        write_private(backup / 'recovery.json', (json.dumps({
            'sourceCommit': manifest['sourceCommit'], 'expectedVersion': EXPECTED_VERSION,
            'beforeVersion': before_version, 'files': files, 'metadata': metadata,
        }, indent=2) + '\n').encode())
        sync_tree_directories(backup)
        sync_tree_directories(verified)
        sync_dir(stage)
        # A change between backup/proof and stop invalidates the release.
        for relative, evidence in files.items():
            target = safe_target(relative)
            require((path_kind(target) is None) if evidence['before'] is None
                    else sha(target) == evidence['before'], 'Hub baseline changed: ' + relative)
        require(protected_fingerprints(files) == protected, 'Protected code changed before install')

        try:
            # Do not let a running process observe a partially replaced import graph.
            run(['systemctl', 'stop', 'wickhunter-hub'])
            for relative in sorted(files):
                replace(verified / relative, safe_target(relative), metadata[relative])
            run(['systemctl', 'start', 'wickhunter-hub'])
            new_pid = wait_ready(scratch, EXPECTED_VERSION, old_pid)
            require(request('/api/latest', scratch / 'latest.json', token) == 200,
                    'Header metadata probe failed')
            latest = json.loads((scratch / 'latest.json').read_text())
            require(latest['file'] == beta_file and latest['sha256'] == beta_sha,
                    'Served release identity changed')
            require(request('/download/' + beta_file, scratch / 'artifact', token, timeout=120) == 200
                    and sha(scratch / 'artifact') == beta_sha, 'Header download probe failed')
            for route in ('/api/latest', '/download/' + beta_file):
                require(request(route, scratch / 'invalid', 'LHK1.invalid.signature') == 403,
                        'Invalid credential accepted')
            for relative, evidence in files.items():
                target = safe_target(relative)
                s = target.lstat()
                require(stat.S_ISREG(s.st_mode) and sha(target) == evidence['after'],
                        'Installed artifact mismatch: ' + relative)
                require(metadata[relative]['mode'] == stat.S_IMODE(s.st_mode)
                        and metadata[relative]['uid'] == s.st_uid
                        and metadata[relative]['gid'] == s.st_gid,
                        'Installed metadata changed: ' + relative)
            require(protected_fingerprints(files) == protected,
                    'Protected Alpha/Beta/Hub path changed')
            require({name: pid(name) for name in ALPHA_SERVICES} == alpha_pids,
                    'Protected Alpha service restarted')
            receipt = {'change': 'Hub audit release', 'verifiedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                       'sourceCommit': manifest['sourceCommit'], 'expectedVersion': EXPECTED_VERSION,
                       'files': files, 'oldPid': old_pid, 'newPid': new_pid,
                       'backup': str(backup), 'beforeVersion': before_version,
                       'healthVerified': True, 'headerMetadataAndDownloadVerified': True,
                       'invalidHeaderRejected': True, 'alphaServicesUnchanged': True,
                       'protectedFingerprints': protected, 'betaArtifactSha256': beta_sha,
                       'financialDataRestoredOrRewrittenByDeployment': False}
            write_private(stage / 'receipt.json', (json.dumps(receipt, indent=2) + '\n').encode())
            sync_dir(stage)
            print(json.dumps(receipt))
        except BaseException:
            run(['systemctl', 'stop', 'wickhunter-hub'])
            for relative in sorted(files):
                target = safe_target(relative)
                if metadata[relative]['existed']:
                    replace(backup / relative, target, metadata[relative])
                elif path_kind(target) is not None:
                    remove_new(target)
            run(['systemctl', 'start', 'wickhunter-hub'])
            wait_ready(scratch, before_version)
            require(all((path_kind(HUB / relative) is None) if evidence['before'] is None
                        else sha(HUB / relative) == evidence['before']
                        for relative, evidence in files.items()), 'Rollback code verification failed')
            require(protected_fingerprints(files) == protected,
                    'Protected path changed during rollback')
            print('Hub audit code rollback verified; current financial data preserved.', file=sys.stderr)
            raise
    finally:
        shutil.rmtree(scratch)


if __name__ == '__main__':
    main()
