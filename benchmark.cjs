'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const original = require('../tests/helpers/native-original.cjs');
const oldSearch = original('chatSearch.js'), oldStore = original('codexStore.js');
const search = require('../src/chatSearch'), store = require('../src/codexStore');
const addon = require('../src/nativeAccelerator');
const out = path.resolve(process.argv[2] || __dirname + '/evidence'); fs.mkdirSync(out, { recursive: true });
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
function corpus(count) {
  return Array.from({ length: count }, (_, i) => ({ role: i % 11 === 0 ? 'note' : i % 2 ? 'user' : 'assistant',
    text: (`對話 ${i} 專案設定 API 測試。\nconst request = await fetch('/api/items');\n` +
      '這段說明包含 Markdown **粗體**，以及排程與檔案路徑。\n').repeat(i % 3 === 0 ? 16 : 8) +
      (i % 13 === 0 ? 'needle finish' : 'worker finish'), provider: 'fixture', ts: String(i) }));
}
function timed(fn, n) { const start = performance.now(); for (let i = 0; i < n; i++) fn(i); return (performance.now() - start) / n; }
async function measureSearch(count) {
  const messages = corpus(count);
  const queries = ['needle', 'worker api', '不存在', 'finish', '排程 api', '「專案設定」'].map(oldSearch.parseQuery);
  for (const terms of queries) assert.deepEqual(search.searchMessages(messages, terms), oldSearch.searchMessages(messages, terms));
  const samples = { original: [], cold: [], warm: [], cachedJs: [] };
  const methods = {
    original: () => timed(i => oldSearch.searchMessages(messages, queries[i % queries.length]), 12),
    cold: () => timed(i => { search.clearIndexCache(); search.searchMessages(messages, queries[i % queries.length]); }, 6),
    warm: () => { delete process.env.CODEX_MULTI_NATIVE_DISABLED; search.clearIndexCache(); search.searchMessages(messages, queries[0]);
      return timed(i => search.searchMessages(messages, queries[i % queries.length]), 12); },
    cachedJs: () => { process.env.CODEX_MULTI_NATIVE_DISABLED = '1'; search.clearIndexCache(); search.searchMessages(messages, queries[0]);
      const ms = timed(i => search.searchMessages(messages, queries[i % queries.length]), 12); delete process.env.CODEX_MULTI_NATIVE_DISABLED; return ms; },
  };
  const names = Object.keys(methods);
  for (let round = 0; round < 9; round++) for (let k = 0; k < names.length; k++) {
    const name = names[(round + k) % names.length]; delete process.env.CODEX_MULTI_NATIVE_DISABLED;
    samples[name].push(methods[name]());
  }
  search.clearIndexCache(); search.searchMessages(messages, queries[0]);
  return { count, textBytes: Buffer.byteLength(messages.map(m => m.text).join('')), nativeIndex: search.indexStats().nativeEntries > 0,
    medianMs: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)])), samples };
}
async function measureTranscript(count, compressed = false) {
  const rows = [JSON.stringify({ type: 'session_meta', payload: { cwd: 'E:\\fixture' } })];
  for (let i = 0; i < count; i++) {
    rows.push(JSON.stringify({ type: 'event_msg', timestamp: 't' + i, payload: { type: 'user_message', message: '問題 ' + i } }),
      JSON.stringify({ type: 'response_item', timestamp: 'tool' + i, payload: { type: 'function_call_output', output: ('工具輸出 node.js success 123\n').repeat(i % 10 === 0 ? 700 : 15) } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '回答 ' + i + ' 😀', phase: 'final_answer' } }));
  }
  let file = path.join(out, `rollout-${count}.jsonl`); fs.writeFileSync(file, rows.join('\n'));
  if (compressed) {
    require('node:child_process').execFileSync(path.join(__dirname, 'chat-accelerator/target/release/examples/compress.exe'), [file, file + '.zst'], { stdio: 'ignore', windowsHide: true });
    file += '.zst';
  }
  const opts = { codexHome: out, id: 'fixture', rolloutPath: file, strict: true };
  assert.deepEqual(await store.loadTranscript(opts), await oldStore.loadTranscript(opts));
  const samples = { original: [], native: [] }, lag = { original: [], native: [] };
  for (let round = 0; round < 9; round++) for (const name of round % 2 ? ['native', 'original'] : ['original', 'native']) {
    const fn = name === 'original' ? oldStore.loadTranscript : store.loadTranscript;
    let last = performance.now(), max = 0;
    const timer = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last); last = now; }, 1);
    const begin = performance.now(); await fn(opts); samples[name].push(performance.now() - begin);
    max = Math.max(max, performance.now() - last); clearInterval(timer); lag[name].push(max);
  }
  return { count, compressed, bytes: fs.statSync(file).size, medianMs: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)])),
    medianMaxEventLoopGapMs: Object.fromEntries(Object.entries(lag).map(([k, v]) => [k, median(v)])), samples };
}
(async () => {
  assert.equal(addon.status().available, true, addon.status().failure);
  const report = { date: new Date().toISOString(), node: process.version, native: addon.status(), search: [], transcript: [] };
  for (const count of [20, 200, 1000]) report.search.push(await measureSearch(count));
  for (const count of [20, 200, 1000]) report.transcript.push(await measureTranscript(count));
  for (const count of [200, 1000]) report.transcript.push(await measureTranscript(count, true));
  fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ search: report.search.map(({ samples, ...rest }) => rest), transcript: report.transcript.map(({ samples, ...rest }) => rest) }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
