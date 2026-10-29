from pathlib import Path
import os, zipfile, subprocess, struct, shutil, hashlib, json, re
root = Path(__file__).resolve().parents[1]
def public_file(p):
 return p.suffix.lower() not in {'.bak','.tmp','.log','.orig','.pyc'} and '__pycache__' not in p.parts and not p.name.endswith('~')

# Prevent shipping a stale native binary after its Rust sources change.
if (root/'native/chat-accelerator').is_dir():
 native_stamp = json.loads((root/'src/native/build.json').read_text(encoding='utf-8'))
 native_crate = root/'native/chat-accelerator'
 native_inputs = [root/'build/build_native.py', native_crate/'Cargo.toml', native_crate/'Cargo.lock', native_crate/'build.rs', *sorted((native_crate/'src').rglob('*.rs'))]
 assert set(native_stamp['sources']) == {str(p.relative_to(root)).replace('\\','/') for p in native_inputs}, 'Native source inventory changed; rebuild accelerator'
 assert hashlib.sha256((root/'src/native/chat-accelerator.win32-x64.node').read_bytes()).hexdigest() == native_stamp['binarySha256'], 'Rebuild the native accelerator'
 for name, expected in native_stamp['sources'].items():
  assert hashlib.sha256((root/name).read_bytes()).hexdigest() == expected, 'Rebuild native accelerator: '+name
EXE_NAME = 'WangpinMultiOpenSource.exe'
ELECTRON_EXES = [EXE_NAME, 'electron.exe', 'Codex Multi.exe', '王品工作台.exe']

def runtime_exe(d):
 for n in ELECTRON_EXES:
  if (d/n).is_file(): return d/n
 return None

def find_runtime():
 cands = []
 if os.environ.get('ELECTRON_RUNTIME_DIR'): cands.append(Path(os.environ['ELECTRON_RUNTIME_DIR']))
 cands.append(root/'node_modules'/'electron'/'dist')
 for c in cands:
  if runtime_exe(c) and (c/'resources').is_dir(): return c
 raise SystemExit('找不到 Electron 執行環境；請設定 ELECTRON_RUNTIME_DIR 或執行 npm i -D electron。試過：' + '、'.join(map(str, cands)))

original = find_runtime()
exe = runtime_exe(original)
print('runtime', original)
out = root/'dist'; out.mkdir(exist_ok=True)
stub = out/'setup-stub.exe'
csc = r'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
version = json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
if not re.fullmatch(r'\d+\.\d+\.\d+', version): raise ValueError('Invalid installer version')
source = out/'Setup.generated.cs'
source.write_text((root/'build/Setup.cs').read_text(encoding='utf-8').replace('@APP_VERSION@', version), encoding='utf-8-sig')
subprocess.run([csc,'/nologo','/target:winexe','/platform:x64','/optimize+',f'/out:{stub}',f'/win32icon:{root / "build/icon.ico"}','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll','/reference:Microsoft.CSharp.dll',str(source)],check=True)
manifest = {'version': json.loads((root/'package.json').read_text(encoding='utf-8'))['version'], 'sha256': {str(p.relative_to(root)).replace('\\','/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((root/'src').rglob('*')) if p.is_file() and public_file(p)}}
manifest_text = json.dumps(manifest, indent=2, ensure_ascii=False)
(out/'build-manifest.json').write_text(manifest_text, encoding='utf-8')
payload = out/'payload.zip'
with zipfile.ZipFile(payload,'w',zipfile.ZIP_DEFLATED,compresslevel=5) as z:
 for p in original.rglob('*'):
  if not p.is_file(): continue
  rel=p.relative_to(original)
  if rel.parts[0]=='resources' or p.name=='Uninstall.exe': continue
  if p == exe: rel = Path(EXE_NAME)
  elif p.name in ELECTRON_EXES: continue
  z.write(p,str(rel))
 for name in ['src','node_modules','build']:
  for p in (root/name).rglob('*'):
   if name=='node_modules' and p.relative_to(root/name).parts[0] not in {'dompurify','fzstd','marked','sql.js','ws'}: continue
   if p.is_file() and public_file(p) and (name!='build' or p.suffix in ['.ico','.png']): z.write(p,str(Path('resources/app')/p.relative_to(root)))
 z.write(root/'package.json','resources/app/package.json')
 for extra in ['THIRD_PARTY_NOTICES.md','LICENSE','README.md']:
  if (root/extra).is_file(): z.write(root/extra,'resources/app/'+extra)
 z.writestr('resources/app/build-manifest.json', manifest_text)
 z.write(stub,'Uninstall.exe')
setup=out/f"wangpin-Setup-開源版本-{manifest['version']}.exe"
with setup.open('wb') as f:
 with stub.open('rb') as source: shutil.copyfileobj(source,f)
 offset=f.tell()
 with payload.open('rb') as source: shutil.copyfileobj(source,f)
 f.write(struct.pack('<q',offset)+b'CMZIP170')
digest=hashlib.sha256(setup.read_bytes()).hexdigest()
(out/'SHA256.txt').write_text(digest+'  '+setup.name+'\n')
print(f'{setup}\n{setup.stat().st_size} bytes\nSHA256 {digest}')
