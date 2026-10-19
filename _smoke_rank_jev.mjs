// rank_by_topic engine="jev" 驗收。[4][5] 會實際呼叫 TypeSafe（需 TYPESAFE_API_KEY，13 次呼叫，約 0.0003 美元）；不碰採購網。
// 對照組與 _smoke_rank.mjs 相同：2026-09-17 實測 2,031 筆勞務決標時人工裁定過的公開標案名稱。
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRankJob, loadRankJob, runRankJob, setRankState, makeRankId } from './build/services/topic-rank.js';
import { noulToScore, jevQuestion, hasJevKey } from './build/services/jev-client.js';
import { envOrRegistry } from './build/services/groq-client.js';

let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

async function toolsList() {
  const srv = spawn(process.execPath, ['build/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  srv.stdout.on('data', d => { buf += d.toString(); });
  const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  // 等到 id 2 那一整行收齊（工具描述很長，會分好幾個 chunk 到）
  const reply2 = () => buf.split('\n').slice(0, -1).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(r => r?.id === 2);
  for (let t = 0; t < 100 && !reply2(); t++) await new Promise(r => setTimeout(r, 100));
  srv.kill();
  return reply2()?.result?.tools ?? [];
}

console.log('\n[1] 工具參數');
{
  const t = (await toolsList()).find(x => x.name === 'rank_by_topic');
  check(JSON.stringify(t?.inputSchema?.properties?.engine?.enum) === '["groq","jev"]', 'rank_by_topic 有 engine=groq|jev');
}

console.log('\n[2] noul → 0~3 分換算（純邏輯）');
{
  const got = [0.95, 0.8, 0.79, 0.5, 0.49, 0.3, 0.29, 0].map(noulToScore).join(',');
  check(got === '3,3,2,2,1,1,0,0', '≥0.8→3、≥0.5→2、≥0.3→1、其餘 0', got);
  const q = jevQuestion('室內裝修工程');
  check(q.type === 'noul' && q.instructions.includes('室內裝修工程') && q.criteria.true.includes('室內裝修工程'), '判斷說明依主題組出');
  check(makeRankId('t', [], ['1']) !== makeRankId('t', [], ['1'], 'jev') && makeRankId('t', [], ['1']) === makeRankId('t', [], ['1'], 'groq'), 'rankId 區分引擎、groq 舊 id 不變');
}

const TOPIC = '工程技術服務（為營建工程提供的規劃、設計、監造、專案管理、測量、地質調查、結構安全鑑定、工程檢測等技術性服務）';
const CASES = [
  ['臺中市政府運動局', '臺中市政府運動局場館零星修繕工程委託監造設計案', true],
  ['臺中市立文華高級中等學校', '115學年度仁愛樓屋頂防水隔熱修繕工程委託技術服務', true],
  ['交通部公路局中區養護工程分局', '115~118年度中分局信義段轄區地錨邊坡定期檢測、補充調查及補強設計服務工作', true],
  ['台灣電力股份有限公司大甲溪發電廠', '115-116年度達見吊橋及青山鋼便橋定期檢測工作', true],
  ['經濟部水利署水利規劃分署', '淡水河水系五股疏左堤防加高影響水工模型試驗計畫', true],
  ['臺中市政府勞工局', '115年度臺中市政府勞工局辦公廳舍裝修委託設計服務案', true],
  ['臺灣港務股份有限公司', '『臺中港老舊防波堤、海堤及護岸整建工程』委託規劃設計監造技術服務', true],
  ['農業部農田水利署', '115年度西螺分處西螺站各級渠道疏濬工作第二次開口契約', false],
  ['台灣自來水股份有限公司第四區管理處', '115-116年度沙鹿所(沙鹿、梧棲含港區)用戶新改裝工作單價採購', false],
  ['雲林縣崙背鄉公所', '115年度崙背鄉路燈裝設及維護開口契約', false],
  ['南投縣集集鎮公所', '「集集鎮115年度濁水溪盃及鎮長盃桌球邀請賽暨水資源宣導活動」委託專業服務採購案', false],
  ['台灣電力股份有限公司', '離岸風力發電廠運維中心辦公室暨倉庫統包工程營造險自115年7月13日展延保險期間至115年12月31日', false],
  ['臺中市政府', '115年度資訊設備維護案', false],
];

console.log('\n[3] 金鑰');
const hasKey = hasJevKey();
check(hasKey, '讀得到 TYPESAFE_API_KEY（行程變數或 HKCU\\Environment）', hasKey ? '有（不印值）' : '沒有');

if (hasKey) {
  console.log('\n[4] 實際呼叫 Jev：13 筆已知答案（逐案、8 併發）');
  const stamp = Date.now().toString(36);   // 避免撞到舊工作與分數快取
  const items = CASES.map(([org, name], i) => ({ pk: `JEV${stamp}${i}`, url: '', orgName: org, caseNo: `S${i}`, tenderName: `${name}（smoke ${stamp}）`, amount: 1000 - i, date: '115/09/17' }));
  const job = await createRankJob({ topic: TOPIC, keywords: ['委託規劃設計監造'], source: 'export', conditions: 'smoke-jev', items, engine: 'jev' });
  check(job.engine === 'jev' && job.model === 'jev-latest', '工作記錄引擎與模型', `${job.engine}/${job.model}`);
  await setRankState(job.id, 'running');
  const t0 = Date.now();
  await runRankJob(job.id, { maxMinutes: 5 });
  const done = await loadRankJob(job.id);
  check(done.state === 'done', '工作完成', `${done.message}｜${Math.round((Date.now() - t0) / 1000)} 秒｜${done.usage.calls} 次呼叫`);
  check(done.usage.calls === CASES.length, '一案一請求（不批次）', `${done.usage.calls} 次`);
  check(done.items.every(i => i.score >= 0), '全部有分數');
  check(!done.recheckTerms, '沒有走 Groq 的複查階段');
  const byName = n => done.items.find(i => i.tenderName.startsWith(n));
  console.log('        ' + CASES.map(([, n, w]) => `${w ? '是' : '否'}${byName(n).score} ${n.slice(0, 14)}`).join('\n        '));
  const hi = byName('臺中市政府運動局場館零星修繕工程委託監造設計案');
  check(hi.score >= 2, '「零星修繕工程委託監造設計案」高分', String(hi.score));
  const lo = byName('115年度西螺分處西螺站各級渠道疏濬工作');
  check(lo.score <= 1, '「疏濬工作」低分', String(lo.score));
  const lo2 = byName('115-116年度沙鹿所');
  check(lo2.score <= 1, '「用戶新改裝工作」低分', String(lo2.score));
  let right = 0;
  const wrong = [];
  for (const [, name, want] of CASES) {
    const it = byName(name);
    if ((it.score >= 2) === want) right++; else wrong.push(`${name.slice(0, 16)}…=${it.score}`);
  }
  check(right >= 11, '13 筆至少 11 筆方向正確', `${right}/13${wrong.length ? '；錯：' + wrong.join('、') : ''}`);
  check(byName('『臺中港老舊防波堤').group === 'A', '命中必納關鍵字的進 A 組');

  console.log('\n[5] 分數快取：同名稱的新 jev 工作零呼叫');
  const items2 = items.map(i => ({ ...i, pk: i.pk + 'C' }));
  const j2 = await createRankJob({ topic: TOPIC, keywords: [], source: 'export', conditions: 'smoke-jev-cache', items: items2, engine: 'jev' });
  await setRankState(j2.id, 'running');
  await runRankJob(j2.id);
  const j2b = await loadRankJob(j2.id);
  check(j2b.state === 'done' && j2b.usage.calls === 0 && j2b.items.every(i => i.score >= 0), '全部從快取取得', `${j2b.usage.calls} 次呼叫`);

  console.log('\n[6] 金鑰沒寫進工作檔或快取');
  const key = envOrRegistry('TYPESAFE_API_KEY');
  const files = await Promise.all([
    readFile(new URL(`./.cache/rankings/${job.id}.json`, import.meta.url), 'utf8'),
    readFile(new URL('./.cache/ai-scores.json', import.meta.url), 'utf8'),
  ]);
  check(files.every(f => !f.includes(key)), '工作檔與 ai-scores.json 都不含金鑰');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} 項 FAIL`}（通過 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
