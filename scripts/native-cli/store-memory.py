"""Five native bounded-Store probes, not full CLI memory acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import time
from baseline import process_tree


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(65536), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--scenario', choices=['goal', 'transcript'], default='goal')
    args = parser.parse_args()
    binary = args.binary.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    fixture = Path(tempfile.mkdtemp(prefix=f'peer-native-{args.scenario}-memory-'))
    (fixture / '.native-cli-fixture').write_text('synthetic')
    if args.scenario == 'goal':
        (fixture / 'goal-plans').mkdir()
        source = fixture / 'goal-plans/p.json'
        with source.open('wb') as target:
            target.write(b'{"planId":"p","conversationId":"c","status":"paused","trace":"')
            block = b'x' * 65536
            for _ in range(2048):
                target.write(block)
            target.write(b'","delegationOrigin":{"workspaceId":"w","sessionId":"s"}}')
    else:
        (fixture / 'conversations').mkdir()
        source = fixture / 'conversations/p.jsonl'
        row = json.dumps({'id': 'synthetic', 'role': 'assistant', 'content': 'x' * 960}, separators=(',', ':')).encode() + b'\n'
        block = row * 64
        with source.open('wb') as target:
            for _ in range((1024 * 1024 * 1024 + len(block) - 1) // len(block)):
                target.write(block)
    original = sha(source)
    runs = []
    for number in range(5):
        started = time.monotonic()
        child = subprocess.Popen([str(binary)], env={'PATH': '/nonexistent', 'PEER_NATIVE_CONFORMANCE_ROOT': str(fixture)},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        curve = []
        reason = None
        try:
            while child.poll() is None:
                rows = process_tree(child.pid)
                curve.append({'seconds': time.monotonic() - started, 'processes': rows})
                if sum(row['rssKiB'] for row in rows) > 512 * 1024:
                    reason = 'measurement_safety_ceiling'
                    child.kill()
                if time.monotonic() - started > 30:
                    reason = 'measurement_deadline'
                    child.kill()
                time.sleep(0.02)
            output, error = child.communicate(timeout=2)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=2)
        (args.output / f'run-{number}.json').write_text(json.dumps(curve, indent=2) + '\n')
        (args.output / f'run-{number}.stderr').write_bytes(error)
        peak = max((sum(row['rssKiB'] * 1024 for row in sample['processes']) for sample in curve), default=0)
        footprint = max((sum(row.get('physicalFootprintBytes', 0) for row in sample['processes']) for sample in curve), default=0)
        facts = json.loads(output) if child.returncode == 0 else None
        passed = reason is None and child.returncode == 0 and peak > 0 and facts['sourceBytes'] == source.stat().st_size
        if passed and args.scenario == 'goal':
            passed = facts['selectedBytes'] < 8192
        elif passed:
            passed = facts['rows'] == 80 and facts['hasOlder'] and facts['scannedBytes'] < 128 * 1024
        passed = passed and all(len(sample['processes']) <= 1 for sample in curve)
        runs.append({'run': number, 'exitCode': child.returncode, 'passed': passed, 'reason': reason,
                     'peakRssBytes': peak, 'peakPhysicalFootprintBytes': footprint or None, 'facts': facts})
    report = {'scenario': f'raw {args.scenario} read only', 'fixtureRoot': str(fixture), 'sourceBytes': source.stat().st_size,
              'sourceSha256': original, 'sourceUnchanged': sha(source) == original, 'binarySha256': sha(binary), 'runs': runs,
              'limits': 'No canonical Goal normalization, Runtime/tool execution, Ratatui viewport or full CLI memory/soak acceptance.'}
    (args.output / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'sourceBytes': report['sourceBytes'], 'sourceUnchanged': report['sourceUnchanged'], 'runs': runs, 'output': str(args.output)}))
    if not report['sourceUnchanged'] or not all(run['passed'] for run in runs):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
