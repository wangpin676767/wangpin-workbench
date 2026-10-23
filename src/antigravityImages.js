'use strict';
const fs = require('fs');
const path = require('path');
const attachments = require('./attachments');
const LIMIT = 10 * 1024 * 1024;
function canonical(file) {
  const value = fs.realpathSync.native(file);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
function validate(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size || stat.size > LIMIT) throw new Error('圖片必須是小於 10 MB 的檔案');
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(12);
  try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const valid = head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) || /^GIF8[79]a/.test(head.toString('ascii')) ||
    (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP');
  if (!valid) throw new Error('圖片內容無法辨識；請重新加入 PNG、JPEG、GIF 或 WebP 圖片');
  return canonical(file);
}
function collect(history, current, directory) {
  const entries = [];
  for (const [i, message] of (history || []).entries()) {
    for (const item of message.attachments || []) if (item?.mime?.startsWith('image/')) entries.push({ item, turn: i + 1, current: false });
  }
  for (const item of current || []) if (item?.mime?.startsWith('image/')) entries.push({ item, current: true });
  return entries.map(({ item, ...info }, index) => {
    const file = attachments.imagePaths([item], directory)[0];
    validate(file);
    return { path: fs.realpathSync.native(file), name: item.name || '圖片', index: index + 1, ...info };
  });
}
function instruction(images) {
  if (!images?.length) return '';
  return `\n\n（附件圖片：以下是這段對話的實際圖片檔案。先用 view_file 的 AbsolutePath 讀取需要分析的圖片，工具會提供像素；不可只根據檔名或文字標記猜測。歷史圖片也可用來回答追問。若工具回報無法讀取，明確告知使用者，不能聲稱已看過。）\n${JSON.stringify(images.map(({ path, name, index, turn, current }) => ({ index, name, AbsolutePath: path, source: current ? '本回合' : `歷史訊息 ${turn}` })), null, 2)}`;
}
function reader(images, cancelled = () => false) {
  const allowed = new Set(images.map(image => validate(image.path)));
  return call => {
    if (cancelled()) return { decision: 'deny', reason: '這回合已停止。' };
    if (call?.name === 'finish') return { decision: 'allow' };
    if (call?.name === 'view_file' && typeof call.args?.AbsolutePath === 'string' && path.isAbsolute(call.args.AbsolutePath)) {
      try {
        if (allowed.has(validate(call.args.AbsolutePath))) return { decision: 'allow' };
      } catch { /* Unreadable or replaced attachment cannot grant access. */ }
    }
    return { decision: 'deny', reason: '僅聊天只能查看這段對話已附加的圖片；其他檔案、指令及寫入操作未獲授權。' };
  };
}
module.exports = { collect, instruction, reader, validate, canonical };
