#!/usr/bin/python3
"""Run one MST shard in a fresh ChatGPT Linux desktop session."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import time

from session import DesktopSession, RuntimeErrorSafe

KEY_FILE = Path('/run/mst/inference-key')
WORK_DIR = Path('/run/mst/work')


def wait_display() -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        result = subprocess.run(
            ['/usr/bin/xdpyinfo'],
            env={'PATH': '/usr/bin:/bin', 'DISPLAY': ':1'},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        if result.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeErrorSafe('display-not-ready')


def main(argv: list[str]) -> int:
    if not argv or argv[0] != 'mst' or len(argv) < 2 or argv[1] != 'collect':
        raise RuntimeErrorSafe('worker-command-invalid')
    version = os.environ.get('MST_CHATGPT_APP_VERSION', '')
    if not version:
        raise RuntimeErrorSafe('app-version-missing')
    wait_display()
    key = KEY_FILE.read_text(encoding='ascii')
    KEY_FILE.unlink()
    with DesktopSession(key, None, version) as session_env:
        area = Path(session_env['HOME']).parent
        evidence = area / 'evidence'
        evidence.mkdir(mode=0o700)
        environment = {
            key: value
            for key, value in os.environ.items()
            if key not in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_HOME')
        }
        environment.update(session_env)
        environment['MST_CHATGPT_EVIDENCE_DIR'] = str(evidence)
        return subprocess.run(argv, cwd=WORK_DIR, env=environment, check=False).returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, UnicodeError, RuntimeErrorSafe) as error:
        # Never print the key or raw desktop output.
        print(f'ChatGPT worker setup failed: {type(error).__name__}', file=sys.stderr)
        raise SystemExit(2)
