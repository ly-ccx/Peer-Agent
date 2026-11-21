#!/usr/bin/env python3
"""ADR 130 release-build live PTY memory (RSS + macOS physical footprint) and latency bench."""
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
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time


def sample_rss_mib(pid: int) -> float:
    out = subprocess.check_output(['ps', '-o', 'rss=', '-p', str(pid)], text=True).strip()
    return int(out) / 1024.0


def sample_footprint_mib(pid: int):
    if sys.platform != 'darwin':
        return None
    try:
        out = subprocess.check_output(['footprint', '-p', str(pid)], text=True, stderr=subprocess.DEVNULL)
        m = re.search(r'phys_footprint:\s*([\d.]+)\s*(KB|MB|GB|B)', out)
        if not m:
            return None
        val = float(m.group(1))
        unit = m.group(2)
        if unit == 'KB':
            return val / 1024.0
        if unit == 'MB':
            return val
        if unit == 'GB':
            return val * 1024.0
        return val / (1024.0 * 1024.0)
    except Exception:
        return None


def measure_idle_and_input_latency(binary: Path, idle_secs: float):
    tmp = Path(tempfile.mkdtemp(prefix='peer-adr130-idle-'))
    ws = tmp / 'ws'
    home = tmp / 'home'
    ws.mkdir(); home.mkdir()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    proc = subprocess.Popen(
        [str(binary), '--classic'],
        stdin=slave, stdout=slave, stderr=slave,
        cwd=ws, start_new_session=True,
        env={'PATH': '/nonexistent', 'HOME': str(ws), 'PEER_AGENT_HOME': str(home),
             'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8'},
    )
    buf = bytearray()
    try:
        deadline = time.monotonic() + 8
        while b'Peer' not in buf and time.monotonic() < deadline:
            if select.select([master], [], [], 0.02)[0]:
                buf.extend(os.read(master, 65536))
        assert b'Peer' in buf, 'startup failed'

        # Idle measurement
        idle_rss = []
        idle_end = time.monotonic() + idle_secs
        while time.monotonic() < idle_end:
            idle_rss.append(sample_rss_mib(proc.pid))
            time.sleep(min(1.0, max(0.05, idle_end - time.monotonic())))
        foot = sample_footprint_mib(proc.pid)

        # Input-to-visible latency across 30 keystrokes
        latencies_ms = []
        for i in range(30):
            ch = chr(ord('a') + (i % 26)).encode()
            before_len = len(buf)
            t0 = time.perf_counter()
            os.write(master, ch)
            while time.perf_counter() - t0 < 2.0:
                if select.select([master], [], [], 0.005)[0]:
                    buf.extend(os.read(master, 65536))
                    if len(buf) > before_len:
                        break
            latencies_ms.append((time.perf_counter() - t0) * 1000.0)

        # Clear draft with Ctrl-C twice
        os.write(master, b'\x03')
        time.sleep(0.05)
        os.write(master, b'\x03')
        proc.wait(timeout=5)
        latencies_ms.sort()
        p50 = latencies_ms[len(latencies_ms) // 2]
        p95 = latencies_ms[int(len(latencies_ms) * 0.95)]
        p99 = latencies_ms[-1]
        return {
            'idleSecs': idle_secs,
            'idleRssMaxMiB': round(max(idle_rss), 2),
            'idleRssFinalMiB': round(idle_rss[-1], 2),
            'physicalFootprintMiB': round(foot, 2) if foot is not None else None,
            'idleBudgetMiB': 100.0,
            'inputLatencyP50Ms': round(p50, 2),
            'inputLatencyP95Ms': round(p95, 2),
            'inputLatencyP99Ms': round(p99, 2),
            'inputP95BudgetMs': 50.0,
            'inputP99BudgetMs': 100.0,
            'passed': max(idle_rss) <= 100.0 and p95 <= 50.0 and p99 <= 100.0,
        }
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
        os.close(master); os.close(slave)


def measure_cancel_latency(binary: Path):
    stream_started = threading.Event()
    release = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def do_POST(self):
            n = int(self.headers.get('Content-Length', '0'))
            _ = self.rfile.read(n)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            chunk = {'choices': [{'index': 0, 'delta': {'content': 'streaming...'}, 'finish_reason': None}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.flush()
            stream_started.set()
            release.wait(10)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f'http://127.0.0.1:{server.server_address[1]}/v1'

    tmp = Path(tempfile.mkdtemp(prefix='peer-adr130-cancel-'))
    ws = tmp / 'ws'; home = tmp / 'home'
    ws.mkdir(); home.mkdir()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    proc = subprocess.Popen(
        [str(binary), '--classic'],
        stdin=slave, stdout=slave, stderr=slave,
        cwd=ws, start_new_session=True,
        env={'PATH': '/nonexistent', 'HOME': str(ws), 'PEER_AGENT_HOME': str(home),
             'PEER_MODEL_API_KEY': 'k', 'PEER_MODEL_BASE_URL': base_url, 'PEER_MODEL_ID': 'm',
             'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8'},
    )
    buf = bytearray()
    try:
        deadline = time.monotonic() + 8
        while b'Peer' not in buf and time.monotonic() < deadline:
            if select.select([master], [], [], 0.02)[0]:
                buf.extend(os.read(master, 65536))
        latencies = []
        for i in range(3):
            stream_started.clear()
            release.clear()
            os.write(master, f'cancel-{i}\r'.encode())
            # Drain PTY while waiting for stream to start so macOS 1KiB PTY buffer never stalls.
            dl = time.monotonic() + 8.0
            while not stream_started.is_set() and time.monotonic() < dl:
                if select.select([master], [], [], 0.01)[0]:
                    buf.extend(os.read(master, 65536))
            if not stream_started.is_set():
                tail = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', bytes(buf)).decode('utf-8', 'replace')[-400:]
                raise AssertionError(f'stream did not start on iter {i}; tail={tail!r}')
            # Drain streaming chunk before sending Ctrl-C
            drain_end = time.monotonic() + 0.08
            while time.monotonic() < drain_end:
                if select.select([master], [], [], 0.01)[0]:
                    buf.extend(os.read(master, 65536))
            mark = len(buf)
            t0 = time.perf_counter()
            os.write(master, b'\x03')
            release.set()
            stopped = False
            while time.perf_counter() - t0 < 5.0:
                if select.select([master], [], [], 0.005)[0]:
                    buf.extend(os.read(master, 65536))
                    delta = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', bytes(buf[mark:])).decode('utf-8', 'replace')
                    if '本轮已停止' in delta or '正在停止本轮' in delta:
                        stopped = True
                        break
            assert stopped, f'cancel not observed on iter {i}'
            latencies.append((time.perf_counter() - t0) * 1000.0)
            # Wait for full settlement before starting next turn
            settle_dl = time.monotonic() + 3.0
            while time.monotonic() < settle_dl:
                if select.select([master], [], [], 0.01)[0]:
                    buf.extend(os.read(master, 65536))
                delta = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', bytes(buf[mark:])).decode('utf-8', 'replace')
                if '可继续输入' in delta:
                    break
            time.sleep(0.05)
        os.write(master, b'\x03')
        proc.wait(timeout=5)
        latencies.sort()
        return {
            'samplesMs': [round(x, 2) for x in latencies],
            'p95Ms': round(latencies[-1], 2),
            'budgetMs': 100.0,
            'passed': latencies[-1] <= 100.0,
        }
    finally:
        release.set()
        server.shutdown(); server.server_close()
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
        os.close(master); os.close(slave)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--probe', type=Path, required=True)
    parser.add_argument('--idle-secs', type=float, default=10.0)
    parser.add_argument('--soak-secs', type=int, default=20)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()

    idle_res = measure_idle_and_input_latency(args.binary.resolve(), args.idle_secs)
    cancel_res = measure_cancel_latency(args.binary.resolve())
    probe_out = subprocess.check_output(
        [str(args.probe.resolve()), '--soak-secs', str(args.soak_secs)],
        text=True,
    )
    probe_res = json.loads(probe_out)
    summary = {
        'platform': sys.platform,
        'idleAndInputLatency': idle_res,
        'cancelLatency': cancel_res,
        'workloadProbe': probe_res,
    }
    encoded = json.dumps(summary, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    print(encoded)
    assert idle_res['passed'], f'Idle/input failed: {idle_res}'
    assert cancel_res['passed'], f'Cancel failed: {cancel_res}'
