"""Build the optional x64 Windows Node-API accelerator; no Rust needed at runtime."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, sys, tomllib

root = pathlib.Path(__file__).resolve().parents[1]
crate = root / 'native/chat-accelerator'
triple = 'x86_64-pc-windows-msvc'
parser = argparse.ArgumentParser()
parser.add_argument('--toolchain-dir', type=pathlib.Path)
args = parser.parse_args()
env = os.environ.copy()
if args.toolchain_dir:
    env['CARGO_HOME'] = str(args.toolchain_dir / 'cargo')
    env['RUSTUP_HOME'] = str(args.toolchain_dir / 'rustup')
    cargo = args.toolchain_dir / 'cargo' / 'bin' / 'cargo.exe'
else:
    cargo = shutil.which('cargo')
if not cargo:
    sys.exit('Install Rust with the MSVC x64 toolchain and Visual Studio C++ Build Tools first.')
env['CARGO_TARGET_DIR'] = str(crate / 'target')
flags = ['-C', 'target-feature=+crt-static']
# Remove build-machine roots from public native artifacts, including dependency panics.
for prefix, label in [(root, '/source'), (pathlib.Path(env.get('CARGO_HOME', pathlib.Path.home()/'.cargo')), '/cargo'), (pathlib.Path(env.get('RUSTUP_HOME', pathlib.Path.home()/'.rustup')), '/rustup')]:
    for spelling in {str(prefix.resolve()), prefix.resolve().as_posix()}:
        flags.append('--remap-path-prefix='+spelling+'='+label)
env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(flags)
subprocess.run([str(cargo), 'build', '--release', '--locked', '--target', triple],
               cwd=crate, env=env, stdin=subprocess.DEVNULL, check=True)
source = crate / 'target' / triple / 'release/wangpin_chat_accelerator.dll'
target = root / 'src/native/chat-accelerator.win32-x64.node'
target.parent.mkdir(exist_ok=True)
shutil.copy2(source, target)
inputs = [pathlib.Path(__file__).resolve(), crate / 'Cargo.toml', crate / 'Cargo.lock', crate / 'build.rs', *sorted((crate / 'src').rglob('*.rs'))]
stamp = {'target': triple, 'rustflags': ['-C','target-feature=+crt-static','--remap-path-prefix=<source,cargo,rustup>'], 'binarySha256': hashlib.sha256(target.read_bytes()).hexdigest(),
         'sources': {str(p.relative_to(root)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}}
(target.parent / 'build.json').write_text(json.dumps(stamp, indent=2) + '\n', encoding='utf-8')
registry = pathlib.Path(env.get('CARGO_HOME', pathlib.Path.home() / '.cargo')) / 'registry/src'
notices = ['Third-party components of wangpin-chat-accelerator.\nFull dependency versions/checksums are recorded in Cargo.lock.\n']
for package in tomllib.loads((crate / 'Cargo.lock').read_text(encoding='utf-8'))['package']:
    if 'source' not in package: continue
    matches = list(registry.glob('*/' + package['name'] + '-' + package['version']))
    # Lockfiles include other-platform dependencies which are not compiled or shipped.
    if not matches: continue
    dependency = matches[0]
    metadata = tomllib.loads((dependency / 'Cargo.toml').read_text(encoding='utf-8'))['package']
    notices.append('\n=== ' + package['name'] + ' ' + package['version'] + ' (' + metadata.get('license', '') + ') ===\n')
    licenses = sorted({*dependency.glob('LICENSE*'), *dependency.glob('COPYING*')})
    if package['name'] == 'zstd-sys': licenses += list((dependency / 'zstd').glob('LICENSE*'))
    for license_file in licenses:
        if license_file.is_file(): notices.append(license_file.name + '\n' + license_file.read_text(encoding='utf-8', errors='replace'))
(target.parent / 'THIRD_PARTY_NOTICES.txt').write_text('\n'.join(notices), encoding='utf-8')
print(target)
