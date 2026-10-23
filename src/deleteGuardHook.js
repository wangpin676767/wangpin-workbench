'use strict';
// Codex／Claude Code 的 PreToolUse hook：由工作台以 Node 模式執行。
// 不是刪除就什麼都不輸出（讓 CLI 照原本的權限流程走）；是刪除就回頭問工作台，
// 使用者允許才放行，拒絕、逾時或連不到工作台一律擋下（寧可擋錯，不可放錯）。
const { detectToolCall } = require('./deleteGuard');

const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
};

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  if (process.env.CODEX_MULTI_DELETE_GUARD_LOG) { try { require('fs').appendFileSync(process.env.CODEX_MULTI_DELETE_GUARD_LOG, raw + '\n'); } catch { /* 只是除錯用 */ } }
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const hit = detectToolCall(input.tool_name, input.tool_input);
  if (!hit) process.exit(0);
  const url = process.env.CODEX_MULTI_DELETE_GUARD_URL;
  const token = process.env.CODEX_MULTI_DELETE_GUARD_TOKEN;
  const blocked = `使用者設定了「禁止刪除檔案，除非經我授權」，這次${hit.reason}沒有得到授權，已被擋下。不要改用其他方式繞過；如果真的需要刪除，請先向使用者說明要刪哪些檔案與原因，等使用者同意後再做。`;
  if (!url || !token) deny(blocked);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ reason: hit.reason, detail: hit.detail, tool: input.tool_name || '' }), signal: AbortSignal.timeout(140000) });
    const answer = res.ok ? await res.json() : {};
    if (answer.allow === true) process.exit(0);
  } catch { /* 連不到就當成沒有授權 */ }
  deny(blocked);
});
