#!/usr/bin/env python3
"""Real PTY E2E tests for P6 native Bot shell, Classic chat shell, ModelPicker, approvals, and mode switching."""
import argparse
import errno
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
import threading
import time


def frame(delta, stop=None):
    return {'choices': [{'index': 0, 'delta': delta, 'finish_reason': stop}]}


def visible_text(raw: bytes) -> str:
    text = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', raw).decode('utf-8', 'replace')
    return ''.join(text.split())


class MockModelServer:
    def __init__(self):
        self.requests = []
        self.release_cancel = threading.Event()
        self.stream_started = threading.Event()
        self.errors = []
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                pass

            def do_POST(self):
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    body = json.loads(self.rfile.read(length))
                    parent.requests.append(body)
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.end_headers()

                    def emit(val):
                        self.wfile.write(('data: ' + json.dumps(val) + '\n\n').encode())
                        self.wfile.flush()

                    sys_msg = next((m['content'] for m in body['messages'] if m['role'] == 'system'), '')
                    last_user = next((m['content'] for m in reversed(body['messages']) if m['role'] == 'user'), '')
                    last_role = body['messages'][-1]['role']

                    if 'Project Agent Role Rules' in sys_msg:
                        # Extract anchor id from L7_CONTINUITY in system prompt
                        m = re.search(r'"(input-[A-Za-z0-9_.:-]+)"', sys_msg)
                        anchor = m.group(1) if m else 'input-unknown'
                        emit(frame({'tool_calls': [{
                            'index': 0,
                            'id': 'bot-reply-call',
                            'type': 'function',
                            'function': {
                                'name': 'post_reply',
                                'arguments': json.dumps({
                                    'replyTo': [anchor],
                                    'text': 'Native Bot PTY reply succeeded.'
                                })
                            }
                        }]}, 'tool_calls'))
                    elif last_user == 'Stream and cancel':
                        emit(frame({'content': 'Partial classic output'}))
                        parent.stream_started.set()
                        parent.release_cancel.wait(10)
                        return
                    elif last_user == 'Write demo.txt' and last_role == 'user':
                        emit(frame({'tool_calls': [{
                            'index': 0,
                            'id': 'classic-write-1',
                            'type': 'function',
                            'function': {
                                'name': 'write_file',
                                'arguments': json.dumps({
                                    'path': 'demo.txt',
                                    'content': 'hello from native classic tui\n'
                                })
                            }
                        }]}, 'tool_calls'))
                    elif last_user == 'Write demo.txt' and last_role == 'tool':
                        emit(frame({'content': 'Classic write finished cleanly.'}, 'stop'))
                    elif last_user == 'Continue classic':
                        emit(frame({'content': 'Classic resumed cleanly.'}, 'stop'))
                    else:
                        emit(frame({'content': f'Echo: {last_user}'}, 'stop'))

                    emit({'choices': [], 'usage': {'prompt_tokens': 10, 'completion_tokens': 5}})
                    self.wfile.write(b'data: [DONE]\n\n')
                    self.wfile.flush()
                except Exception as exc:
                    parent.errors.append(repr(exc))

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f'http://127.0.0.1:{self.server.server_address[1]}/v1'

    def close(self):
        self.release_cancel.set()
        self.server.shutdown()
        self.server.server_close()


class PtyRunner:
    def __init__(self, binary: Path, cwd: Path, data_home: Path, args, extra_env=None, size=(40, 120)):
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', *size, 0, 0))
        self.original = termios.tcgetattr(self.slave)
        env = {
            'PATH': '/nonexistent',
            'HOME': str(cwd),
            'PEER_AGENT_HOME': str(data_home),
            'TERM': 'xterm-256color',
            'LANG': 'en_US.UTF-8',
        }
        if extra_env:
            env.update(extra_env)
        self.proc = subprocess.Popen(
            [str(binary), *args],
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            cwd=cwd,
            start_new_session=True,
            env=env,
        )
        self.captured = bytearray()

    def drain(self, seconds=0.05):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ready, _, _ = select.select([self.master], [], [], 0.02)
            if ready:
                try:
                    chunk = os.read(self.master, 65536)
                    if not chunk:
                        break
                    self.captured.extend(chunk)
                except OSError as err:
                    if err.errno != errno.EIO:
                        raise
                    break

    def wait_text(self, needle: str, timeout=10.0, since: int = 0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.drain(0.04)
            if needle in visible_text(bytes(self.captured[since:])):
                return
            if self.proc.poll() is not None:
                break
        raise AssertionError(
            f'Timed out waiting for {needle!r}; exit={self.proc.poll()}; '
            f'tail={visible_text(bytes(self.captured[since:]))[-600:]!r}'
        )

    def send(self, data: bytes):
        os.write(self.master, data)

    def wait_exit(self, timeout=8.0) -> int:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.drain(0.04)
            code = self.proc.poll()
            if code is not None:
                return code
        raise AssertionError(f'Process did not exit in {timeout}s')

    def close(self):
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=3)
            except Exception:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                    self.proc.wait(timeout=3)
                except Exception:
                    pass
        os.close(self.master)
        os.close(self.slave)


def run_all(binary: Path, output: Path):
    output.mkdir(parents=True, exist_ok=True)
    model = MockModelServer()
    env = {
        'PEER_MODEL_API_KEY': 'test-key',
        'PEER_MODEL_BASE_URL': model.base_url,
        'PEER_MODEL_ID': 'mock-pty-model',
    }
    results = []
    try:
        # Case 1: Bot bind -> chat -> reply -> /tasks -> /model -> /bots (ADR 122) -> exit
        c1_ws = output / 'case1-ws'
        c1_home = output / 'case1-home'
        c1_ws.mkdir(); c1_home.mkdir()
        r1 = PtyRunner(binary, c1_ws, c1_home, [], extra_env=env)
        try:
            r1.wait_text('把这个目录绑定为机器人')
            r1.wait_text('否，进入普通任务模式')
            r1.send(b'\r')  # Confirm bind
            r1.wait_text('·case1-ws')
            r1.send(b'Hello native bot\r')
            r1.wait_text('NativeBotPTYreplysucceeded')
            r1.send(b'/tasks\r')
            r1.wait_text('委派任务列表')
            r1.send(b'\x1b')
            r1.drain(0.1)
            r1.send(b'/model\r')
            r1.wait_text('模型选择')
            r1.send(b'\x1b')
            r1.drain(0.1)
            r1.send(b'/bots\r')
            r1.wait_text('›')
            assert 'F2·普通任务模式' not in visible_text(bytes(r1.captured))
            r1.send(b'\x03')
            code = r1.wait_exit()
            assert code == 0, f'case1 exit={code}'
            results.append({'case': 'bot-bind-chat-and-subcommands', 'passed': True})
        finally:
            r1.close()

        # Case 2: Classic chat -> write_file approval -> real file written -> Ctrl-C cancel -> continue -> exit
        c2_ws = output / 'case2-ws'
        c2_home = output / 'case2-home'
        c2_ws.mkdir(); c2_home.mkdir()
        seeded_settings = json.dumps({
            'schemaVersion': 3,
            'activeWorkspace': str(c2_ws),
            'workspaces': [{'id': 'ws-case2', 'path': str(c2_ws)}],
            'appearance': {'mode': 'dark'},
            'workbench': {'open': False},
            'developer': {'projectAgentMode': False},
            'effort': 'high',
            'fallbackVision': {'providerId': 'mock'},
            'inputPrediction': {'enabled': False},
            'modelRouting': {'roles': {}, 'tiers': {}},
            'remoteAccess': {'enabled': False},
            'updateChannel': 'beta',
            'composerDrafts': {},
            'localAccessLevel': 'ask_before_local',
            'projectAgent': {
                'shell': 'bots',
                'shellIntroPending': False,
                'shellIntroDismissed': True,
                'proactivity': 'standard',
                'quietHours': {'enabled': False, 'start': '22:00', 'end': '08:00'},
                'digestTime': '09:00',
            },
        })
        (c2_home / 'settings.json').write_text(seeded_settings)
        r2 = PtyRunner(binary, c2_ws, c2_home, ['--classic'], extra_env=env)
        try:
            r2.wait_text('Peer·对话')
            r2.send(b'Write demo.txt\r')
            r2.wait_text('本地授权请求')
            r2.send(b'y')
            r2.wait_text('Classicwritefinishedcleanly')
            assert (c2_ws / 'demo.txt').read_text() == 'hello from native classic tui\n'
            r2.drain(0.3)

            r2.send(b'Stream and cancel\r')
            r2.wait_text('Partialclassicoutput')
            r2.send(b'\x03')
            model.release_cancel.set()
            r2.wait_text('本轮已停止')

            r2.send(b'Continue classic\r')
            r2.wait_text('Classicresumedcleanly')
            assert (c2_home / 'settings.json').read_text() == seeded_settings
            r2.send(b'\x03')
            code = r2.wait_exit()
            assert code == 0, f'case2 exit={code}'
            results.append({'case': 'classic-stream-approval-cancel-continue', 'passed': True})
        finally:
            r2.close()

        # Case 3: F2 Bot <-> Classic live switch without writing any files to disk
        c3_ws = output / 'case3-ws'
        c3_home = output / 'case3-home'
        c3_ws.mkdir(); c3_home.mkdir()
        r3 = PtyRunner(binary, c3_ws, c3_home, ['bots'], extra_env=env)
        try:
            r3.wait_text('暂无已绑定的项目机器人')
            r3.send(b'\x1bOQ')  # F2
            r3.wait_text('·对话')
            r3.send(b'/bots\r')
            r3.wait_text('暂无已绑定的项目机器人')
            r3.send(b'\x03')
            code = r3.wait_exit()
            assert code == 0, f'case3 exit={code}'
            assert not list(c3_home.rglob('*')), 'F2 switch created unexpected persistent files'
            results.append({'case': 'f2-bot-classic-roundtrip', 'passed': True})
        finally:
            r3.close()

        # Case 4: Classic /new -> Ctrl+X L resume -> /help -> /version -> /mode & Ctrl+X 1 -> /permissions -> /theme -> /skill -> /mcp -> /compact
        c4_ws = output / 'case4-ws'
        c4_home = output / 'case4-home'
        c4_ws.mkdir(); c4_home.mkdir()
        r4 = PtyRunner(binary, c4_ws, c4_home, ['--classic'], extra_env=env)
        try:
            r4.wait_text('Peer·对话')
            r4.send(b'First topic\r')
            r4.wait_text('Echo:Firsttopic')
            r4.drain(0.2)

            since = len(r4.captured)
            r4.send(b'/new\r')
            r4.wait_text('已开始新会话', since=since)

            since = len(r4.captured)
            r4.send(b'\x18l')  # Ctrl+X then l -> Resume picker
            r4.wait_text('恢复会话', since=since)
            r4.wait_text('Firsttopic', since=since)

            since = len(r4.captured)
            r4.send(b'\r')
            r4.wait_text('已恢复会话', since=since)
            r4.wait_text('Echo:Firsttopic', since=since)

            since = len(r4.captured)
            r4.send(b'/help\r')
            r4.wait_text('帮助·快捷键', since=since)
            r4.send(b'\x1b')
            r4.drain(0.08)

            since = len(r4.captured)
            r4.send(b'/version\r')
            r4.wait_text('peer0.', since=since)

            since = len(r4.captured)
            r4.send(b'/mode\r')
            r4.wait_text('选择下一条消息的运行模式', since=since)
            since = len(r4.captured)
            r4.send(b'2')
            r4.wait_text('运行模式已切换为Plan', since=since)

            since = len(r4.captured)
            r4.send(b'\x181')  # Ctrl+X then 1 -> Agent
            r4.wait_text('运行模式已切换为Agent', since=since)

            since = len(r4.captured)
            r4.send(b'/permissions\r')
            r4.wait_text('本地权限策略', since=since)
            r4.send(b'\x1b')
            r4.drain(0.08)

            since = len(r4.captured)
            r4.send(b'/theme\r')
            r4.wait_text('主题·PeerFrost', since=since)
            r4.send(b'\x1b')
            r4.drain(0.08)

            since = len(r4.captured)
            r4.send(b'/skill\r')
            r4.wait_text('Skills技能管理', since=since)
            r4.send(b'\x1b')
            r4.drain(0.08)

            since = len(r4.captured)
            r4.send(b'/mcp\r')
            r4.wait_text('MCPServers管理', since=since)
            r4.send(b'\x1b')
            r4.drain(0.08)

            since = len(r4.captured)
            r4.send(b'Continue classic\r')
            r4.wait_text('Classicresumedcleanly', since=since)
            r4.drain(0.2)

            since = len(r4.captured)
            r4.send(b'/compact\r')
            r4.wait_text('已完成上下文压缩', since=since)

            r4.send(b'\x03')
            code = r4.wait_exit()
            assert code == 0, f'case4 exit={code}'
            results.append({'case': 'classic-resume-pickers-and-leader-chords', 'passed': True})
        finally:
            r4.close()

        # Case 5: BindWorkspace refusal (No / Esc) enters Classic mode with zero disk writes
        c5a_ws = output / 'case5a-ws'
        c5a_home = output / 'case5a-home'
        c5a_ws.mkdir(); c5a_home.mkdir()
        r5a = PtyRunner(binary, c5a_ws, c5a_home, [], extra_env=env)
        try:
            r5a.wait_text('把这个目录绑定为机器人')
            r5a.wait_text('否，进入普通任务模式')
            r5a.send(b'\x1b[C\r')  # Right arrow -> No, Enter -> Classic
            r5a.wait_text('Peer·对话')
            r5a.send(b'\x03')
            code = r5a.wait_exit()
            assert code == 0, f'case5a exit={code}'
            assert not list(c5a_home.rglob('*')), 'Bind refusal via No wrote unexpected persistent files'
        finally:
            r5a.close()

        c5b_ws = output / 'case5b-ws'
        c5b_home = output / 'case5b-home'
        c5b_ws.mkdir(); c5b_home.mkdir()
        r5b = PtyRunner(binary, c5b_ws, c5b_home, [], extra_env=env)
        try:
            r5b.wait_text('把这个目录绑定为机器人')
            r5b.send(b'\x1b')  # Esc -> Classic
            r5b.wait_text('Peer·对话')
            r5b.send(b'\x03')
            code = r5b.wait_exit()
            assert code == 0, f'case5b exit={code}'
            assert not list(c5b_home.rglob('*')), 'Bind refusal via Esc wrote unexpected persistent files'
        finally:
            r5b.close()
        results.append({'case': 'bind-refusal-enters-classic-without-writing', 'passed': True})

        assert not model.errors, f'Mock model server errors: {model.errors}'
        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps({'passed': len(results), 'results': results}))
    finally:
        model.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    run_all(args.binary.resolve(), args.output.resolve())
