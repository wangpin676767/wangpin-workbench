'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
const ext = fs.readFileSync(path.join(root, 'src/extensions.js'), 'utf8');

// 1. 確保 Persona Agent、王品 Agent 腳本與命題 Agent 檔案完全刪除
const bannedFiles = [
  'personaHost.js', 'personaBackendClient.js', 'personaConversationContext.js',
  'agentFlow.js', 'agentFlowEngine.js', 'agentFlowExecution.js',
  'agentFlowFrontend.js', 'agentFlowService.js', 'flowTools.js', 'aokoPersona.js'
];
for (const f of bannedFiles) {
  assert.equal(fs.existsSync(path.join(root, 'src', f)), false, 'Banned file exists: ' + f);
}
assert.equal(fs.existsSync(path.join(root, 'src/vendor/aoko')), false, 'src/vendor/aoko must not exist');

// 2. 介面與 IPC 檢查
for (const x of ['personaAgentBtn', 'agentFlowBtn', 'personaAgentUI.js']) {
  assert.ok(!html.includes(x), 'HTML contains banned UI: ' + x);
}
assert.ok(!/persona:|agentFlow:|aokoReset/.test(preload), 'preload.js leaks banned IPC');
assert.ok(!/personaHost|personaAgent|flowTools|agentFlow:|aokoTurn|aokoPersona|aoko:reset/.test(main), 'main.js leaks banned handlers');
assert.ok(!/personaAgent|agentFlowBtn|flowUi|aokoReset|aokoSeesHistory/.test(renderer), 'app.js leaks banned identifiers');
assert.ok(!/kind\s*:\s*['"]aoko['"]/.test(ext), 'extensions.js leaks aoko pack');

// 3. 預設值與資料目錄隔離檢查
assert.ok(main.includes("'Wangpin Workbench Open Source'"));
assert.ok(main.includes("codexHome: path.join(userDir(), 'codex-home')"));
assert.ok(main.includes('syncBraveLogin: false'));
assert.ok(!html.includes('wangpin67.com'));

// 4. 個人隱私路徑掃描（禁止包含作者使用者名稱與本機路徑）
const bannedPath = new RegExp('[A-Za-z]:[\\\\/]+Users[\\\\/]+wa' + 'ng(?:[\\\\/]|\\b)', 'i');
const bannedIP = new RegExp('(?:蒼崎|青子|橙子|久遠寺|魔法使之夜|TYPE-MOON)', 'i');

function scan(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) scan(p);
    else if (/\.(?:js|cjs|html|json|css|py|ps1|md|txt|tsv)$/.test(f.name)) {
      const data = fs.readFileSync(p, 'utf8');
      assert.ok(!bannedPath.test(data), 'Personal path leaked in: ' + p);
      assert.ok(!bannedIP.test(data), 'Third-party copyrighted IP leaked in: ' + p);
    }
  }
}
scan(path.join(root, 'src'));

console.log('Disabled features, isolated defaults, complete persona purge, and personal-path checks passed.');
