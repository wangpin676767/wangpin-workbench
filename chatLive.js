// 使用者隨時能在畫面上改、但不屬於「這一回合內容」的對話設定：擴充勾選、Harness 腳本、青子可見紀錄。
//
// 回合（handleSend）手上拿的是開始時讀到的對話副本，回合中和收尾都會整份寫回存檔。
// 使用者若在回合進行中改了設定（例如取消某個擴充），舊副本就會把它蓋回去；
// 人如果已經離開那段對話，畫面也不會替它補寫，之前取消的擴充就這樣又被打開了。
// 做法：使用者每次改設定時記下最新值，任何整份寫回存檔之前，先把最新值套回副本。
const LIVE_FIELDS = ['extensions', 'harness', 'aokoHistory', 'modelPick', 'systemPrompt', 'originalProject', 'workspace'];
const latest = new Map(); // 對話 id -> { 欄位: 最新值 }

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** 使用者改了設定：只記 LIVE_FIELDS 裡有出現在 patch 的欄位（值是 undefined 代表「移除這個設定」）。 */
function remember(id, patch) {
  if (!id || !patch || typeof patch !== 'object') return;
  const current = latest.get(id) || {};
  for (const key of LIVE_FIELDS) if (Object.hasOwn(patch, key)) current[key] = copy(patch[key]);
  latest.set(id, current);
}

/** 寫回存檔之前呼叫：把使用者最新的設定套回這份副本，回合內容（訊息等）不動。 */
function apply(chat) {
  const current = chat && latest.get(chat.id);
  if (!current) return chat;
  for (const key of LIVE_FIELDS) {
    if (!Object.hasOwn(current, key)) continue;
    if (current[key] === undefined) delete chat[key];
    else chat[key] = copy(current[key]);
  }
  return chat;
}

/** 對話刪除後不必再記。 */
function forget(id) { latest.delete(id); }

module.exports = { LIVE_FIELDS, remember, apply, forget };
