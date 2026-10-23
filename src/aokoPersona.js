'use strict';
// 蒼崎青子命題 Agent：84 條因果命題各自成為一個規則節點，程式保存跨回合狀態（情緒、激動、疲勞、信任、預期、未結事項…），
// 由程式先選定行動與路徑，模型只負責標記使用者原句線索與依限制寫台詞。
// 引擎是 Python（src/vendor/aoko）；模型呼叫全部轉回這裡，沿用目前對話的模型與登入方式，金鑰不進 Python。
const fs = require('fs');
const path = require('path');
const { spawnCli, killTree } = require('./codexRunner');
const { python } = require('./ragthoven');

const NAME = '蒼崎青子';
const WORKER = path.join(__dirname, 'vendor', 'aoko', 'worker.py');
const PREAMBLE = '';
const TASK_NOTE = '這是純文字的角色對話任務，只依指示輸出要求的 JSON，不使用任何工具，也不修改檔案。\n\n';

const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'chat';
const stateFile = (root, chatId) => path.join(root, `${safeId(chatId)}.json`);

function loadState(root, chatId) {
  try { const s = JSON.parse(fs.readFileSync(stateFile(root, chatId), 'utf8')); return s && typeof s === 'object' ? s : null; } catch { return null; }
}
function saveState(root, chatId, state) {
  fs.mkdirSync(root, { recursive: true });
  const file = stateFile(root, chatId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

/** 啟動 Python 工作行程，跑一個引擎回合（或健康檢查）；每次模型請求都交給 runner。 */
function execute(args, { pythonPath, runner, signal, timeoutMs = 600000, onProgress } = {}) {
  const bin = python(pythonPath);
  if (!bin) return Promise.reject(new Error('找不到 Python 3.10 以上，請在「蒼崎青子」擴充的設定填入 python.exe 路徑。'));
  if (signal?.aborted) return Promise.reject(new Error('已取消'));
  return new Promise((resolve, reject) => {
    const child = spawnCli(bin, ['-u', WORKER], { env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
    const controller = new AbortController();
    let ended = false, buffer = '', stderr = '';
    const start = Date.now();
    const finish = (error, result) => {
      if (ended) return;
      ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); killTree(child);
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error('已取消'));
    const timer = setTimeout(() => finish(new Error(`青子這一回合超過 ${Math.round(timeoutMs / 60000)} 分鐘沒有完成。`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', finish);
    child.stdin.on('error', (e) => { if (!ended) finish(e); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('close', (code) => { if (!ended) finish(new Error(`青子引擎提早結束（${code}）：${stderr}`)); });
    const handle = async (event) => {
      if (ended) return;
      if (event.type === 'result') return finish(null, event.result);
      if (event.type === 'error') return finish(new Error(event.message));
      if (event.type === 'model_request') {
        if (!runner) throw new Error('尚未取得目前對話的模型');
        onProgress?.(`第 ${event.id} 次模型呼叫`);
        const left = timeoutMs - (Date.now() - start);
        if (left < 10000) throw new Error('這一回合的時間在模型呼叫前就用完了。');
        const message = `${TASK_NOTE}系統指令：\n${event.system}\n\n使用者資料：\n${event.user}`;
        try {
          const r = await runner.ask(message, { name: `蒼崎青子：第 ${event.id} 次呼叫`, signal: controller.signal, timeoutMs: left, preamble: PREAMBLE, ephemeral: true });
          if (!ended) child.stdin.write(JSON.stringify({ id: event.id, text: r.text }) + '\n');
        } catch (e) {
          if (!ended) child.stdin.write(JSON.stringify({ id: event.id, error: e.message }) + '\n');
        }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try { Promise.resolve(handle(JSON.parse(line))).catch(finish); } catch (error) { finish(error); }
      }
    });
    child.stdin.write(JSON.stringify(args) + '\n');
  });
}

/** 一回合：讀該對話的狀態 → 引擎 → 存新狀態。回傳訊息與可檢視的規則紀錄摘要。 */
async function turn({ root, chatId, userText, context, runner, pythonPath, signal, timeoutMs, onProgress }) {
  const r = await execute({ state: loadState(root, chatId), message: userText, context: context || '' }, { pythonPath, runner, signal, timeoutMs, onProgress });
  saveState(root, chatId, r.state);
  return {
    name: NAME, messages: r.messages, reply: r.messages.join('\n\n'), calls: r.calls,
    meta: { route: r.route, action: r.action, emotion: r.emotion, arousal: r.arousal, fatigue: r.fatigue, trust: r.trust, fired: r.fired, turn: r.state.turn },
  };
}

async function health(pythonPath) {
  const r = await execute({ health: true }, { pythonPath, timeoutMs: 40000 });
  return r;
}

/** 清掉全部青子對話狀態：整個資料夾改名備份，不直接刪。 */
function reset(root) {
  if (!fs.existsSync(root)) return { removed: false };
  const backup = `${root}-backup-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  fs.renameSync(root, backup);
  return { removed: true, backup };
}

/** 把這段對話先前的訊息整理成給青子的背景紀錄（最近 12 則、每則 600 字、總長 6000 字）。 */
function transcript(messages) {
  const rows = (messages || []).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim()).slice(-12)
    .map((m) => `[${m.role === 'user' ? '對方' : (m.aoko ? '青子' : '其他助理')}] ${m.text.trim().slice(0, 600)}`);
  return rows.join('\n').slice(-6000);
}

module.exports = { NAME, transcript, execute, turn, health, reset, loadState, saveState };
