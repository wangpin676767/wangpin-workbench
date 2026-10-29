'use strict';
// 影片與音樂附件：在拋棄式沙盒視窗裡用 Chromium 本機解碼，產生帶時間標記的影格拼版、場景關鍵影格
// 與音訊分析圖。原始檔不整份轉 base64、不上傳；只把產生的 JPEG 當成一般圖片附件送給模型。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { decodeMedia } = require('./mediaDecoder');

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.weba']);
const MAX_MEDIA_BYTES = 600 * 1024 * 1024;
const MAX_AUDIO_ANALYSIS_BYTES = 300 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 3 * 60 * 60;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function mediaKind(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return VIDEO_EXTS.has(ext) ? 'video' : AUDIO_EXTS.has(ext) ? 'audio' : '';
}
function clock(seconds) {
  const s = Math.max(0, Number(seconds) || 0), m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
function validateMedia(file) {
  const kind = mediaKind(file);
  if (!kind) throw new Error('請選擇影片（MP4／MOV／WebM／MKV）或音樂（MP3／WAV／M4A／AAC／FLAC／OGG／OPUS）');
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size || stat.size > MAX_MEDIA_BYTES) throw new Error('影音檔必須是非空白且不超過 600 MB 的檔案');
  return { kind, size: stat.size };
}
function audioSummary(audio) {
  if (!audio) return '';
  const parts = [`長 ${clock(audio.duration)}`, `${audio.channels} 聲道`, `峰值 ${audio.peakDb} dBFS`, `平均響度 ${audio.rmsDb} dBFS`, `動態範圍約 ${audio.loudRangeDb} dB`];
  if (audio.bpm) parts.push(`速度估計約 ${audio.bpm} BPM（信心 ${audio.bpmConfidence}）`);
  if (audio.key) parts.push(`調性估計 ${audio.key}（信心 ${audio.keyConfidence}）`);
  parts.push(audio.silenceCount ? `靜音段 ${audio.silenceCount} 處：${audio.silences.map(([a, b]) => `${clock(a)}–${clock(b)}`).join('、')}${audio.silenceCount > audio.silences.length ? ' 等' : ''}` : '沒有明顯靜音段');
  parts.push(`音量時間軸（每 5%，dBFS）：${audio.loudness.join(', ')}`);
  return parts.join('；');
}

/**
 * 回傳圖片附件陣列（JPEG）。maxImages 是這個檔案最多可用的圖片數。
 * 影片：最多 4 張拼版（每張 16 格）＋ 最多 4 張場景關鍵影格 ＋ 1 張音軌分析；音樂：1 張分析圖。
 */
async function extractMedia(file, directory, options = {}) {
  const { kind, size } = validateMedia(file);
  const maxImages = options.maxImages === undefined ? 9 : options.maxImages;
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 16) throw new Error('影音擷取圖片數量必須介於 1 至 16 張');
  if (options.signal?.aborted) throw new Error('影音擷取已取消');
  const { BrowserWindow } = require('electron');
  const window = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    backgroundThrottling: false, partition: `media-decoder-${crypto.randomUUID()}`,
  } });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const created = [];
  let timeout, abort;
  const name = path.basename(file);
  const original = path.resolve(file);
  try {
    const interrupted = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('影音解碼逾時')), 240000);
      abort = () => reject(new Error('影音擷取已取消'));
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    const work = (async () => {
      await window.loadFile(path.join(__dirname, 'mediaDecoder.html'));
      const config = { kind, maxImages, audio: kind === 'video' && maxImages >= 3 && options.audio !== false, maxDimension: 1024, tileSize: 480,
        maxFrameBytes: MAX_IMAGE_BYTES, fileBytes: size, maxAudioBytes: MAX_AUDIO_ANALYSIS_BYTES, maxAudioSeconds: MAX_AUDIO_SECONDS, title: name.slice(0, 60) };
      return contents.executeJavaScript(`(${decodeMedia.toString()})(${JSON.stringify(pathToFileURL(original).href)}, ${JSON.stringify(config)})`);
    })();
    const result = await Promise.race([work, interrupted]);
    if (options.signal?.aborted) throw new Error('影音擷取已取消');
    if (!result || !Number.isFinite(result.duration) || result.duration <= 0) throw new Error('影音擷取結果無效');
    fs.mkdirSync(directory, { recursive: true });
    const write = (data, label, meta) => {
      if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3)) throw new Error('影音擷取圖片無效');
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('影音擷取的 JPEG 圖片無效');
      const id = crypto.randomUUID(), destination = path.join(directory, `${id}.jpg`);
      const descriptor = fs.openSync(destination, 'wx');
      created.push(destination);
      try { fs.writeFileSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
      return { id, name: `${name} [${label}].jpg`, size: bytes.length, mime: 'image/jpeg', path: destination, data: bytes.toString('base64'), ...meta };
    };
    const items = [];
    const audioMeta = result.audio ? { name, duration: result.audio.duration, summary: audioSummary(result.audio), path: original, fromVideo: kind === 'video' } : null;
    if (kind === 'video') {
      if (!Array.isArray(result.sheets) || !result.sheets.length || result.sheets.length > 4 || !Array.isArray(result.keyframes) || result.keyframes.length > 4) throw new Error('影片擷取結果無效');
      const base = { name, duration: result.duration, dense: result.dense, sheets: result.sheets.length, keyframes: result.keyframes.length, path: original, audioError: result.audioError || '' };
      result.sheets.forEach((sheet, index) => {
        if (![sheet.from, sheet.to].every(t => Number.isFinite(t) && t >= 0 && t <= result.duration)) throw new Error('影片擷取圖片無效');
        items.push(write(sheet.data, `影格拼版 ${index + 1}／${result.sheets.length} · ${clock(sheet.from)}–${clock(sheet.to)} · ${sheet.count} 格`,
          { video: { ...base, kind: 'sheet', index: index + 1, total: result.sheets.length, from: sheet.from, to: sheet.to, count: sheet.count, timestamp: sheet.from } }));
      });
      result.keyframes.forEach((frame, index) => {
        if (!Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > result.duration) throw new Error('影片擷取圖片無效');
        items.push(write(frame.data, `${frame.scene ? '場景' : '關鍵影格'} ${clock(frame.timestamp)}`,
          { video: { ...base, kind: 'keyframe', index: index + 1, total: result.keyframes.length, timestamp: frame.timestamp, scene: !!frame.scene } }));
      });
      if (result.audio) items.push(write(result.audio.image, '音軌分析', { audio: audioMeta, video: { ...base, kind: 'audio', timestamp: 0 } }));
    } else {
      if (!result.audio) throw new Error('音訊分析失敗');
      items.push(write(result.audio.image, '音訊分析', { audio: audioMeta }));
    }
    return items;
  } catch (error) {
    for (const destination of created) { try { fs.unlinkSync(destination); } catch {} }
    throw error;
  } finally {
    clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
    if (!window.isDestroyed()) window.destroy();
  }
}

module.exports = { extractMedia, validateMedia, mediaKind, audioSummary, clock, VIDEO_EXTS, AUDIO_EXTS, MAX_MEDIA_BYTES };
