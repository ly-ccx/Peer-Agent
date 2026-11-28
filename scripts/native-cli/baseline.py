"""Measure an explicitly supplied legacy CLI in a credential-free fixture PTY.

This measures persisted-history rendering, not live model/tool execution or the
user's 8.27 GB incident. Every run keeps its curve, terminal bytes and exit status.
"""
import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


class RusageInfoV2(ctypes.Structure):
    # Darwin SDK sys/resource.h, RUSAGE_INFO_V2. Query only our owned children.
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        'user_time', 'system_time', 'pkg_idle_wkups', 'interrupt_wkups', 'pageins',
        'wired_size', 'resident_size', 'phys_footprint', 'proc_start_abstime', 'proc_exit_abstime',
        'child_user_time', 'child_system_time', 'child_pkg_idle_wkups', 'child_interrupt_wkups',
        'child_pageins', 'child_elapsed_abstime', 'diskio_bytesread', 'diskio_byteswritten')]


def memory_detail(pid):
    if sys.platform == 'darwin':
        info = RusageInfoV2()
        lib = ctypes.CDLL('/usr/lib/libproc.dylib')
        result = lib.proc_pid_rusage(ctypes.c_int(pid), ctypes.c_int(2), ctypes.byref(info))
        return {'physicalFootprintBytes': info.phys_footprint, 'residentBytes': info.resident_size} if result == 0 else {}
    if sys.platform.startswith('linux'):
        try:
            for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
                if line.startswith('Pss:'):
                    return {'pssBytes': int(line.split()[1]) * 1024}
        except (OSError, ValueError):
            pass
    return {}


def process_tree(pid):
    output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,comm='], text=True)
    rows = []
    for line in output.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            rows.append((int(parts[0]), int(parts[1]), int(parts[2]), Path(parts[3]).name))
    selected = {pid}
    while True:
        children = {p for p, parent, _, _ in rows if parent in selected}
        expanded = selected | children
        if expanded == selected:
            break
        selected = expanded
    return [{'pid': p, 'ppid': parent, 'rssKiB': rss, 'name': name, **memory_detail(p)} for p, parent, rss, name in rows if p in selected]


def run(binary, fixture, surface, seconds, directory):
    directory.mkdir(parents=True)
    (directory / 'isolated-os-home').mkdir()
    pid, master = pty.fork()
    if pid == 0:
        env = {
            'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(directory / 'isolated-os-home'),
            'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'COLORTERM': 'truecolor',
            'PEER_AGENT_HOME': fixture['dataHome'], 'PEER_USER_DATA_PATH': fixture['dataHome'],
            'PEER_WORKSPACE_ROOT': fixture['workspace'],
            'PEER_AGENT_NO_UPDATE_CHECK': '1',
        }
        os.chdir(fixture['workspace'])
        argv = [str(binary)] + (['--classic'] if surface == 'classic' else [])
        os.execve(binary, argv, env)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    began = time.monotonic()
    requested_seconds = seconds
    curve, capture, total_bytes = [], bytearray(), 0
    next_sample, interrupted, signalled, reaped, status = 0, False, False, False, None
    ceiling_reached = False
    opened_picker, sent_picker_key, resumed, saw_content, second_interrupt = False, False, False, False, False
    def send(data):
        try:
            os.write(master, data)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
    while not reaped:
        elapsed = time.monotonic() - began
        if surface == 'classic' and fixture['rounds'] and elapsed >= 1 and not opened_picker:
            send(b'\x18'); opened_picker = True
        if opened_picker and elapsed >= 1.3 and not sent_picker_key:
            send(b'l'); sent_picker_key = True
        if sent_picker_key and elapsed >= 2.3 and not resumed:
            send(b'\r'); resumed = True
        if elapsed >= next_sample:
            processes = process_tree(pid)
            curve.append({'atSeconds': elapsed, 'processes': processes, 'treeRssKiB': sum(p['rssKiB'] for p in processes)})
            for metric in ('physicalFootprintBytes', 'pssBytes'):
                if processes and all(metric in p for p in processes):
                    curve[-1][metric] = sum(p[metric] for p in processes)
            if curve[-1]['treeRssKiB'] > 2 * 1024 * 1024:
                ceiling_reached = True
                seconds = min(seconds, elapsed)
            next_sample = elapsed + 0.25
        if elapsed >= seconds and not interrupted:
            send(b'\x03'); interrupted = True
        if elapsed >= seconds + 1 and not second_interrupt:
            send(b'\x03'); second_interrupt = True
        if elapsed >= seconds + 3 and not signalled:
            os.killpg(pid, signal.SIGTERM); signalled = True
        if elapsed >= seconds + 6:
            os.killpg(pid, signal.SIGKILL)
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                data = os.read(master, 65536)
                saw_content = saw_content or b'Synthetic baseline' in data
                total_bytes += len(data)
                capture.extend(data[:max(0, 2 * 1024 * 1024 - len(capture))])
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        got, status = os.waitpid(pid, os.WNOHANG)
        reaped = got == pid
    os.close(master)
    (directory / 'terminal.bin').write_bytes(capture)
    result = {
        'surface': surface, 'secondsRequested': requested_seconds, 'elapsedSeconds': time.monotonic() - began,
        'exitCode': os.waitstatus_to_exitcode(status), 'forcedTermination': signalled,
        'safetyCeilingReached': ceiling_reached,
        'syntheticContentRendered': saw_content,
        'terminalBytes': total_bytes, 'capturedBytes': len(capture), 'curve': curve,
        'peakTreeRssKiB': max((p['treeRssKiB'] for p in curve), default=0),
        'peakPhysicalFootprintBytes': max((p.get('physicalFootprintBytes', 0) for p in curve), default=0) or None,
        'peakPssBytes': max((p.get('pssBytes', 0) for p in curve), default=0) or None,
        'fixtureHash': fixture['fixtureHash'], 'contentBytes': fixture['contentBytes'],
        'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
        'scope': 'Synthetic persisted-history rendering, credential-free, no model/tool execution; not exact incident reproduction.',
    }
    (directory / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--runs', type=int, default=5)
    parser.add_argument('--seconds', type=float, default=8)
    parser.add_argument('--surface', choices=['all', 'classic', 'bot'], default='all')
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text())
    if fixture.get('synthetic') is not True:
        raise SystemExit('Only a generated synthetic fixture is admitted.')
    for field in ('dataHome', 'workspace'):
        Path(fixture[field]).resolve().relative_to(args.fixture.resolve().parent)
    results = []
    for surface in (('classic', 'bot') if args.surface == 'all' else (args.surface,)):
        for index in range(args.runs):
            result = run(args.binary.resolve(), fixture, surface, args.seconds, args.output / f'{surface}-{index + 1}')
            results.append(result)
            print(json.dumps({k: result[k] for k in ('surface', 'exitCode', 'peakTreeRssKiB', 'terminalBytes', 'forcedTermination')}), flush=True)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
    if any(r['exitCode'] != 0 or r['forcedTermination'] or r['safetyCeilingReached'] or r['terminalBytes'] < 1000
           or fixture['rounds'] > 0 and not r['syntheticContentRendered'] for r in results):
        raise SystemExit('Baseline has an unsuccessful or non-rendering run; retained, not accepted.')
