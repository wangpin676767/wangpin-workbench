"""Extract our offline installer without executing it and prove source hashes."""
import hashlib, io, json, os, struct, sys, zipfile
from pathlib import Path
from installer_payload import payload_bounds

installer, destination = map(Path, sys.argv[1:3])
data = installer.read_bytes()
offset, payload_end = payload_bounds(data)
destination.mkdir(parents=True, exist_ok=True)
base = os.path.abspath(destination)
assert not destination.is_symlink()
with zipfile.ZipFile(io.BytesIO(data[offset:payload_end])) as archive:
    for item in archive.infolist():
        resolved = os.path.abspath(os.path.join(base, item.filename))
        assert os.path.commonpath([base, resolved]) == base, item.filename
    archive.extractall(destination)
app = destination / 'resources' / 'app'
manifest = json.loads((app / 'build-manifest.json').read_text(encoding='utf-8'))
root = Path(__file__).resolve().parents[1]
for name, expected in manifest['sha256'].items():
    actual = hashlib.sha256((app / name).read_bytes()).hexdigest()
    assert actual == expected == hashlib.sha256((root / name).read_bytes()).hexdigest(), name
print(json.dumps({'version': manifest['version'], 'files': len(manifest['sha256']), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'destination': str(destination)}, ensure_ascii=False))
