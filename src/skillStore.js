'use strict';
// Explicit imports only. Markdown is snapshotted as instructions, never executed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 64;
const BUILTIN_NAMES = Object.freeze({ ragthoven: 'RAGthoven', primeAgent: 'Prime Agent', zenith: 'Zenith', scrapling: 'Scrapling', searxng: 'SearXNG' });
const SOURCES = { ragthoven: ['ragthoven.js','ragthoven_worker.py','vendor/ragthoven/NOTICE.md','vendor/ragthoven/LICENSE','vendor/ragthoven/mwahaha_tools.py','vendor/ragthoven/base_tools.py','vendor/ragthoven/joke_summaries.tsv'], primeAgent: ['primeAgent.js','primeFallback.js'], zenith: ['zenithPatch.js', 'zenithRuntimePatch.js', 'zenithModelProxy.js'], scrapling: ['extensions.js'], searxng: ['searxng.js','searxng_launcher.py'] };
function boundedRead(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('skill 檔案必須小於或等於 256 KiB');
  const buffer = fs.readFileSync(file);
  if (buffer.length > MAX_BYTES) throw new Error('skill 檔案超過 256 KiB');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
}
function within(root, file) {
  const actual = fs.realpathSync(file);
  const rel = path.relative(root, actual);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('skill 連結不可指向匯入資料夾以外');
  return actual;
}
function markdownName(content, file) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const name = front && /^name:\s*(.+?)\s*$/m.exec(front[1]);
  return String(name ? name[1].replace(/^(['"])([\s\S]*)\1$/, '$2') : path.basename(file, path.extname(file)) === 'SKILL' ? path.basename(path.dirname(file)) : path.basename(file, path.extname(file))).slice(0, 160);
}
function importPath(input) {
  const requested = path.resolve(String(input || ''));
  const stat = fs.statSync(requested);
  const root = fs.realpathSync(stat.isDirectory() ? requested : path.dirname(requested));
  const result = { builtins: [], prompts: [] };
  let entries = 0;
  let scanned = 0;
  const visited = new Set();
  function add(file, depth) {
    if (++scanned > 512) throw new Error('skill 資料夾項目太多，請選擇個別套件');
    if (depth > 2) throw new Error('skill 資料夾層級太深');
    const real = within(root, file);
    if (visited.has(real)) return;
    visited.add(real);
    const info = fs.statSync(real);
    if (info.isDirectory()) {
      const manifest = path.join(real, 'skill.json');
      if (fs.existsSync(manifest)) {
        const config = JSON.parse(boundedRead(within(root, manifest)));
        if (config.type !== 'wangpin-builtin' || !Object.hasOwn(BUILTIN_NAMES, config.id)) throw new Error('不支援的王品 skill 套件');
        if (++entries > MAX_ENTRIES) throw new Error('一次最多載入 64 個 skill');
        if (!result.builtins.includes(config.id)) result.builtins.push(config.id);
        return;
      }
      const skill = path.join(real, 'SKILL.md');
      if (fs.existsSync(skill)) { add(skill, depth + 1); return; }
      for (const child of fs.readdirSync(real, { withFileTypes: true })) {
        if (child.name.startsWith('.')) continue;
        const target = path.join(real, child.name);
        if (child.isSymbolicLink()) within(root, target);
        if (child.isDirectory() || child.isSymbolicLink() || /\.md$/i.test(child.name)) add(target, depth + 1);
      }
      return;
    }
    if (!info.isFile() || !/\.md$/i.test(real)) throw new Error('請選擇 .md 或 skill 套件資料夾');
    if (++entries > MAX_ENTRIES) throw new Error('一次最多載入 64 個 skill');
    const content = boundedRead(real);
    if (!content.trim()) throw new Error('skill Markdown 內容為空');
    const id = `prompt_${crypto.createHash('sha256').update(real.toLowerCase()).digest('hex').slice(0, 20)}`;
    result.prompts.push({ id, kind: 'prompt', name: markdownName(content, real), content, sourcePath: real });
  }
  add(requested, 0);
  if (!entries) throw new Error('找不到 .md 或王品 skill 套件');
  return result;
}
function exportBuiltins(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const root = fs.realpathSync(destination);
  const exported = [];
  const writeNew = (file, content) => { try { fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; } };
  for (const [id, name] of Object.entries(BUILTIN_NAMES)) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    within(root, dir);
    writeNew(path.join(dir, 'skill.json'), `${JSON.stringify({ type: 'wangpin-builtin', version: 1, id, name }, null, 2)}\n`);
    writeNew(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n\n這是王品工作台的工具／程式套件，不是只有 Prompt 的 skill。\n在工作台的 skill 選單按「載入 skill」並選擇這個資料夾即可加入。\n\nskill.json 是啟用已安裝引擎的識別資料；本資料夾不會自行執行程式。實際功能仍由王品工作台內建適配器、既有的 Python／Node／MCP 或外部 CLI 執行。所需執行環境與模型設定請在工作台的能力設定內查看。\n\nsource-reference 只有隨 App 發布的適配器原始碼參考，不含個人帳號、登入資料、對話或設定，不能當作完整獨立執行包。\n`);
    const references = SOURCES[id].filter(name => fs.existsSync(path.join(__dirname, name)));
    if (references.length) {
      const refDir = path.join(dir, 'source-reference');
      fs.mkdirSync(refDir, { recursive: true });
      within(root, refDir);
      for (const file of references) {
        const target=path.join(refDir,file);
        fs.mkdirSync(path.dirname(target),{recursive:true});within(root,path.dirname(target));
        writeNew(target,fs.readFileSync(path.join(__dirname,file),'utf8'));
      }
    }
    exported.push({ id, name, path: dir });
  }
  return exported;
}
module.exports = { importPath, exportBuiltins, BUILTIN_NAMES, MAX_BYTES, MAX_ENTRIES };
