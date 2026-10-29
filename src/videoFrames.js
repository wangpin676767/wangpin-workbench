const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { decodeVideoFrames } = require('./videoFramesDecoder');
const MAX_VIDEO_BYTES = 600 * 1024 * 1024;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_FRAMES = 16;
function timestampLabel(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}
function validateVideo(file) {
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.mp4') throw new Error('請選擇 MP4 影片');
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size || stat.size > MAX_VIDEO_BYTES) throw new Error('MP4 必須是非空白且不超過 600 MB 的影片檔案');
}
async function extractVideoFrames(file, directory, options = {}) {
  validateVideo(file);
  const frameCount = options.frameCount === undefined ? 8 : options.frameCount;
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_FRAMES) throw new Error('影片擷取圖片數量必須介於 1 至 16 張');
  if (options.signal?.aborted) throw new Error('影片擷取已取消');
  const { BrowserWindow } = require('electron');
  const window = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    backgroundThrottling: false, partition: `video-frames-${crypto.randomUUID()}`
  } });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const created = [];
  let timeout, abort;
  try {
    const interrupted = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('MP4 影片解碼逾時')), 90000);
      abort = () => reject(new Error('影片擷取已取消'));
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    const work = (async () => {
      await window.loadFile(path.join(__dirname, 'videoFrames.html'));
      return contents.executeJavaScript(`(${decodeVideoFrames.toString()})(${JSON.stringify(pathToFileURL(path.resolve(file)).href)}, ${JSON.stringify({ frameCount, maxDimension: 1024, maxFrameBytes: MAX_FRAME_BYTES })})`);
    })();
    const result = await Promise.race([work, interrupted]);
    if (options.signal?.aborted) throw new Error('影片擷取已取消');
    if (!result || !Array.isArray(result.frames) || result.frames.length !== frameCount || !Number.isFinite(result.duration) || result.duration <= 0 || result.width > 1024 || result.height > 1024) throw new Error('影片擷取結果無效');
    fs.mkdirSync(directory, { recursive: true });
    const name = path.basename(file);
    return result.frames.map((frame, index) => {
      if (!Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > result.duration || typeof frame.data !== 'string' || frame.data.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3)) throw new Error('影片擷取圖片無效');
      const bytes = Buffer.from(frame.data, 'base64');
      if (!bytes.length || bytes.length > MAX_FRAME_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('影片擷取的 JPEG 圖片無效');
      const id = crypto.randomUUID(), destination = path.join(directory, `${id}.jpg`);
      const descriptor = fs.openSync(destination, 'wx');
      created.push(destination);
      try { fs.writeFileSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
      return { id, name: `${name} [${timestampLabel(frame.timestamp)} frame ${index + 1}/${frameCount}].jpg`, size: bytes.length, mime: 'image/jpeg', path: destination, data: bytes.toString('base64'),
        video: { name, timestamp: frame.timestamp, duration: result.duration, index: index + 1, total: frameCount } };
    });
  } catch (error) {
    for (const destination of created) { try { fs.unlinkSync(destination); } catch {} }
    throw error;
  } finally {
    clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
    if (!window.isDestroyed()) window.destroy();
  }
}
module.exports = { extractVideoFrames, validateVideo, timestampLabel, MAX_VIDEO_BYTES, MAX_FRAME_BYTES, MAX_FRAMES };
