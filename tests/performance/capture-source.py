"""Capture repository-only benchmark provenance; never inspect an app profile."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parents[2]
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
files = []
for folder in ['src/main', 'src/shared', 'src/preload', 'tests/performance']:
    files.extend(p for p in (root / folder).rglob('*') if p.is_file())
for name in ['resources/database-worker.cjs', 'package.json', 'package-lock.json',
             'tsconfig.node.json', 'src/renderer/src/screens/Takes.tsx',
             'src/renderer/src/strategies/owned-takes.ts', 'tests/unit/owned-takes.test.ts']:
    files.append(root / name)
hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in sorted(files)}
if len(sys.argv) > 2 and sys.argv[2] == '--verify':
    original = json.loads((output / 'source-manifest.json').read_text())['sha256']
    changed = sorted(k for k in hashes.keys() | original.keys() if hashes.get(k) != original.get(k))
    (output / 'source-verification.json').write_text(json.dumps({'unchanged': not changed, 'changed': changed}, indent=2) + '\n')
    if changed:
        raise SystemExit('Benchmark inputs changed: ' + ', '.join(changed))
    print('Benchmark source hashes unchanged.')
else:
    if (output / 'source-manifest.json').exists():
        raise SystemExit('Use a new results directory.')
    git = lambda *args: subprocess.check_output(['git', *args], cwd=root, text=True)
    lock = json.loads((root / 'package-lock.json').read_text())
    manifest = {'revision': git('rev-parse', 'HEAD').strip(), 'status': git('status', '--short'),
                'pgliteVersion': lock['packages']['node_modules/@electric-sql/pglite']['version'],
                'sha256': hashes}
    (output / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    with tarfile.open(output / 'source.tar.gz', 'w:gz') as archive:
        for path in sorted(files):
            archive.add(path, arcname=str(path.relative_to(root)), recursive=False)
    print(output)
