// Runs only inside the disposable, sandboxed video decoder window. No Node APIs.
async function decodeVideoFrames(url, options) {
  const video = document.createElement('video');
  video.preload = 'auto'; video.muted = true; video.playsInline = true;
  document.body.appendChild(video);
  function wait(event, action) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('MP4 影片解碼逾時')), 15000);
      function finish(error) {
        clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener('error', failed);
        error ? reject(error) : resolve();
      }
      function done() { finish(); }
      function failed() { finish(new Error('不支援此 MP4 編碼，或影片檔案已損壞')); }
      video.addEventListener(event, done, { once: true }); video.addEventListener('error', failed, { once: true });
      action();
    });
  }
  try {
    await wait('loadeddata', () => { video.src = url; video.load(); });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error('MP4 必須包含可解碼且有明確長度的影片軌道');
    const scale = Math.min(1, options.maxDimension / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('目前無法擷取影片圖片');
    const frames = [];
    for (let index = 0; index < options.frameCount; index++) {
      // Sample the middle of each equal interval; avoid unreliable end-of-stream seeks.
      const timestamp = duration * (index + 0.5) / options.frameCount;
      if (Math.abs(video.currentTime - timestamp) > 0.00001) await wait('seeked', () => { video.currentTime = timestamp; });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > options.maxFrameBytes * 4 / 3 + 64) throw new Error('影片擷取圖片超過附件大小限制');
      frames.push({ timestamp, data: dataUrl.slice(23) });
    }
    return { duration, width: canvas.width, height: canvas.height, frames };
  } finally { video.removeAttribute('src'); video.load(); video.remove(); }
}
module.exports = { decodeVideoFrames };
