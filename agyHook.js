'use strict';
// Antigravity CLI 的 PreToolUse hook：由工作台以 Node 模式執行（.agents/codex-multi-hook.cmd 啟動）。
// 把這次工具呼叫交給工作台判斷，原樣輸出 { decision, reason }。
// 連不到工作台、逾時或不是工作台叫起來的 agy，一律擋下（寧可擋錯，不可放錯）。
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  const url = process.env.CODEX_MULTI_AGY_HOOK_URL;
  const token = process.env.CODEX_MULTI_AGY_HOOK_TOKEN;
  if (!url || !token) out({ decision: 'deny', reason: '這個工作區只供 Codex 多模型工作台使用。' });
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { out({ decision: 'deny', reason: '無法解析工具呼叫。' }); }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ toolCall: input.toolCall || {} }), signal: AbortSignal.timeout(510000) });
    const answer = res.ok ? await res.json() : {};
    if (answer.decision === 'allow') out({ decision: 'allow' });
    out({ decision: 'deny', reason: answer.reason || '工作台沒有允許這次工具呼叫。' });
  } catch {
    out({ decision: 'deny', reason: '連不到工作台或等待同意逾時，這次工具呼叫已被擋下。' });
  }
});
