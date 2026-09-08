import { spawn } from 'node:child_process';
const p = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
p.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const msg = JSON.parse(line); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch {}
  }
});
const send = (id, method, params = {}) => new Promise((res, rej) => {
  pending.set(id, res);
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => rej(new Error(`timeout: ${method}`)), 20000);
});

const init = await send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
console.log('server:', init.result.serverInfo.name, init.result.serverInfo.version);
const instr = init.result.instructions ?? '';
console.log('instructions 長度:', instr.length);
for (const key of ['search_tender_archive', '兩個工具都要跑', '0 筆', '不可靜默省略', '不要試圖繞過驗證碼']) {
  console.log(`  ${instr.includes(key) ? 'PASS' : 'FAIL'}  instructions 含「${key}」`);
}
const tools = (await send(2, 'tools/list')).result.tools;
console.log('tools:', tools.map(t => t.name).join(', '));
const a = tools.find(t => t.name === 'search_tender_archive');
console.log(`  ${a ? 'PASS' : 'FAIL'}  search_tender_archive 已註冊`);
if (a) {
  const keys = Object.keys(a.inputSchema.properties);
  console.log('  參數:', keys.join(', '));
  console.log(`  ${!keys.includes('maxPages') ? 'PASS' : 'FAIL'}  maxPages 已移除`);
  console.log(`  ${a.inputSchema.required?.includes('keyword') ? 'PASS' : 'FAIL'}  keyword 為必填`);
}
const call = await send(3, 'tools/call', { name: 'search_tender_archive', arguments: { keyword: '室內裝修', years: '114', deadlineTo: '1141231' } });
const text = call.result.content[0].text;
console.log('\n--- 實際呼叫輸出（前 900 字）---\n' + text.slice(0, 900));
for (const key of ['等標期內（還能投標）', '已截止／歷史案']) {
  console.log(`  ${text.includes(key) ? 'PASS' : 'FAIL'}  輸出含「${key}」分段`);
}
p.kill();
