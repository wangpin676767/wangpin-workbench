'use strict';
// Import configuration only; connecting is an explicit separate action.
function parse(text) {
  const data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  const entries = data?.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
    ? Object.entries(data.mcpServers).map(([name, spec]) => ({ ...spec, name }))
    : Array.isArray(data) ? data : [data];
  if (!entries.length) throw new Error('檔案內沒有 MCP 擴充設定');
  return entries.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('MCP 設定必須是物件');
    const transport = c.transport === 'http' || (!c.command && c.url) ? 'http' : 'stdio';
    if (c.transport && !['http', 'stdio'].includes(c.transport)) throw new Error('目前支援 stdio 或 http MCP');
    if (transport === 'http') {
      const url = new URL(c.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP 網址必須使用 HTTP 或 HTTPS');
    } else if (typeof c.command !== 'string' || !c.command.trim()) throw new Error('請提供 MCP 執行指令 command');
    if (c.args != null && (!Array.isArray(c.args) || c.args.some(a => typeof a !== 'string'))) throw new Error('args 必須是字串陣列');
    for (const key of ['env', 'headers']) {
      if (c[key] != null && (typeof c[key] !== 'object' || Array.isArray(c[key]) || Object.values(c[key]).some(v => typeof v !== 'string'))) throw new Error(`${key} 必須是字串值物件`);
    }
    return { name: String(c.name || '自訂 MCP').slice(0, 40), prefix: String(c.prefix || c.name || 'mcp').slice(0, 30), transport,
      command: c.command || '', args: c.args || [], env: c.env || {}, url: c.url || '', headers: c.headers || {} };
  });
}
module.exports = { parse };
