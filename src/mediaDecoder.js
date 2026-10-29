// Runs only inside the disposable, sandboxed media decoder window. No Node APIs.
// 影片：約每秒取一格（最多 64 格）排成帶時間標記的拼版，再挑畫面變化最大的場景輸出高解析關鍵影格；
// 音訊（含影片音軌）：在本機解碼成單聲道，算出音量、靜音段、速度（BPM）、調性估計，並畫出波形／頻譜／音量圖。
async function decodeMedia(url, options) {
  const MAX_DENSE = 64, PER_SHEET = 16, COLS = 4;
  const result = { kind: options.kind, duration: 0, width: 0, height: 0, sheets: [], keyframes: [], dense: 0, audio: null, audioError: '' };
  const jpeg = (canvas, quality) => {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > options.maxFrameBytes * 4 / 3 + 64) throw new Error('媒體擷取圖片超過附件大小限制');
    return dataUrl.slice(23);
  };
  const clock = seconds => {
    const s = Math.max(0, seconds);
    const m = Math.floor(s / 60), r = s - m * 60;
    return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
  };
  function waitFor(element, event, action, ms = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('媒體解碼逾時')), ms);
      function finish(error) {
        clearTimeout(timer); element.removeEventListener(event, done); element.removeEventListener('error', failed);
        error ? reject(error) : resolve();
      }
      function done() { finish(); }
      function failed() { finish(new Error('不支援此影音編碼，或檔案已損壞')); }
      element.addEventListener(event, done, { once: true }); element.addEventListener('error', failed, { once: true });
      action();
    });
  }

  async function analyzeAudio(knownDuration) {
    if (options.fileBytes > options.maxAudioBytes) throw new Error(`檔案超過 ${Math.round(options.maxAudioBytes / 1048576)} MB，音訊未分析`);
    if (knownDuration > options.maxAudioSeconds) throw new Error(`音訊長於 ${Math.round(options.maxAudioSeconds / 60)} 分鐘，未分析`);
    const sampleRate = knownDuration && knownDuration > 1800 ? 4000 : 11025;
    const bytes = await (await fetch(url)).arrayBuffer();
    const context = new OfflineAudioContext(1, 1, sampleRate);
    let buffer;
    try { buffer = await context.decodeAudioData(bytes); }
    catch { throw new Error('沒有可解碼的音軌'); }
    const length = buffer.length, sr = buffer.sampleRate;
    if (!length) throw new Error('音軌是空的');
    const mono = new Float32Array(length);
    for (let c = 0; c < buffer.numberOfChannels; c++) { const data = buffer.getChannelData(c); for (let i = 0; i < length; i++) mono[i] += data[i] / buffer.numberOfChannels; }
    const duration = length / sr;
    const db = v => v > 1e-9 ? 20 * Math.log10(v) : -120;
    // 50 ms RMS envelope
    const win = Math.max(1, Math.round(sr * 0.05)), frames = Math.ceil(length / win);
    const env = new Float32Array(frames);
    let peak = 0, sumSquares = 0;
    for (let f = 0; f < frames; f++) {
      let s = 0; const start = f * win, end = Math.min(length, start + win);
      for (let i = start; i < end; i++) { const v = mono[i]; s += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
      sumSquares += s; env[f] = Math.sqrt(s / Math.max(1, end - start));
    }
    const envDb = Array.from(env, db);
    const sorted = [...envDb].sort((a, b) => a - b);
    const pct = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
    const silences = [];
    let runStart = -1;
    for (let f = 0; f <= frames; f++) {
      const quiet = f < frames && envDb[f] < -50;
      if (quiet && runStart < 0) runStart = f;
      if (!quiet && runStart >= 0) { if ((f - runStart) * 0.05 >= 1) silences.push([runStart * 0.05, f * 0.05]); runStart = -1; }
    }
    // 速度：10 ms 能量差（onset strength）自相關，搜尋 60–200 BPM
    let bpm = 0, bpmConfidence = 0;
    if (duration >= 8) {
      const hop = Math.max(1, Math.round(sr * 0.01)), n = Math.floor(length / hop);
      const energy = new Float32Array(n);
      for (let f = 0; f < n; f++) { let s = 0; for (let i = f * hop, end = i + hop; i < end; i++) s += mono[i] * mono[i]; energy[f] = Math.log1p(s * 1000); }
      const onset = new Float32Array(n);
      for (let f = 1; f < n; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
      let mean = 0; for (const v of onset) mean += v; mean /= n;
      for (let f = 0; f < n; f++) onset[f] -= mean;
      const limit = Math.min(n, 6000);
      const scores = [];
      for (let lag = Math.round(6000 / 200 / 1); lag <= Math.round(6000 / 60); lag++) {
        let s = 0; for (let f = 0; f + lag < limit; f++) s += onset[f] * onset[f + lag];
        scores.push([lag, s]);
      }
      let zero = 0; for (let f = 0; f < limit; f++) zero += onset[f] * onset[f];
      const best = scores.reduce((a, b) => b[1] > a[1] ? b : a, [0, -Infinity]);
      if (best[0] && zero > 0) { bpm = Math.round(6000 / best[0]); bpmConfidence = Math.max(0, Math.min(1, best[1] / zero)); }
    }
    // FFT helpers
    function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
      for (let size = 2; size <= n; size <<= 1) {
        const angle = -2 * Math.PI / size;
        for (let i = 0; i < n; i += size) for (let k = 0; k < size / 2; k++) {
          const wr = Math.cos(angle * k), wi = Math.sin(angle * k);
          const xr = re[i + k + size / 2] * wr - im[i + k + size / 2] * wi, xi = re[i + k + size / 2] * wi + im[i + k + size / 2] * wr;
          re[i + k + size / 2] = re[i + k] - xr; im[i + k + size / 2] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi;
        }
      }
    }
    function spectrum(center, size) {
      const re = new Float32Array(size), im = new Float32Array(size);
      const start = Math.round(center - size / 2);
      for (let i = 0; i < size; i++) { const idx = start + i; const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)); re[i] = idx >= 0 && idx < length ? mono[idx] * w : 0; }
      fft(re, im);
      const mag = new Float32Array(size / 2);
      for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
      return mag;
    }
    // 調性估計：多點 4096 FFT 累積 chroma，對 Krumhansl 大小調輪廓做相關
    let key = '', keyConfidence = 0;
    if (duration >= 8 && sr >= 8000) {
      const chroma = new Float64Array(12);
      const points = Math.min(240, Math.floor(duration * 2));
      for (let p = 0; p < points; p++) {
        const mag = spectrum((p + 0.5) / points * length, 4096);
        for (let bin = 1; bin < mag.length; bin++) {
          const freq = bin * sr / 4096;
          if (freq < 55 || freq > 2000) continue;
          const pc = ((Math.round(12 * Math.log2(freq / 440)) % 12) + 12 + 9) % 12; // 0 = C
          chroma[pc] += mag[bin];
        }
      }
      const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
      const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const corr = (profile, shift) => {
        const x = [], y = [];
        for (let i = 0; i < 12; i++) { x.push(chroma[(i + shift) % 12]); y.push(profile[i]); }
        const mx = x.reduce((a, b) => a + b) / 12, my = y.reduce((a, b) => a + b) / 12;
        let num = 0, dx = 0, dy = 0;
        for (let i = 0; i < 12; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
        return dx && dy ? num / Math.sqrt(dx * dy) : 0;
      };
      const ranked = [];
      for (let s = 0; s < 12; s++) { ranked.push([corr(major, s), `${names[s]} 大調`]); ranked.push([corr(minor, s), `${names[s]} 小調`]); }
      ranked.sort((a, b) => b[0] - a[0]);
      if (ranked[0][0] > 0.3) { key = ranked[0][1]; keyConfidence = Math.max(0, Math.min(1, ranked[0][0] - ranked[1][0] + 0.5)); }
    }
    // 音量時間軸（20 段）
    const segments = [];
    for (let s = 0; s < 20; s++) {
      const a = Math.floor(s / 20 * frames), b = Math.max(a + 1, Math.floor((s + 1) / 20 * frames));
      let e = 0; for (let f = a; f < b && f < frames; f++) e += env[f] * env[f];
      segments.push(Math.round(db(Math.sqrt(e / Math.max(1, b - a)))));
    }
    // 圖：波形、頻譜（對數頻率）、音量曲線
    const W = 1600, H = 900, left = 70, right = 20, plotW = W - left - right;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d', { alpha: false });
    g.fillStyle = '#101418'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#e8eef4'; g.font = '22px sans-serif';
    g.fillText(`${options.title}　長 ${clock(duration)}　峰值 ${db(peak).toFixed(1)} dBFS　平均 ${db(Math.sqrt(sumSquares / length)).toFixed(1)} dBFS${bpm ? `　約 ${bpm} BPM` : ''}${key ? `　${key}（估計）` : ''}`, left, 32);
    const waveTop = 56, waveH = 200, specTop = 280, specH = 420, loudTop = 724, loudH = 130;
    g.fillStyle = '#9fb3c8'; g.font = '14px sans-serif';
    g.fillText('波形', 8, waveTop + 16); g.fillText('頻譜', 8, specTop + 16); g.fillText('音量', 8, loudTop + 16);
    g.strokeStyle = '#4fc3f7';
    for (let x = 0; x < plotW; x++) {
      const a = Math.floor(x / plotW * length), b = Math.max(a + 1, Math.floor((x + 1) / plotW * length));
      let lo = 0, hi = 0; for (let i = a; i < b; i += Math.max(1, Math.floor((b - a) / 400))) { const v = mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      g.beginPath(); g.moveTo(left + x + 0.5, waveTop + waveH / 2 - hi * waveH / 2); g.lineTo(left + x + 0.5, waveTop + waveH / 2 - lo * waveH / 2 + 1); g.stroke();
    }
    const size = 1024, fmin = 40, fmax = sr / 2;
    const image = g.createImageData(plotW, specH);
    const columns = [];
    let maxDb = -120;
    for (let x = 0; x < plotW; x++) {
      const mag = spectrum((x + 0.5) / plotW * length, size);
      const col = new Float32Array(specH);
      for (let y = 0; y < specH; y++) {
        const f0 = fmin * Math.pow(fmax / fmin, (specH - 1 - y) / specH), f1 = fmin * Math.pow(fmax / fmin, (specH - y) / specH);
        const b0 = Math.max(1, Math.floor(f0 * size / sr)), b1 = Math.max(b0 + 1, Math.ceil(f1 * size / sr));
        let m = 0; for (let b = b0; b < b1 && b < mag.length; b++) if (mag[b] > m) m = mag[b];
        col[y] = db(m); if (col[y] > maxDb) maxDb = col[y];
      }
      columns.push(col);
    }
    const palette = t => { t = Math.max(0, Math.min(1, t)); return [Math.round(255 * Math.min(1, t * 1.8)), Math.round(255 * Math.max(0, t * 1.6 - 0.5)), Math.round(255 * (t < 0.35 ? t * 2.2 : Math.max(0, 1.2 - t * 1.3) + Math.max(0, t - 0.85) * 4))]; };
    for (let x = 0; x < plotW; x++) for (let y = 0; y < specH; y++) {
      const [r, gg, b] = palette((columns[x][y] - (maxDb - 80)) / 80);
      const o = (y * plotW + x) * 4; image.data[o] = r; image.data[o + 1] = gg; image.data[o + 2] = b; image.data[o + 3] = 255;
    }
    g.putImageData(image, left, specTop);
    g.fillStyle = '#e8eef4'; g.font = '12px sans-serif';
    for (const f of [100, 250, 500, 1000, 2000, 4000].filter(f => f < fmax)) {
      const y = specTop + specH - 1 - Math.log(f / fmin) / Math.log(fmax / fmin) * specH;
      g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), 34, y + 4);
    }
    g.strokeStyle = '#ffb74d'; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x < plotW; x++) {
      const f = Math.min(frames - 1, Math.floor(x / plotW * frames));
      const y = loudTop + loudH - Math.max(0, Math.min(1, (envDb[f] + 60) / 60)) * loudH;
      x ? g.lineTo(left + x, y) : g.moveTo(left + x, y);
    }
    g.stroke(); g.lineWidth = 1;
    g.fillStyle = '#9fb3c8';
    for (let i = 0; i <= 10; i++) { const x = left + i / 10 * plotW; g.fillRect(x, specTop + specH, 1, 6); g.fillText(clock(duration * i / 10), Math.min(W - 60, x - 18), H - 18); }
    return {
      duration, sampleRate: sr, channels: buffer.numberOfChannels, peakDb: +db(peak).toFixed(1), rmsDb: +db(Math.sqrt(sumSquares / length)).toFixed(1),
      loudRangeDb: +(pct(0.95) - pct(0.1)).toFixed(1), silences: silences.slice(0, 12).map(([a, b]) => [+a.toFixed(1), +b.toFixed(1)]), silenceCount: silences.length,
      bpm, bpmConfidence: +bpmConfidence.toFixed(2), key, keyConfidence: +keyConfidence.toFixed(2), loudness: segments, image: jpeg(canvas, 0.85), imageWidth: W, imageHeight: H,
    };
  }

  if (options.kind === 'audio') {
    const audio = document.createElement('audio');
    audio.preload = 'metadata'; audio.muted = true; document.body.appendChild(audio);
    try {
      await waitFor(audio, 'loadedmetadata', () => { audio.src = url; audio.load(); });
      result.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    } catch { result.duration = 0; }
    finally { audio.removeAttribute('src'); audio.load(); audio.remove(); }
    result.audio = await analyzeAudio(result.duration);
    result.duration = result.audio.duration;
    return result;
  }

  const video = document.createElement('video');
  video.preload = 'auto'; video.muted = true; video.playsInline = true;
  document.body.appendChild(video);
  try {
    await waitFor(video, 'loadeddata', () => { video.src = url; video.load(); }, 30000);
    if (video.duration === Infinity) {
      // 錄影軟體輸出的 WebM 常沒有長度欄位：先跳到極遠處讓 Chromium 掃出實際長度，再回到開頭
      try { await waitFor(video, 'seeked', () => { video.currentTime = 1e101; }, 60000); } catch {}
      if (Number.isFinite(video.duration)) await waitFor(video, 'seeked', () => { video.currentTime = 0; });
    }
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error('影片必須包含可解碼且有明確長度的影像軌道');
    result.duration = duration;
    const budget = Math.max(1, options.maxImages - (options.audio ? 1 : 0));
    const keyCount = Math.min(4, Math.max(0, budget - 1), Math.floor(budget / 2));
    const sheetCount = Math.max(1, Math.min(4, budget - keyCount));
    // 短片每秒約 2 格、長片每秒約 1 格；至少 8 格，最多 64 格（4 張拼版）
    const target = Math.ceil(duration <= 32 ? duration * 2 : duration);
    const dense = Math.max(Math.min(8, sheetCount * PER_SHEET), Math.min(MAX_DENSE, sheetCount * PER_SHEET, target));
    result.dense = dense;
    const aspect = video.videoWidth / video.videoHeight;
    const tileW = aspect >= 1 ? options.tileSize : Math.round(options.tileSize * aspect), tileH = aspect >= 1 ? Math.round(options.tileSize / aspect) : options.tileSize;
    const rows = Math.ceil(Math.min(PER_SHEET, dense) / COLS);
    const sheetCanvas = document.createElement('canvas');
    sheetCanvas.width = tileW * COLS; sheetCanvas.height = tileH * rows;
    const sheet = sheetCanvas.getContext('2d', { alpha: false });
    const sig = document.createElement('canvas'); sig.width = 32; sig.height = 18;
    const sigCtx = sig.getContext('2d', { willReadFrequently: true });
    const signatures = [], times = [];
    let current = null;
    const flush = () => {
      if (!current) return;
      result.sheets.push({ data: jpeg(sheetCanvas, 0.8), from: current.from, to: current.to, count: current.count });
      current = null;
    };
    for (let i = 0; i < dense; i++) {
      const t = duration * (i + 0.5) / dense;
      if (Math.abs(video.currentTime - t) > 0.00001) await waitFor(video, 'seeked', () => { video.currentTime = t; });
      const slot = i % PER_SHEET;
      if (!slot) { flush(); sheet.fillStyle = '#000'; sheet.fillRect(0, 0, sheetCanvas.width, sheetCanvas.height); current = { from: t, to: t, count: 0 }; }
      const x = (slot % COLS) * tileW, y = Math.floor(slot / COLS) * tileH;
      sheet.drawImage(video, x, y, tileW, tileH);
      const label = `${clock(t)} #${i + 1}`;
      sheet.font = `bold ${Math.max(14, Math.round(tileH / 12))}px sans-serif`;
      const w = sheet.measureText(label).width + 10, lh = Math.max(20, Math.round(tileH / 9));
      sheet.fillStyle = 'rgba(0,0,0,0.72)'; sheet.fillRect(x, y, w, lh);
      sheet.fillStyle = '#ffeb3b'; sheet.fillText(label, x + 5, y + lh - 6);
      sheet.strokeStyle = '#222'; sheet.strokeRect(x + 0.5, y + 0.5, tileW - 1, tileH - 1);
      current.to = t; current.count++;
      sigCtx.drawImage(video, 0, 0, 32, 18);
      const px = sigCtx.getImageData(0, 0, 32, 18).data, rgb = new Float32Array(1728);
      for (let p = 0; p < 576; p++) { rgb[p * 3] = px[p * 4]; rgb[p * 3 + 1] = px[p * 4 + 1]; rgb[p * 3 + 2] = px[p * 4 + 2]; }
      signatures.push(rgb); times.push(t);
      if (i === dense - 1 || slot === PER_SHEET - 1) flush();
    }
    // 場景關鍵影格：畫面差異最大的時間點，彼此不相鄰；不足時平均補齊
    if (keyCount) {
      const diffs = signatures.map((s, i) => { if (!i) return 0; let d = 0; for (let p = 0; p < 1728; p++) d += Math.abs(s[p] - signatures[i - 1][p]); return d / 1728; });
      const order = diffs.map((d, i) => [d, i]).filter(([d, i]) => i && d >= 8).sort((a, b) => b[0] - a[0]);
      const picked = [];
      for (const [d, i] of order) { if (picked.length >= keyCount) break; if (picked.every(p => Math.abs(p.i - i) > 1)) picked.push({ i, score: d }); }
      for (let k = 0; picked.length < keyCount && k < keyCount * 3; k++) {
        const i = Math.min(dense - 1, Math.floor((k + 0.5) * dense / keyCount) % dense);
        if (picked.every(p => Math.abs(p.i - i) > 1)) picked.push({ i, score: 0 });
      }
      picked.sort((a, b) => a.i - b.i);
      const scale = Math.min(1, options.maxDimension / Math.max(video.videoWidth, video.videoHeight));
      const full = document.createElement('canvas');
      full.width = Math.max(1, Math.round(video.videoWidth * scale)); full.height = Math.max(1, Math.round(video.videoHeight * scale));
      const fullCtx = full.getContext('2d', { alpha: false });
      result.width = full.width; result.height = full.height;
      for (const p of picked) {
        const t = times[p.i];
        if (Math.abs(video.currentTime - t) > 0.00001) await waitFor(video, 'seeked', () => { video.currentTime = t; });
        fullCtx.drawImage(video, 0, 0, full.width, full.height);
        result.keyframes.push({ timestamp: t, data: jpeg(full, 0.85), scene: p.score > 0 });
      }
    }
    if (!result.width) { result.width = Math.min(options.maxDimension, sheetCanvas.width); result.height = Math.min(options.maxDimension, sheetCanvas.height); }
  } finally { video.removeAttribute('src'); video.load(); video.remove(); }
  if (options.audio) {
    try { result.audio = await analyzeAudio(result.duration); }
    catch (error) { result.audioError = String(error.message || error); }
  }
  return result;
}
module.exports = { decodeMedia };
