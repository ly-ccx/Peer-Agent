"""Static P0 inventory. Paths are repository-relative; this is not a dynamic reachability proof."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
packages = {}
for parent in ('apps', 'packages'):
    for manifest in (root / parent).glob('*/package.json'):
        meta = json.loads(manifest.read_text())
        packages[meta['name']] = {'path': str(manifest.parent.relative_to(root)), 'dependencies': sorted(meta.get('dependencies', {}))}
roots = ['@peer-agent/tui']
seen = set()
while roots:
    name = roots.pop()
    if name in seen or name not in packages:
        continue
    seen.add(name)
    roots.extend(packages[name]['dependencies'])
sources = []
digest = hashlib.sha256()
for name in sorted(seen):
    for path in sorted((root / packages[name]['path'] / 'src').rglob('*')):
        if path.suffix not in ('.ts', '.tsx', '.mjs') or '.test.' in path.name:
            continue
        relative = str(path.relative_to(root))
        body = path.read_bytes()
        digest.update(relative.encode()); digest.update(b'\0'); digest.update(body)
        imports = re.findall(r'''(?:from\s*|import\s*\(\s*)['"]([^'"\n]+)['"]''', body.decode())
        sources.append({'path': relative, 'bytes': len(body), 'lines': body.count(b'\n'), 'imports': sorted(set(imports))})
stores = root / 'packages/runtime-node/src/data-store.mjs'
artifacts = {}
for name in sorted(seen - {'@peer-agent/tui'}):
    dist = root / 'apps/tui/node_modules' / name / 'dist'
    if not dist.is_dir():
        continue
    artifact_hash = hashlib.sha256()
    for path in sorted(dist.rglob('*')):
        if path.is_file():
            artifact_hash.update(str(path.relative_to(dist)).encode())
            artifact_hash.update(b'\0'); artifact_hash.update(path.read_bytes())
    artifacts[name] = artifact_hash.hexdigest()
contract_files = [str(p.relative_to(root)) for p in (root / 'apps/tui/src').glob('cli-*.ts') if '.test.' not in p.name]
result = {
    'version': 1,
    'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'sourceGraphHash': digest.hexdigest(),
    'packages': {name: packages[name] for name in sorted(seen)}, 'sources': sources,
    'workspaceBuiltArtifactHashes': artifacts,
    'entry': 'apps/tui/src/index.tsx', 'commandFiles': sorted(contract_files),
    'storeCatalog': str(stores.relative_to(root)), 'storeCatalogHash': hashlib.sha256(stores.read_bytes()).hexdigest(),
    'runtimeEngines': ['Bun compiled executable', 'OpenTUI core/react 0.4.3', 'React 19.2.7'],
    'limitations': ['Static package dependency closure includes optional and re-exported modules; not proof that all are loaded.', 'Legacy compiled candidate resolves existing workspace dist artifacts; their hashes are recorded separately from the source graph.', 'No personal data, credentials or active user process inspection.'],
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'packages': len(seen), 'sourceFiles': len(sources), 'sourceGraphHash': digest.hexdigest()}))
