// 大量回填招標內頁（get_tender_detail 的批次版）。用法見 README「大量回填內頁」。
//   node scripts/backfill-details.mjs <pk清單檔> [--gap 20] [--out results.json]
// pk 清單檔：JSON 陣列，或一行一筆；pk 或 tpam?pk= 連結皆可。
// 行為：間隔 gap 秒連線、已快取的不連線、每筆寫檔（中斷可續跑）、撞驗證碼立即整批停止（不重試）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchTenderDetails, extractPk } from '../build/services/detail-crawler.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const GAP_MS = Number(opt('--gap', '20')) * 1000;
const OUT = resolve(opt('--out', 'backfill-results.json'));
const listFile = args[0];
if (!listFile || !Number.isFinite(GAP_MS) || GAP_MS < 15000) {
  console.error('用法：node scripts/backfill-details.mjs <pk清單檔> [--gap 秒數(≥15)] [--out 輸出檔]');
  process.exit(2);
}

const raw = readFileSync(listFile, 'utf8').trim();
const inputs = raw.startsWith('[') ? JSON.parse(raw) : raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const pks = inputs.map(s => extractPk(s) ?? s);
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' });

let lastFetch = 0, fetched = 0, i = 0, stopped = false;
for (const pk of pks) {
  i++;
  if (results[pk]?.ok) continue;
  const wait = lastFetch + GAP_MS - Date.now();
  if (lastFetch && wait > 0) await sleep(wait);

  const r = await fetchTenderDetails([pk]);
  const d = r.details[0];
  if (r.fetched) { lastFetch = Date.now(); fetched++; }

  results[pk] = d.ok
    ? { ok: true, cached: d.cached, fields: d.fields }
    : { ok: false, reason: d.reason, message: d.message ?? '', url: d.url };
  writeFileSync(OUT, JSON.stringify(results, null, 1), 'utf8');
  console.log(`[${ts()}] ${i}/${pks.length} ${d.ok ? (d.cached ? 'OK(快取)' : 'OK') : 'FAIL ' + d.reason} ${pk} ${d.fields?.['標案名稱'] ?? d.message ?? ''}`);

  if (r.blocked || d.reason === 'captcha') { stopped = true; break; }
}

const ok = pks.filter(pk => results[pk]?.ok).length;
console.log(`[${ts()}] ${stopped ? '撞到驗證碼，已停止（勿重試，冷卻 20 分鐘以上再續跑）。' : '完成。'}成功 ${ok}/${pks.length}，本次連線 ${fetched} 筆，結果：${OUT}`);
process.exit(stopped ? 3 : 0);
