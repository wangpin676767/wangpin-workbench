'use strict';
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const locks = new Map();
function label(title) {
  let value = String(title || '新對話').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 56).replace(/[. ]+$/g, '');
  if (!value || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = '對話_' + value;
  return value;
}
async function safeDirectory(dir) {
  const absolute = path.resolve(dir);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('工作資料夾不可經過連結或一般檔案：' + cursor);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await fs.mkdir(cursor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('不安全的工作資料夾');
    }
  }
  return absolute;
}
async function organize(chat, fallback) {
  const id = String(chat.id || '');
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('無效的對話識別碼');
  const originalProject = chat.workspace?.originalProject || chat.originalProject || chat.cwd || '';
  let parent = chat.workspace?.root || originalProject || fallback;
  try { if (!(await fs.stat(parent)).isDirectory()) parent = fallback; }
  catch (error) { if (error.code !== 'ENOENT') throw error; parent = fallback; }
  if (!parent || !path.isAbsolute(parent)) throw new Error('請選擇完整的專案資料夾路徑');
  const root = path.join(parent, '對話工作區');
  const suffix = crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
  const existingMap = chat.workspace || await discover(chat, fallback);
  const expected = existingMap?.path || path.join(root, label(chat.title) + '--' + suffix);
  if (path.dirname(path.resolve(expected)) !== path.resolve(root) || path.basename(expected).indexOf('--' + suffix) < 0) throw new Error('工作資料夾位置不符合對話');
  if (expected.length > 230) throw new Error('專案路徑太長，請選擇較短的路徑');
  const prior = locks.get(expected) || Promise.resolve();
  const work = prior.catch(() => {}).then(async () => {
    await safeDirectory(expected);
    const marker = path.join(expected, '.wangpin-chat.json');
    let exists;
    try { exists = JSON.parse(await readOwned(marker)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists && exists.chatId !== id) throw new Error('資料夾已屬於另一段對話');
    if (!exists && (await fs.readdir(expected)).length) throw new Error('工作資料夾已有未識別的檔案，請勿自動合併');
    const record = { version: 1, chatId: id, title: chat.title || '新對話', originalProject, root: parent, path: expected };
    await writeOwned(marker, JSON.stringify(record, null, 2));
    await writeOwned(path.join(expected, '對話資料夾說明.txt'), `對話：${record.title}\n識別碼：${id}\n原專案：${originalProject || '未指定'}\n工作資料夾：${expected}\n此資料夾未搬移原專案檔案。\n`);
    return record;
  });
  locks.set(expected, work);
  try { return await work; } finally { if (locks.get(expected) === work) locks.delete(expected); }
}
async function discover(chat, fallback) {
  let parent = chat.workspace?.root || chat.originalProject || chat.cwd || fallback;
  try { if (!(await fs.stat(parent)).isDirectory()) parent = fallback; } catch (_) { parent = fallback; }
  const suffix = '--' + crypto.createHash('sha256').update(String(chat.id)).digest('hex').slice(0, 12);
  try {
    const root = path.join(parent, '對話工作區');
    await inspectAncestors(root);
    const names = await fs.readdir(root);
    for (const name of names) if (name.endsWith(suffix)) {
      const directory = path.join(root, name);
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const record = JSON.parse(await readOwned(path.join(directory, '.wangpin-chat.json')));
      if (record.chatId === chat.id && path.resolve(record.path) === path.resolve(directory)) return record;
    }
  } catch (_) { /* Missing map never alters an existing conversation. */ }
  return null;
}
async function inspectAncestors(dir) {
  const absolute = path.resolve(dir), parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Unsafe workspace path');
  }
}
async function ownedStat(file) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw Error('Unsafe workspace mapping file');
  return stat;
}
async function readOwned(file) {
  await ownedStat(file);
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw Error('Unsafe workspace mapping file');
    const buffer = Buffer.alloc(16385);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw Error('Workspace mapping too large');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
async function writeOwned(file, text) {
  try { await ownedStat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temporary, text, {encoding:'utf8',flag:'wx'});
  try { await fs.rename(temporary, file); } catch (error) { await fs.unlink(temporary).catch(()=>{}); throw error; }
}
module.exports = { label, organize, discover, safeDirectory };
