const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const TEXT = new Set('.txt .md .csv .tsv .json .jsonl .js .jsx .ts .tsx .py .html .css .xml .yaml .yml .toml .ini .log .sql .sh .ps1 .c .cpp .h .java .rs .go .srt'.split(' '));
const MAX_SIZE = 600 * 1024 * 1024;
function stageImage(bytes, directory, name = '貼上的圖片.png') {
  const data = Buffer.from(bytes);
  if (!data.length || data.length > MAX_SIZE) throw new Error('圖片必須小於 600 MB');
  let ext;
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ext = '.png';
  else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) ext = '.jpg';
  else if (/^GIF8[79]a/.test(data.subarray(0, 6).toString('ascii'))) ext = '.gif';
  else if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') ext = '.webp';
  else throw new Error('剪貼簿內容不是支援的圖片');
  const id = crypto.randomUUID(); const dest = path.join(directory, id + ext);
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(dest, data);
  return { id, name: path.basename(name, path.extname(name)) + ext, size: data.length, mime: IMAGE[ext], path: dest, data: data.toString('base64') };
}
function stage(file, directory) {
  const ext = path.extname(file).toLowerCase();
  const size = fs.statSync(file).size;
  if (size > MAX_SIZE) throw new Error(`${path.basename(file)} 超過 600 MB`);
  if (!IMAGE[ext] && !TEXT.has(ext) && ext !== '.pdf') throw new Error(`不支援 ${ext || '此'} 格式；請使用圖片、PDF、文字或程式碼檔案。`);
  const data = fs.readFileSync(file);
  const id = crypto.randomUUID();
  fs.mkdirSync(directory, { recursive: true });
  const dest = path.join(directory, id + ext);
  fs.writeFileSync(dest, data);
  const item = { id, name: path.basename(file), size, mime: IMAGE[ext] || (ext === '.pdf' ? 'application/pdf' : 'text/plain'), path: dest };
  if (item.mime === 'text/plain') {
    item.text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (item.text.includes('\0')) throw new Error('檔案不是 UTF-8 文字');
    if (item.text.length > 200000) throw new Error('文字附件最多 200,000 字元');
  } else item.data = data.toString('base64');
  return item;
}
function textWithFiles(text, items) {
  const list = items || [];
  const imageTotal = list.filter((a) => a?.mime?.startsWith('image/')).length;
  let imageIndex = 0;
  const videos = new Map(), audios = new Map();
  for (const a of list) {
    if (a?.video && !videos.has(a.video.name)) videos.set(a.video.name, a.video);
    if (a?.audio && !audios.has(a.audio.name)) audios.set(a.audio.name, a.audio);
  }
  const summary = [...videos.values()].map(v => {
    if (!v.kind) return `\n[影片 ${JSON.stringify(v.name)}：以下圖片是影片的取樣影格，依時間順序排列並標示時間；影片長 ${Number(v.duration).toFixed(2)} 秒。僅分析這些取樣畫面，不含音訊，也不代表已看過完整影片。]`;
    const audio = audios.get(v.name);
    const step = v.dense ? Number(v.duration) / v.dense : 0;
    return `\n[影片 ${JSON.stringify(v.name)}：長 ${Number(v.duration).toFixed(2)} 秒。附圖包含 ${v.sheets} 張「影格拼版」（共 ${v.dense} 格，約每 ${step.toFixed(2)} 秒一格；每張由左到右、由上到下依時間排列，每格左上角黃字是時間與序號）`
      + `${v.keyframes ? `與 ${v.keyframes} 張解析度較高的關鍵影格（標「場景」的是畫面變化最大的時間點）` : ''}。`
      + `${audio ? `另附一張音軌分析圖（波形、頻譜、音量曲線），本機解碼數據：${audio.summary}。` : v.audioError ? `音軌：${v.audioError}。` : ''}`
      + `模型看不到連續畫面、也聽不到聲音，語音與歌詞沒有轉成文字；請依這些圖片與數據分析並說明依據。原始檔：${v.path || v.name}]`;
  }).join('') + [...audios.values()].filter(a => !videos.has(a.name)).map(a =>
    `\n[音訊 ${JSON.stringify(a.name)}：本機解碼分析——${a.summary}。附圖是波形、頻譜（對數頻率軸）與音量曲線。模型聽不到聲音，語音與歌詞沒有轉成文字；速度與調性是演算法估計值。原始檔：${a.path || a.name}]`).join('');
  return text + summary + list.map((a) => {
    if (a.mime === 'text/plain') return `\n\n<attachment name=${JSON.stringify(a.name)}>\n${a.text}\n</attachment>`;
    if (a.mime?.startsWith('image/')) {
      imageIndex += 1;
      return `\n[圖片 ${imageIndex}/${imageTotal}：${a.name}]`;
    }
    return `\n[附件：${a.name}]`;
  }).join('');
}
function content(text, items, provider) {
  const parts = [{ type: 'text', text: text || '請分析附件。' }];
  for (const a of items || []) {
    if (a.mime === 'text/plain') continue; // Text is included in the persisted message.
    if (provider === 'claude') parts.push({ type: a.mime === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: a.mime, data: a.data } });
    else if (a.mime === 'application/pdf') throw new Error('PDF 請切換 Claude；其他模型可上傳文字或圖片。');
    else parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } });
  }
  return parts.length === 1 ? text : parts;
}
function imagePaths(items, directory) {
  // 不去重：同一張圖若被排在不同位置，也必須把完整順序交給模型。
  return (items || []).filter(a => a?.mime?.startsWith('image/')).map(a => {
    if (typeof a.path === 'string' && a.path.trim() && fs.existsSync(a.path) && fs.statSync(a.path).isFile()) return a.path;
    if (a.data) return stageImage(Buffer.from(a.data, 'base64'), directory, a.name).path;
    throw new Error(`圖片「${a.name || '未命名'}」缺少可讀檔案，請重新附加圖片後再送出。`);
  });
}
module.exports = { stage, stageImage, textWithFiles, content, imagePaths };
