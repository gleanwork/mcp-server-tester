"""MST's disposable ChatGPT desktop session inside one Docker worker.

`DesktopSession` creates a fresh private tmpfs area, a private D-Bus session bus, an
unlocked secrets keyring and the AT-SPI address, checks the pinned package, and
returns the exact MST environment (see README.md). MST owns `$HOME/.codex`, login,
the app and evidence. Exit stops every owned session process and removes the area.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import secrets
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

APP = '/usr/bin/chatgpt'
PYTHON = '/usr/bin/python3'
TOKEN_ENV = 'MST_CHATGPT_MCP_TOKEN_0'
FIXED_ENV = {
    'PATH': '/usr/bin:/bin',
    'LANG': 'C.UTF-8',
    'DISPLAY': ':1',
    'NO_AT_BRIDGE': '0',
    'ACCESSIBILITY_ENABLED': '1',
    'GTK_MODULES': 'gail:atk-bridge',
}
MAX_PROCESS_ENV_BYTES = 256 * 1024


class RuntimeErrorSafe(RuntimeError):
    """Only fixed, non-secret classifications cross the session boundary."""


def _tmpfs(path: Path) -> bool:
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        mount = Path(re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), left.split()[4]))
        if path == mount or mount in path.parents:
            mounts.append((len(mount.parts), right.split()[0]))
    return bool(mounts) and max(mounts)[1] == 'tmpfs'


def require_isolated_linux(parent: Path) -> None:
    if sys.platform != 'linux' or os.geteuid() == 0:
        raise RuntimeErrorSafe('non-root-linux-required')
    if not _tmpfs(parent):
        raise RuntimeErrorSafe('disposable-tmpfs-required')
    if not any(line.split() == ['NoNewPrivs:', '1'] for line in Path('/proc/self/status').read_text().splitlines()):
        raise RuntimeErrorSafe('no-new-privileges-required')


def _secret(value: object, limit: int) -> bytes:
    if not isinstance(value, str) or not 0 < len(value) <= limit or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise RuntimeErrorSafe('session-credentials-invalid')
    return value.encode('ascii')


def _identity(pid: int) -> tuple[int, int, int] | None:
    """(pid, uid, start ticks) of a live, non-zombie process."""
    try:
        uid = Path(f'/proc/{pid}').stat().st_uid
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else (pid, uid, int(fields[19]))
    except (OSError, ValueError, IndexError):
        return None


def owned_processes(home: str) -> list[tuple[int, int, int]]:
    """Processes of this uid, newer than this process, whose environment has our HOME.

    MST may start the app in its own session, so session IDs cannot find all of it.
    HOME is a fresh random path; no other process can carry it by accident.
    """
    me = _identity(os.getpid())
    marker = b'HOME=' + home.encode()
    found = []
    for path in Path('/proc').iterdir():
        identity = _identity(int(path.name)) if path.name.isdigit() else None
        if not identity or identity[0] == os.getpid() or identity[1] != os.getuid() or identity[2] < me[2]:
            continue
        try:
            with open(f'/proc/{identity[0]}/environ', 'rb') as stream:
                data = stream.read(MAX_PROCESS_ENV_BYTES)
        except OSError:
            continue
        if marker in data.split(b'\0') and _identity(identity[0]) == identity:
            found.append(identity)
    return found


def stop_owned(home: str) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for identity in owned_processes(home):
            try:
                # pidfds close the identity-check/signal PID-reuse race.
                fd = os.pidfd_open(identity[0])
                try:
                    if _identity(identity[0]) == identity:
                        signal.pidfd_send_signal(fd, sig)
                finally:
                    os.close(fd)
            except ProcessLookupError:
                continue
        deadline = time.monotonic() + 5
        while owned_processes(home) and time.monotonic() < deadline:
            time.sleep(0.05)
    if owned_processes(home):
        raise RuntimeErrorSafe('session-process-cleanup-failed')


def _output(args: list[str], env: dict[str, str], *, timeout: int = 15, limit: int = 65536) -> bytes:
    """Bounded stdout in private tmpfs; stderr discarded; never echoed in errors."""
    with tempfile.TemporaryFile(dir=env['TMPDIR']) as output:
        try:
            result = subprocess.run(
                args,
                env=env,
                cwd=env['HOME'],
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.DEVNULL,
                timeout=timeout,
                check=False,
                start_new_session=True,
            )
        except (OSError, subprocess.SubprocessError):
            raise RuntimeErrorSafe('native-command-failed') from None
        output.seek(0)
        value = output.read(limit + 1)
    if result.returncode or len(value) > limit:
        raise RuntimeErrorSafe('native-command-failed')
    return value


def discover_codex(env: dict[str, str], version: str) -> str:
    """Verify the pinned package and return its single bundled `codex` backend."""
    if _output(['/usr/bin/dpkg-query', '-W', '-f=${Version}', 'chatgpt'], env).decode().strip() != version:
        raise RuntimeErrorSafe('native-app-version-mismatch')
    paths = _output(['/usr/bin/dpkg-query', '-L', 'chatgpt'], env, limit=4 * 1024 * 1024).decode().splitlines()
    candidates = {
        str(Path(path).resolve())
        for path in paths
        if path.startswith('/') and Path(path).name == 'codex' and Path(path).is_file() and os.access(path, os.X_OK)
    }
    if len(candidates) != 1 or APP not in paths:
        raise RuntimeErrorSafe('native-codex-binary-ambiguous')
    return candidates.pop()


def _gdbus(env: dict[str, str], dest: str, path: str, method: str, *args: str) -> bytes:
    command = ['/usr/bin/gdbus', 'call', '--session', '--dest', dest, '--object-path', path, '--method', method]
    return _output([*command, *args], env, timeout=5).strip()


class DesktopSession:
    """Context manager: `with DesktopSession(...) as env:` yields the MST environment."""

    def __init__(self, api_key: str, mcp_token: str | None, version: str, parent: Path = Path('/config')) -> None:
        self.api_key = _secret(api_key, 8192)
        self.mcp_token = _secret(mcp_token, 16384).decode() if mcp_token is not None else None
        self.version = version
        self.parent = parent
        self.area: Path | None = None
        self.identity: tuple[int, int] | None = None
        self.services: list[subprocess.Popen] = []
        self.env: dict[str, str] = {}
        self.closed = False

    def __enter__(self) -> dict[str, str]:
        require_isolated_linux(self.parent)
        area = self.parent / ('mst-chatgpt-' + secrets.token_hex(16))
        area.mkdir(mode=0o700)
        self.area = area
        status = area.lstat()
        self.identity = (status.st_dev, status.st_ino)
        try:
            home = area / 'home'
            for directory in (home, home / '.config', home / '.local', home / '.local/share', home / '.cache'):
                directory.mkdir(mode=0o700)
            for name in ('runtime', 'tmp', 'keyring'):
                (area / name).mkdir(mode=0o700)
            self.env = {
                **FIXED_ENV,
                'HOME': str(home),
                'XDG_CONFIG_HOME': str(home / '.config'),
                'XDG_DATA_HOME': str(home / '.local/share'),
                'XDG_CACHE_HOME': str(home / '.cache'),
                'XDG_RUNTIME_DIR': str(area / 'runtime'),
                'TMPDIR': str(area / 'tmp'),
            }
            codex = discover_codex(self.env, self.version)
            self._start_bus()
            self._start_keyring()
            reply = _gdbus(self.env, 'org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus.GetAddress').decode()
            accessibility = re.fullmatch(r"\('(unix:[^'\\\s]{1,4096})',\)", reply)
            if not accessibility:
                raise RuntimeErrorSafe('accessibility-bus-invalid')
            key_file = area / 'api-key'
            fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(self.api_key)
            self.env.update(
                AT_SPI_BUS_ADDRESS=accessibility[1],
                MST_CHATGPT_APP_PATH=APP,
                MST_CHATGPT_CODEX_PATH=codex,
                MST_CHATGPT_API_KEY_FILE=str(key_file),
                MST_CHATGPT_PYTHON=PYTHON,
            )
            return {**self.env, **({TOKEN_ENV: self.mcp_token} if self.mcp_token is not None else {})}
        except BaseException:
            self.close()
            raise

    def _spawn(self, args: list[str], **kwargs: object) -> subprocess.Popen:
        process = subprocess.Popen(
            args,
            env=self.env,
            cwd=self.env['HOME'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            **kwargs,
        )
        self.services.append(process)
        return process

    def _start_bus(self) -> None:
        # Foreground-owned private bus; never borrow the image user's desktop bus.
        read_fd, write_fd = os.pipe()
        try:
            bus = self._spawn(
                ['/usr/bin/dbus-daemon', '--session', '--nofork', f'--print-address={write_fd}'],
                stdin=subprocess.DEVNULL,
                pass_fds=(write_fd,),
            )
            os.close(write_fd)
            write_fd = -1
            with selectors.DefaultSelector() as selector:
                selector.register(read_fd, selectors.EVENT_READ)
                if not selector.select(timeout=10):
                    raise RuntimeErrorSafe('session-bus-timeout')
                address = os.read(read_fd, 4097).decode().strip()
            if bus.poll() is not None or len(address) > 4096 or not address.startswith('unix:') or '\n' in address:
                raise RuntimeErrorSafe('session-bus-invalid')
            self.env['DBUS_SESSION_BUS_ADDRESS'] = address
        finally:
            os.close(read_fd)
            if write_fd >= 0:
                os.close(write_fd)

    def _start_keyring(self) -> None:
        control = str(self.area / 'keyring')
        self.env['GNOME_KEYRING_CONTROL'] = control
        keyring = self._spawn(
            [
                '/usr/bin/gnome-keyring-daemon',
                '--foreground',
                '--unlock',
                '--components=secrets',
                f'--control-directory={control}',
            ],
            stdin=subprocess.PIPE,
        )
        # A random, never-stored unlock password: the keyring lives only in this area.
        keyring.stdin.write(secrets.token_hex(32).encode())
        keyring.stdin.close()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if keyring.poll() is not None:
                raise RuntimeErrorSafe('keyring-exited')
            try:
                if (
                    _gdbus(
                        self.env,
                        'org.freedesktop.DBus',
                        '/org/freedesktop/DBus',
                        'org.freedesktop.DBus.NameHasOwner',
                        'org.freedesktop.secrets',
                    )
                    == b'(true,)'
                ):
                    return
            except RuntimeErrorSafe:
                pass
            time.sleep(0.1)
        raise RuntimeErrorSafe('keyring-readiness-timeout')

    def close(self) -> None:
        """Stop owned processes, then remove the area. Raises if either is incomplete."""
        if self.closed or self.area is None:
            self.closed = True
            return
        failed = False
        try:
            stop_owned(str(self.area / 'home'))
        except (OSError, RuntimeErrorSafe):
            failed = True
        for process in self.services:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                failed = True
        if failed:
            raise RuntimeErrorSafe('session-cleanup-incomplete')
        try:
            status = self.area.lstat()
        except OSError:
            raise RuntimeErrorSafe('session-area-ownership-invalid') from None
        if (
            not stat.S_ISDIR(status.st_mode)
            or (status.st_dev, status.st_ino) != self.identity
            or status.st_uid != os.getuid()
        ):
            raise RuntimeErrorSafe('session-area-ownership-invalid')
        try:
            shutil.rmtree(self.area)
        except OSError:
            raise RuntimeErrorSafe('session-area-removal-failed') from None
        self.closed = True

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()
