const path = require('path');
const { fileURLToPath } = require('url');
const fs = require('fs').promises;

function classify(raw) {
  if (typeof raw !== 'string' || raw.length > 32768 || /[\u0000-\u001f]/.test(raw)) throw new Error('無效的連結');
  let value = raw.trim();
  if (/^https?:\/\//i.test(value)) { const url = new URL(value); return { kind: 'web', url: url.href }; }
  if (/^sandbox:/i.test(value)) return { kind: 'unavailable', message: '這是來源平台的暫存檔連結，無法直接在本機存取；請在來源平台下載，或提供 HTTP／HTTPS 下載網址。' };
  if (/^file:/i.test(value)) {
    const url = new URL(value);
    if (url.hostname && url.hostname !== 'localhost') throw new Error('不支援網路分享位置的檔案連結');
    value = fileURLToPath(url);
  } else {
    try { value = decodeURIComponent(value); } catch { throw new Error('連結編碼無效'); }
  }
  // A leading slash is commonly added by Markdown frontends to a Windows drive path.
  value = value.replace(/^\/([a-z]:[\\/])/i, '$1');
  // :line and :line:column are editor hints, not part of an artifact filename.
  value = value.replace(/:(\d+)(?::\d+)?$/, '');
  if (/^\\\\|^\/\/|\\[?.]\\/.test(value)) throw new Error('不支援網路或裝置路徑');
  if (!/^[a-z]:[\\/]/i.test(value) && !(process.platform !== 'win32' && value.startsWith('/'))) throw new Error('此連結不是網址或完整本機檔案路徑');
  if (/[\u0000-\u001f]/.test(value) || (process.platform === 'win32' && value.slice(2).includes(':'))) throw new Error('無效的檔案路徑');
  return { kind: 'file', path: path.resolve(value) };
}

async function open(raw, { dialog, shell, window }) {
  const target = classify(raw);
  if (target.kind === 'unavailable') return { ok: false, message: target.message };
  if (target.kind === 'web') { await shell.openExternal(target.url); return { ok: true, kind: 'web' }; }
  let info;
  try { info = await fs.stat(target.path); } catch (e) { if (e.code === 'ENOENT') throw new Error('找不到這個檔案；它可能在另一台電腦或已被移動。'); throw e; }
  if (info.isDirectory()) { const error = await shell.openPath(target.path); if (error) throw new Error(error); return { ok: true, kind: 'folder' }; }
  if (!info.isFile()) throw new Error('連結不是一般檔案');
  if (/\.(?:html?|pdf|png|jpe?g|gif|webp|bmp|tiff?|avif|svg|ico|hei[cf])$/i.test(target.path)) {
    const error = await shell.openPath(target.path);
    if (error) throw new Error(error);
    return { ok: true, kind: 'file' };
  }
  const picked = await dialog.showSaveDialog(window, { title: '儲存聊天中的檔案', defaultPath: path.basename(target.path), buttonLabel: '儲存' });
  if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
  if (path.resolve(picked.filePath).toLowerCase() !== target.path.toLowerCase()) await fs.copyFile(target.path, picked.filePath);
  shell.showItemInFolder(picked.filePath);
  return { ok: true, kind: 'file', message: '檔案已儲存，並在檔案總管中顯示。' };
}
module.exports = { classify, open };
