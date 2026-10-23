'use strict';
const { spawn } = require('child_process');
const { findBrave } = require('./browserControl');

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim() || /^(?:javascript|data|file|ftp):/i.test(value)) throw Error('只接受 HTTP／HTTPS 網址');
  const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('只接受 HTTP／HTTPS 網址');
  return url.href;
}

// Only an explicit, short open-tab command; questions, quotations, negations and
// multi-step website tasks stay with the model and its browser tools.
function request(text) {
  const value = String(text || '').trim();
  if (value.length > 150 || /[「」“”"\n]|不要|別|沒有|為什麼|為啥|如果|假如|說|能不能/.test(value)) return null;
  const match = /^(?:請|幫我|麻煩)?\s*(?:再|在|用|使用)?\s*brave\s*(?:上|裡|中)?\s*(?:再)?\s*(?:開啟|打開|開)\s*(?:一個|新的|新)?\s*((?:https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s]*)?)\s*(?:的)?\s*(?:新)?\s*(?:分頁|網頁)?[。！!]?$/i.exec(value);
  if (!match) return null;
  try { return normalizeUrl(match[1]); } catch { return null; }
}

async function open(url, { bravePath = '', launch = spawn } = {}) {
  const target = normalizeUrl(url);
  const file = findBrave(bravePath).path;
  if (!file) throw Error('找不到 Brave，請在 API 設定指定 Brave 執行檔。');
  await new Promise((resolve, reject) => {
    // The user explicitly asked for a visible browser tab. Launch from the App's
    // interactive desktop, using the normal Brave profile, without debug/headless
    // flags. Never kill an existing/user browser on a timeout.
    const child = launch(file, ['--new-tab', target], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return `已由工作台向你的 Brave 送出開啟新分頁的要求：${target}\n使用一般 Brave 視窗與設定檔，沒有使用無頭模式。這是啟動確認，尚未讀取網頁確認載入完成。`;
}

const tool = { type: 'function', function: { name: 'brave_open_visible', description: '在使用者看得到的一般 Brave 視窗開啟新分頁，沿用平常的 Brave 設定檔。使用者說在 Brave 開網址／分頁時優先用此工具。回傳啟動結果，不代表頁面已載入。', parameters: { type: 'object', properties: { url: { type: 'string', description: 'HTTP／HTTPS 網址' } }, required: ['url'], additionalProperties: false } } };
module.exports = { open, request, normalizeUrl, tool };
