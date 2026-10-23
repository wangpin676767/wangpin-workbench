'use strict';
function line(value, limit = 600) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '…（已截短）' : text;
}
function options(plan) {
  const target = plan.target || {};
  const title = line(target.title) || '未命名對話';
  return {type:'warning',title:'永久刪除對話',buttons:['永久刪除','取消'],defaultId:1,cancelId:1,
    message:`永久刪除「${title}」與所屬子代理？`,
    detail:`對話識別碼：${target.key || '未知'}\n工作資料夾：${line(target.cwd, 1000) || '未指定'}\n\n工作台紀錄 ${plan.preview.appChats} 段、Codex 紀錄 ${plan.preview.codexThreads} 段。\n會刪除實際本機紀錄及關聯子代理，不會封存。Codex 紀錄刪除也會影響 Codex App；網站伺服器上的歷史不在此範圍。共用附件與其他專案保留。\n刪除後無法復原。`};
}
module.exports = {options};
