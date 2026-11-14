"""Real PTY checks for the isolated native candidate; no emulator or real IME claim."""
import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def check(binary, output, name, args=(), action='exit', expected=0, size=(40, 120)):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', *size, 0, 0))
    original = termios.tcgetattr(slave)
    home = output / (name + '-home')
    home.mkdir()
    guardian_home = output / (name + '-guardian-home')
    guardian_home.mkdir()
    # Keep a guardian as the PTY session leader. macOS revokes slave fds when
    # that leader exits, so reading termios after a directly executed child
    # exits would test a revoked fd, not terminal restoration.
    pid_file = output / (name + '-pid.json')
    status_file = output / (name + '-status.json')
    guardian = """import fcntl, json, os, pathlib, signal, subprocess, sys, termios, time
fcntl.ioctl(0, termios.TIOCSCTTY, 0)
signal.signal(signal.SIGINT, signal.SIG_IGN)
p = subprocess.Popen(sys.argv[4:], env={**os.environ, 'HOME': sys.argv[3], 'PEER_AGENT_HOME': sys.argv[3] + '/data'})
pathlib.Path(sys.argv[1]).write_text(json.dumps({'pid': p.pid}))
code = p.wait()
pathlib.Path(sys.argv[2]).write_text(json.dumps({'exitCode': code}))
time.sleep(20)
"""
    process = subprocess.Popen([sys.executable, '-c', guardian, str(pid_file), str(status_file), str(home), str(binary), *args], stdin=slave, stdout=slave, stderr=slave,
        cwd=home, start_new_session=True,
        env={'PATH': '/nonexistent', 'HOME': str(guardian_home),
             'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8'})
    captured = bytearray()
    def visible_text():
        # Ratatui positions each wide cell explicitly; UTF-8 words need not be
        # contiguous in ANSI bytes. Match text after removing CSI positioning.
        text = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', bytes(captured)).decode('utf-8', 'replace')
        return ''.join(text.split())
    deadline = time.monotonic() + 8
    def drain(until):
        while time.monotonic() < until:
            ready, _, _ = select.select([master], [], [], 0.02)
            if ready:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            if len(captured) > 2 * 1024 * 1024:
                raise AssertionError('unbounded terminal output')
    try:
        while not pid_file.exists() and process.poll() is None and time.monotonic() < deadline:
            drain(time.monotonic() + 0.02)
        native_pid = json.loads(pid_file.read_text())['pid']
        if action not in ('automatic', 'oversize'):
            while b'Peer' not in captured and not status_file.exists() and time.monotonic() < deadline:
                drain(time.monotonic() + 0.03)
            assert b'Peer' in captured, (name, bytes(captured))
        if action == 'edit':
            os.write(master, b'\x1b[200~' + '中文\ne\u0301'.encode() + b'\x1b[201~')
            drain(time.monotonic() + 0.1)
            os.write(master, b'\r')
            drain(time.monotonic() + 0.1)
            assert '发送尚未启用' in visible_text()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 60, 0, 0))
            os.kill(native_pid, signal.SIGWINCH)
            drain(time.monotonic() + 0.1)
            os.write(master, b'\x03'); drain(time.monotonic() + 0.1)
            assert '再次Ctrl-C' in visible_text()
            os.write(master, b'\x1b'); drain(time.monotonic() + 0.1)
            os.write(master, b'\x03'); drain(time.monotonic() + 0.1)
            os.write(master, b'\x03')
        elif action == 'sigterm':
            os.kill(native_pid, signal.SIGTERM)
        elif action == 'eof':
            os.write(master, b'\x04')
        elif action == 'exit':
            os.write(master, b'\x03')
        while not status_file.exists() and process.poll() is None and time.monotonic() < deadline:
            drain(time.monotonic() + 0.05)
        if not status_file.exists():
            raise AssertionError(f'{name}: child did not settle')
        drain(time.monotonic() + 0.05)
        code = json.loads(status_file.read_text())['exitCode']
        actual = termios.tcgetattr(slave)
        (output / (name + '-termios.json')).write_text(json.dumps({'before': repr(original), 'after': repr(actual)}, indent=2))
        # Darwin sets PENDIN when canonical mode is restored after raw mode.
        # Reproduced with Python tty.setraw + tcsetattr alone, with no Peer.
        # It is a kernel transient retype flag, not a restored input setting.
        # Compare every other flag, control character, baud rate and mode.
        pending = getattr(termios, 'PENDIN', 0) if sys.platform == 'darwin' else 0
        comparable = list(actual)
        comparable[3] &= ~pending
        expected_attributes = list(original)
        expected_attributes[3] &= ~pending
        restored = comparable == expected_attributes
        assert restored, f'{name}: original terminal attributes not restored'
        assert code == expected, (name, code, bytes(captured))
        if action != 'oversize':
            assert b'\x1b[?1049l' in captured, f'{name}: alternate screen not restored'
            assert b'\x1b[?2004l' in captured, f'{name}: bracketed paste not disabled'
        else:
            assert b'\x1b[?1049h' not in captured
        assert not list(home.rglob('*')), f'{name}: candidate created unexpected persistent state'
        result = {'case': name, 'exitCode': code, 'termiosRestored': restored, 'terminalBytes': len(captured),
                  'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'passed': True}
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
        os.close(master); os.close(slave)
        (output / (name + '.ansi')).write_bytes(captured)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True)
    results = []
    for name, action in [('normal', 'exit'), ('unicode-paste-resize-draft', 'edit'), ('sigterm', 'sigterm'), ('ctrl-d', 'eof')]:
        results.append(check(args.binary.resolve(), args.output, name, action=action))
    for name, code in [('normal', 0), ('error', 1), ('panic', 101)]:
        results.append(check(args.fixture.resolve(), args.output, 'guard-' + name, args=[name], action='automatic', expected=code))
    results.append(check(args.binary.resolve(), args.output, 'oversized-terminal', action='oversize', expected=1, size=(4000, 4000)))
    (args.output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': len(results), 'results': results}))
