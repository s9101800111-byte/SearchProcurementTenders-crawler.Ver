import { extractPk, fetchTenderDetails, MAX_FETCH_PER_CALL } from './build/services/detail-crawler.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' :: ' + extra : ''}`); }
};

console.log('--- 1. extractPk 解析 ---');
ok(extractPk('https://web.pcc.gov.tw/prkms/urlSelector/common/tpam?pk=NzEyOTA0MjQ=') === 'NzEyOTA0MjQ=', '列表的 tpam?pk= 連結');
ok(extractPk('https://web.pcc.gov.tw/tps/QueryTender/query/searchTenderDetail?pkPmsMain=NzEyOTA0MjQ=') === 'NzEyOTA0MjQ=', '內頁的 pkPmsMain= 連結');
ok(extractPk('NzEyOTA0MjQ=') === 'NzEyOTA0MjQ=', '純 pk');
ok(extractPk('  NzEyOTA0MjQ=  ') === 'NzEyOTA0MjQ=', '前後空白');
ok(extractPk('這不是連結') === null, '無效輸入回 null');
ok(extractPk('') === null, '空字串回 null');

console.log('\n--- 2. 實際抓取一筆（可能遇流量控制）---');
const PK = 'NzEyOTA0MjQ='; // LAF-115007 法律扶助基金會室內裝修
const r1 = await fetchTenderDetails([PK]);
const d1 = r1.details[0];
console.log(`  ok=${d1.ok} cached=${d1.cached} reason=${d1.reason ?? '-'} fetched=${r1.fetched} blocked=${r1.blocked}`);

if (d1.ok) {
  ok(!!d1.fields['標的分類'], '有標的分類', JSON.stringify(d1.fields['標的分類']));
  ok(!!d1.fields['廠商資格摘要'], '有廠商資格摘要');
  ok(/\d{2}:\d{2}/.test(d1.fields['截止投標'] || ''), '截止投標含時分', d1.fields['截止投標']);
  console.log(`     標的分類 = ${d1.fields['標的分類']}`);
  console.log(`     截止投標 = ${d1.fields['截止投標']}`);

  console.log('\n--- 3. 快取：同一筆再查應為 0 次連線 ---');
  const r2 = await fetchTenderDetails([PK]);
  ok(r2.fetched === 0, '第二次 fetched === 0', `實際 ${r2.fetched}`);
  ok(r2.details[0].cached === true, '標記為 cached');
  ok(r2.details[0].fields['標的分類'] === d1.fields['標的分類'], '快取內容一致');
} else {
  console.log('  (目前被流量控制擋住，改驗證「誠實降級」行為)');
  ok(d1.reason === 'captcha', 'reason 標記為 captcha', d1.reason);
  ok(r1.blocked === true, 'blocked 旗標為 true');
  ok(Object.keys(d1.fields).length === 0, '不回傳半殘欄位');
  ok(!!d1.url, '仍附上內頁連結供人工開啟');

  console.log('\n--- 3. 被擋後應中止後續、不再連線 ---');
  const r3 = await fetchTenderDetails([PK, 'NzEyODc5ODg=', 'NzEyODk3MTc=']);
  ok(r3.fetched <= 1, '被擋後不繼續打完整批', `fetched=${r3.fetched}`);
  ok(r3.details.every(d => !d.ok), '整批都標記未取得');
}

console.log('\n--- 4. 無效輸入不會炸掉 ---');
const r4 = await fetchTenderDetails(['這不是連結']);
ok(r4.details[0].ok === false && r4.details[0].reason === 'parse', '無效輸入回 parse 失敗');
ok(r4.fetched === 0, '無效輸入不發出請求');

console.log(`\n=== PASS ${pass} / FAIL ${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
