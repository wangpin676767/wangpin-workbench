'use strict';
const OMITTED = '\n…〔中段省略，完整內容在子 agent 對話裡〕…\n';
function clip(text, n) {
  const s = String(text || '');
  return s.length <= n ? s : s.slice(0, Math.floor(n * 0.3)) + OMITTED + s.slice(-Math.floor(n * 0.7));
}
// Consume JSON string fragments without retaining the original result. The
// parser separately validates syntax; decoded UTF-16 units match String.slice.
function jsonPreview(n = 1200) {
  const first = Math.floor(n * 0.3), last = Math.floor(n * 0.7);
  let length = 0, prefix = '', suffix = '', short = '', escaped = false, hex = null;
  const special = /["\\]/g;
  function decoded(text) {
    length += text.length;
    if (prefix.length < first) prefix += text.slice(0, first - prefix.length);
    suffix = (suffix + text).slice(-last);
    if (length <= n) short += text; else short = '';
  }
  function feed(text) {
    let i = 0;
    while (i < text.length) {
      if (hex !== null) {
        hex += text[i++];
        if (hex.length === 4) { decoded(String.fromCharCode(parseInt(hex, 16))); hex = null; }
      } else if (escaped) {
        const ch = text[i++]; escaped = false;
        if (ch === 'u') hex = '';
        else decoded(({b:'\b',f:'\f',n:'\n',r:'\r',t:'\t'})[ch] || ch);
      } else {
        special.lastIndex = i;
        const match = special.exec(text);
        if (!match) { decoded(text.slice(i)); break; }
        decoded(text.slice(i, match.index)); i = match.index + 1;
        if (match[0] === '\\') escaped = true;
      }
    }
  }
  return {feed, finish: () => length <= n ? short : prefix + OMITTED + suffix};
}
module.exports = {clip, jsonPreview};
