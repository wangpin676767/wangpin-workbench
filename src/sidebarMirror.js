'use strict';
// 側欄管理資料夾：把 App 側欄的對話鏡像成資料夾裡的小檔案（只是捷徑，不是對話本身）。
//   App側欄\<專案>\<標題>.txt         ＝目前顯示在側欄的對話；刪掉檔案＝從側欄移除，刪掉專案資料夾＝從側欄移除專案
//   不在App側欄的對話\<專案>\<標題>.txt ＝這台電腦上有、但側欄沒顯示的對話；搬進 App側欄\<專案> 就會放回側欄
// 對話紀錄本身一律不刪；移除只是隱藏，可以把檔案搬回來復原。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const SHOWN = 'App側欄';
const OTHER = '不在App側欄的對話';
const MANIFEST = '.manifest.json';
const README = '說明.txt';
const EXT = '.txt';
const KEY_RE = /^key:\s*(\S+)\s*$/m;

function safeName(s, max = 60) {
  const out = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[. ]+$/, '');
  return out || '未命名';
}
const tag = (key) => crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 6);
const fileName = (it) => `${safeName(it.title)} ~${tag(it.key)}${EXT}`;

function content(it, shown) {
  return [
    '這是 Codex 多模型工作台側欄的對話捷徑，不是對話本身。',
    shown
      ? '刪除這個檔案＝從 App 側欄移除這段對話（對話紀錄不會被刪除，搬到「不在App側欄的對話」就能再放回來）。'
      : '把這個檔案搬進「App側欄」裡的專案資料夾，App 側欄就會在那個專案顯示這段對話。',
    '',
    `標題：${it.title || ''}`,
    `專案：${it.dir || '未指定資料夾'}`,
    `key: ${it.key}`,
    '',
  ].join('\r\n');
}

/** groups：[{ groupKey, name, dir, removable, items: [{ key, title }] }] → 資料夾名稱與檔案配置 */
function layout(groups) {
  const used = new Set();
  const folders = [];
  const files = new Map(); // 相對路徑 → { key, title, dir, folder }
  const seenKeys = new Set();
  for (const g of groups || []) {
    const base = safeName(g.name || '未指定資料夾');
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})`;
    used.add(name.toLowerCase());
    folders.push({ name, dir: g.dir || '', groupKey: g.groupKey || '', removable: !!g.removable });
    for (const it of g.items || []) {
      if (!it || !it.key || seenKeys.has(it.key)) continue;
      seenKeys.add(it.key);
      files.set(path.join(name, fileName(it)), { key: it.key, title: it.title || '', dir: g.dir || '', folder: name });
    }
  }
  return { folders, files };
}

async function readKey(file) {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const m = KEY_RE.exec(buf.slice(0, bytesRead).toString('utf8'));
      return m ? m[1] : null;
    } finally { await fh.close(); }
  } catch (error) {
    // A locked or unreadable shortcut is not evidence of a user deletion.
    throw error;
  }
}

/** 讀出某個區（App側欄／不在App側欄）裡目前的檔案：相對路徑 → key，以及存在的子資料夾 */
async function scanArea(dir) {
  const out = { exists: false, files: new Map(), folders: new Set() };
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); out.exists = true; } catch (error) { if (error.code === 'ENOENT') return out; throw error; }
  for (const e of entries) {
    if (e.isDirectory()) {
      out.folders.add(e.name);
      let inner = [];
      try { inner = await fsp.readdir(path.join(dir, e.name), { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const f of inner) {
        if (!f.isFile() || !f.name.toLowerCase().endsWith(EXT)) continue;
        const key = await readKey(path.join(dir, e.name, f.name));
        if (key) out.files.set(path.join(e.name, f.name), key);
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith(EXT) && e.name !== README) {
      const key = await readKey(path.join(dir, e.name));
      if (key) out.files.set(e.name, key);
    }
  }
  return out;
}

/**
 * 比對上次寫出的配置（manifest）與使用者手動整理後的資料夾。
 * removedKeys：從 App側欄 消失的對話；removedFolders：整個被刪掉的專案資料夾；
 * placed：被搬進（或搬到另一個）App側欄 專案資料夾的對話。
 */
function reconcile(manifest, scanned) {
  const diff = { removedKeys: [], removedFolders: [], placed: [] };
  if (!manifest || !manifest.shown || !scanned.exists) return diff;
  const folderOf = new Map();
  for (const [rel, key] of scanned.files) {
    const parts = rel.split(/[\\/]/);
    if (!folderOf.has(key)) folderOf.set(key, parts.length > 1 ? parts[0] : '');
  }
  const folders = manifest.folders || {};
  const goneFolders = new Set(Object.keys(folders).filter((name) => !scanned.folders.has(name)));
  for (const name of goneFolders) if (folders[name].removable && folders[name].dir) diff.removedFolders.push(folders[name].dir);
  for (const [key, folder] of Object.entries(manifest.shown)) {
    if (folderOf.has(key)) continue;
    if (goneFolders.has(folder) && folders[folder]?.removable) continue; // 跟著專案一起移除，對話本身不用另外隱藏
    diff.removedKeys.push(key);
  }
  for (const [key, folder] of folderOf) {
    const target = folders[folder];
    if (!target || !target.removable || !target.dir) continue; // 只有真正的專案資料夾能當放置目標
    if (manifest.shown[key] === folder) continue;
    diff.placed.push({ key, dir: target.dir });
  }
  return diff;
}
function accepted(manifest, scanned) {
  const folders = {};
  for (const [name, f] of Object.entries(manifest.folders || {})) if (scanned.folders.has(name)) folders[name] = f;
  const shown = {};
  for (const [rel, key] of scanned.files) {
    const parts = rel.split(/[\\/]/);
    const folder = parts.length > 1 ? parts[0] : '';
    if (!(key in shown)) shown[key] = folder;
  }
  return { version: 1, shown, folders };
}
const isEmptyDiff = (d) => !d.removedKeys.length && !d.removedFolders.length && !d.placed.length;

function create({ root }) {
  const shownDir = path.join(root, SHOWN);
  const otherDir = path.join(root, OTHER);
  const manifestFile = path.join(root, MANIFEST);
  const transactionFile = path.join(root, '.sync-in-progress.json');
  async function atomicWrite(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await require('./atomicRename').replace(tmp, file);
  }
  let writingUntil = 0;
  let queue = Promise.resolve();

  async function readManifest() {
    try { return JSON.parse(await fsp.readFile(manifestFile, 'utf8')); } catch { return null; }
  }

  async function writeArea(dir, plan, shown, current) {
    await fsp.mkdir(dir, { recursive: true });
    for (const f of plan.folders) await fsp.mkdir(path.join(dir, f.name), { recursive: true });
    for (const [rel, it] of plan.files) {
      const file = path.join(dir, rel);
      const text = content(it, shown);
      let same = false;
      try { same = (await fsp.readFile(file, 'utf8')) === text; } catch { /* 新檔 */ }
      if (!same) await atomicWrite(file, text);
    }
    // 只清掉自己寫的捷徑檔（有 key: 那一行）；使用者放進來的其他檔案不動
    for (const rel of current.files.keys()) {
      if (plan.files.has(rel)) continue;
      try { await fsp.unlink(path.join(dir, rel)); } catch { /* 已不在 */ }
    }
    const keep = new Set(plan.folders.map((f) => f.name));
    for (const name of current.folders) {
      if (keep.has(name)) continue;
      try { await fsp.rmdir(path.join(dir, name)); } catch { /* 不是空的就留著 */ }
    }
  }

  /**
   * 先檢查使用者有沒有手動整理過資料夾；有的話回傳差異（呼叫端套用後再呼叫一次），
   * 沒有的話照目前的側欄重寫鏡像。
   */
  function sync({ shown, others }) {
    const job = queue.then(async () => {
      const interrupted = fs.existsSync(transactionFile);
      const manifest = await readManifest();
      const scanned = await scanArea(shownDir);
      // An unfinished App write must never be interpreted as manual removals.
      const diff = interrupted ? { removedKeys: [], removedFolders: [], placed: [] } : reconcile(manifest, scanned);
      if (!isEmptyDiff(diff)) {
        // 先記住使用者整理後的樣子，下次同步才不會把同一批變動再回報一次
        await atomicWrite(manifestFile, JSON.stringify(accepted(manifest, scanned), null, 1));
        return { changed: true, diff };
      }
      writingUntil = Date.now() + 60000;
      try {
        const shownPlan = layout(shown);
        const otherPlan = layout(others);
        await fsp.mkdir(root, { recursive: true });
        await atomicWrite(transactionFile, JSON.stringify({ version: 1, startedAt: Date.now() }));
        await writeArea(shownDir, shownPlan, true, scanned);
        await writeArea(otherDir, otherPlan, false, await scanArea(otherDir));
        const next = { version: 1, shown: {}, folders: {} };
        for (const it of shownPlan.files.values()) next.shown[it.key] = it.folder;
        for (const f of shownPlan.folders) next.folders[f.name] = { dir: f.dir, removable: f.removable };
        await atomicWrite(manifestFile, JSON.stringify(next, null, 1));
        await writeReadme();
        await fsp.unlink(transactionFile);
        return { changed: false, shown: shownPlan.files.size, others: otherPlan.files.size };
      } finally { writingUntil = Date.now() + 300; }
    });
    queue = job.catch(() => {});
    return job;
  }

  async function writeReadme() {
    const text = [
      'Codex 多模型工作台：側欄管理資料夾',
      '',
      `「${SHOWN}」：目前顯示在 App 側欄的對話，一個專案一個資料夾。`,
      '  刪除對話檔案 → App 側欄移除這段對話。',
      '  刪除整個專案資料夾 → App 側欄移除這個專案（對話不會被刪除）。',
      '  把對話檔案搬到另一個專案資料夾 → App 側欄把對話移到那個專案。',
      '',
      `「${OTHER}」：這台電腦上有、但沒有顯示在 App 側欄的對話（含已移除的）。`,
      `  把檔案搬進「${SHOWN}」裡的專案資料夾 → 放回 App 側欄的那個專案。`,
      '',
      '這些 .txt 只是捷徑，對話紀錄本身不會因為刪除這裡的檔案而消失。',
      'App 開著時會自動同步；App 關著時刪除的，下次開啟會一併套用。',
      '',
    ].join('\r\n');
    let same = false;
    try { same = (await fsp.readFile(path.join(root, README), 'utf8')) === text; } catch { /* 新檔 */ }
    if (!same) await fsp.writeFile(path.join(root, README), text, 'utf8');
  }

  // 監看使用者在檔案總管的操作。App 自己寫檔期間收到的變動延到寫完再檢查，不能直接丟掉：
  // 使用者剛好在那幾秒內刪除／搬移的話會漏掉。自己寫檔引起的那一次檢查不會有差異，也不會再寫出新檔。
  function watch(onChange) {
    let timer = null;
    let watcher = null;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (Date.now() < writingUntil) later(); else { try { onChange(); } catch {} } }, 800);
    };
    try {
      fs.mkdirSync(shownDir, { recursive: true });
      watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
        if (file && String(file).replace(/\\/g, '/').startsWith(`${OTHER}/`)) return; // 不在側欄的那一區只當清單看
        if (file && (path.basename(String(file)) === MANIFEST || path.basename(String(file)) === '.sync-in-progress.json' || String(file).endsWith('.tmp'))) return;
        later();
      });
      watcher.on('error', () => { try { watcher.close(); } catch {} });
    } catch { /* 不支援遞迴監看就只在下次同步時檢查 */ }
    return { close: () => { clearTimeout(timer); try { watcher?.close(); } catch { /* */ } } };
  }

  return { root, shownDir, otherDir, sync, watch };
}

module.exports = { create, layout, reconcile, scanArea, safeName, fileName, SHOWN, OTHER };
