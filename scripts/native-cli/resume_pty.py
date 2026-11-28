"""Exercise public sessions resume with real terminal input and a loopback model."""
import argparse
import errno
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import sys
import subprocess
import termios
import threading
import time


def frame(delta, stop=None):
    return {'choices': [{'index': 0, 'delta': delta, 'finish_reason': stop}]}


def rows(file):
    return [json.loads(line) for line in file.read_text().splitlines()]


def wait_for(ready, description):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        result = ready()
        if result:
            return result
        time.sleep(0.02)
    raise AssertionError(description)


class Model:
    def __init__(self):
        self.requests = []
        self.errors = []
        self.release = threading.Event()
        self.first_frame = threading.Event()

    def respond(self, handler):
        try:
            assert handler.path == '/v1/chat/completions', handler.path
            body = json.loads(handler.rfile.read(int(handler.headers['Content-Length'])))
            self.requests.append(body)
            latest = next(row['content'] for row in reversed(body['messages']) if row['role'] == 'user')
            handler.send_response(200)
            handler.send_header('Content-Type', 'text/event-stream')
            handler.end_headers()

            def emit(value):
                handler.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
                handler.wfile.flush()

            if latest == 'Cancel an active turn':
                emit(frame({'content': 'Visible before cancellation'}))
                self.first_frame.set()
                if not self.release.wait(12):
                    raise AssertionError('Cancellation test left the fixture blocked')
                return
            if latest in ('Reject this write', 'Accept this write') and body['messages'][-1]['role'] == 'user':
                call = 'denied-write' if latest.startswith('Reject') else 'approved-write'
                assert any(t['function']['name'] == 'write_file' for t in body['tools'])
                emit(frame({'tool_calls': [{'index': 0, 'id': call, 'type': 'function',
                    'function': {'name': 'write_file', 'arguments': json.dumps({
                        'path': f'{call}.txt', 'content': 'isolated file effect'})}}]}, 'tool_calls'))
            else:
                reply = {
                    'Seed the existing session': 'Earlier persisted answer',
                    'Reject this write': 'Denied tool was observed',
                    'Accept this write': 'Approved tool was observed',
                    'Continue after cancel': 'Next turn completed',
                }[latest]
                emit(frame({'content': reply}, 'stop'))
            emit({'choices': [], 'usage': {'prompt_tokens': 4, 'completion_tokens': 2}})
            handler.wfile.write(b'data: [DONE]\n\n')
        except Exception as error:
            self.errors.append(repr(error))


class Terminal:
    def __init__(self, binary, root, env, sid, log):
        self.log = log
        self.captured = bytearray()
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 120, 0, 0))
        # crossterm needs the controlling terminal on macOS. Keep its
        # session leader alive until we verify the child restored termios.
        self.original = termios.tcgetattr(self.slave)
        self.receipt = log.with_suffix('.exit')
        guardian = """import fcntl, pathlib, signal, subprocess, sys, termios, time
fcntl.ioctl(0, termios.TIOCSCTTY, 0)
child = subprocess.Popen(sys.argv[2:])
receipt = pathlib.Path(sys.argv[1])
receipt.with_suffix('.pid').write_text(str(child.pid))
temporary = receipt.with_suffix('.tmp')
temporary.write_text(str(child.wait()))
temporary.replace(receipt)
time.sleep(30)
"""
        self.process = subprocess.Popen(
            [sys.executable, '-c', guardian, str(self.receipt),
             str(binary), 'sessions', 'resume', sid],
            stdin=self.slave, stdout=self.slave, stderr=self.slave, start_new_session=True,
            cwd=root, env=env,
        )

    def read(self, timeout=0.05):
        if select.select([self.master], [], [], timeout)[0]:
            try:
                self.captured.extend(os.read(self.master, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        assert len(self.captured) < 2 * 1024 * 1024, 'unbounded terminal output'

    def see(self, token, since=0):
        def visible():
            self.read()
            plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', self.captured[since:])
            return ''.join(token.split()) in ''.join(plain.decode('utf-8', 'replace').split())
        try:
            wait_for(visible, f'terminal did not present {token!r}')
        except AssertionError as error:
            raise AssertionError(f'{error}: {bytes(self.captured)[-1800:]!r}') from error

    def key(self, data):
        os.write(self.master, data)

    def draft(self, text):
        self.key(b'\x1b[200~' + text.encode() + b'\x1b[201~')

    def resize(self, height, width):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
        pid = int(self.receipt.with_suffix('.pid').read_text())
        os.kill(pid, signal.SIGWINCH)

    def exit(self, expected=0):
        def exited():
            self.read()
            return self.receipt.exists()
        wait_for(exited, 'terminal child did not exit')
        self.read()
        assert int(self.receipt.read_text()) == expected
        assert b'\x1b[?1049l' in self.captured and b'\x1b[?2004l' in self.captured
        restored = termios.tcgetattr(self.slave)
        # Darwin may set a transient retype flag during canonical restoration.
        pending = getattr(termios, 'PENDIN', 0) if sys.platform == 'darwin' else 0
        for attributes in (restored, self.original):
            attributes[3] &= ~pending
        assert restored == self.original

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            if self.process.poll() is None:
                pid_file = self.receipt.with_suffix('.pid')
                if not self.receipt.exists() and pid_file.exists():
                    pid = int(pid_file.read_text())
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    end = time.monotonic() + 3
                    while not self.receipt.exists() and time.monotonic() < end:
                        self.read()
                    if not self.receipt.exists():
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                self.process.terminate()
                self.process.wait(timeout=3)
        finally:
            os.close(self.master)
            os.close(self.slave)
            self.log.write_bytes(self.captured)


def exercise(binary, output, server, model):
    env = {
        'PATH': '/nonexistent', 'HOME': str(output), 'PEER_AGENT_HOME': str(output / 'data'),
        'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'NO_PROXY': '*',
        'PEER_MODEL_API_KEY': 'fixture-only', 'PEER_MODEL_ID': 'resume-fixture',
        'PEER_MODEL_BASE_URL': f'http://127.0.0.1:{server.server_port}/v1',
    }
    def run(*args):
        return subprocess.run([binary, *args], input=b'', capture_output=True, timeout=12, cwd=output, env=env)

    assert run('sessions', 'resume', 'missing').returncode == 2
    assert not (output / 'data').exists()
    seeded = run('exec', '--mode', 'chat', '--output-format', 'json', 'Seed the existing session')
    assert seeded.returncode == 0, (seeded.stdout, seeded.stderr, model.errors)
    sid = json.loads(seeded.stdout)['sessionId']
    directory = output / 'data' / 'conversations'
    index = directory / 'index.jsonl'
    body = directory / (sid + '.jsonl')
    starting_index, starting_body = index.read_bytes(), body.read_bytes()

    with Terminal(binary, output, env, sid, output / 'resume.ansi') as main:
        main.see('Earlier persisted answer')
        assert len(model.requests) == 1
        assert index.read_bytes() == starting_index and body.read_bytes() == starting_body
        main.draft('Reject this write')
        main.see('Reject this write')
        assert len(model.requests) == 1 and body.read_bytes() == starting_body
        main.key(b'\r')
        main.see('denied-write.txt')
        main.draft('y')
        main.read(timeout=0.15)
        assert not (output / 'denied-write.txt').exists()
        assert len(model.requests) == 2
        main.key(b'n')
        main.see('Denied tool was observed')

        main.draft('Accept this write')
        main.key(b'\r')
        main.see('approved-write.txt')
        main.resize(10, 55)
        main.see('窗口过小')
        main.key(b'y')
        main.read(timeout=0.2)
        assert not (output / 'approved-write.txt').exists()
        before_resize = len(main.captured)
        main.resize(32, 120)
        main.see('approved-write.txt', since=before_resize)
        assert not (output / 'approved-write.txt').exists()
        main.key(b'y')
        main.see('Approved tool was observed')
        assert (output / 'approved-write.txt').read_text() == 'isolated file effect'

        main.draft('Cancel an active turn')
        main.key(b'\r')
        assert model.first_frame.wait(12)
        main.see('Visible before cancellation')
        unchanged_index, unchanged_body = index.read_bytes(), body.read_bytes()
        active_requests = len(model.requests)
        with Terminal(binary, output, env, sid, output / 'busy.ansi') as busy:
            busy.see('Earlier persisted answer')
            busy.draft('A competing draft')
            busy.key(b'\r')
            busy.see('conversation_execution_busy')
            assert len(model.requests) == active_requests
            assert index.read_bytes() == unchanged_index and body.read_bytes() == unchanged_body
            busy.key(b'\x03')
            busy.see('临时草稿尚未保存')  # The rejected draft still needs an explicit discard.
            busy.key(b'\x03')
            busy.exit()
        main.key(b'\x03')
        main.see('本轮已停止')
        main.see('未完成')
        model.release.set()
        assert b'Visible before cancellation' not in body.read_bytes()
        main.draft('Continue after cancel')
        main.key(b'\r')
        main.see('Next turn completed')
        main.key(b'\x03')
        main.exit()

    [metadata] = rows(index)
    assert metadata['id'] == sid and metadata['runtimeExecution']['phase'] == 'stopped'
    assert metadata['runtimeExecution']['engine'] == 'peer-native'
    assert len(model.requests) == 7 and not model.errors, model.errors
    assert any(row.get('content') == 'Earlier persisted answer' for row in model.requests[1]['messages'])
    calls = {segment['args']['path']: (message['permissionGrants'], segment['result'])
             for message in rows(body) for segment in message.get('segments', [])
             if segment['type'] == 'tool-call'}
    evidence = rows(output / 'data' / 'goal-plans' / 'evidence-index.jsonl')
    for path, authorized, status in (('denied-write.txt', False, 'denied'), ('approved-write.txt', True, 'success')):
        grants, result = calls[path]
        call = result['toolCallId']
        assert grants[-1]['granted'] == authorized and result['status'] == status
        assert grants[-1]['toolCallId'] == call
        assert any(row['evidenceRef'] == f'tool-result://{call}' and row['conversationId'] == sid
                   for row in evidence)
        assert any(row.get('tool_call_id') == call
                   for request in model.requests for row in request['messages'])

    # Model and history fixtures use a new disposable root. Removing only the
    # execution record here simulates an older writer without a stop receipt.
    metadata.pop('runtimeExecution')
    index.write_text(json.dumps(metadata) + '\n')
    unrecorded_index, unrecorded_body = index.read_bytes(), body.read_bytes()
    with Terminal(binary, output, env, sid, output / 'unrecorded.ansi') as missing:
        missing.see('Next turn completed')
        missing.draft('Keep unrecorded draft')
        missing.key(b'\r')
        missing.see('conversation_execution_unrecorded')
        assert len(model.requests) == 7
        assert index.read_bytes() == unrecorded_index and body.read_bytes() == unrecorded_body
        missing.key(b'\x03')
        missing.see('临时草稿尚未保存')
        missing.key(b'\x03')
        missing.exit()
    older = b''.join((json.dumps({'id': f'older-{i}', 'role': 'user',
        'content': 'ARCHIVE_START_000' if i == 0 else f'Historical page row {i:02d}'}) + '\n').encode() for i in range(18))
    body.write_bytes(older + unrecorded_body)
    with Terminal(binary, output, env, sid, output / 'history.ansi') as history:
        history.see('Next turn completed')
        history.key(b'\x1b[5~')
        history.see('ARCHIVE_START_000')
        history.see('正在阅读历史')
        before_latest = len(history.captured)
        history.key(b'\x1b[6~')
        history.see('Next turn completed', since=before_latest)
        history.key(b'\x03')
        history.exit()
    assert body.read_bytes() == older + unrecorded_body and len(model.requests) == 7
    return dict(sessionId=sid, sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                cases=['no-tty', 'open-read-only', 'deny', 'bounded-approval-viewport', 'approve', 'busy', 'cancel',
                       'continue-after-cancel', 'unrecorded', 'history-paging'], requests=len(model.requests))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True)
    model = Model()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            model.respond(self)

        def log_message(self, *_):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        background = threading.Thread(target=server.serve_forever, daemon=True)
        background.start()
        try:
            receipt = exercise(args.binary.resolve(), output, server, model)
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            print(json.dumps(receipt))
        finally:
            model.release.set()
            server.shutdown()
            background.join()


if __name__ == '__main__':
    main()
