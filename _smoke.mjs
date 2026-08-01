import { fetchAndFilterTenders } from './build/services/tender-service.js';
import { toROCNumber } from './build/utils/date.js';

const f = (o = {}) => ({
  publishFrom: toROCNumber(o.pf), publishTo: toROCNumber(o.pt),
  deadlineFrom: toROCNumber(o.df), deadlineTo: toROCNumber(o.dt),
});

async function t(label, kw, o) {
  const r = await fetchAndFilterTenders(kw, f(o));
  const pub = [...new Set(r.results.map(x => x.publishDate))].sort();
  const end = [...new Set(r.results.map(x => x.deadline))].sort();
  console.log(`\n■ ${label}`);
  console.log(`  掃描 ${r.totalBeforeFilter} 筆 → 符合 ${r.results.length} 筆`);
  console.log(`  公告日範圍: ${pub[0] ?? '-'} … ${pub.at(-1) ?? '-'}`);
  console.log(`  截止日範圍: ${end[0] ?? '-'} … ${end.at(-1) ?? '-'}`);
  r.results.slice(0, 3).forEach(x => console.log(`   · ${x.caseId.padEnd(14)} 公告=${x.publishDate} 截止=${x.deadline} ${x.title.slice(0, 24)}`));
  return r;
}

console.log('=== toROCNumber 解析 ===');
['115/07/01', '1150701', '115-7-1', '2026/07/01', '2026-07-01', '20260701', '亂打', ''].forEach(s =>
  console.log(`  ${JSON.stringify(s).padEnd(14)} → ${toROCNumber(s)}`));

const base = await t('A. 室內裝修 無日期條件', '室內裝修');
await t('B. 室內裝修 公告日 115/07/28~115/07/31', '室內裝修', { pf: '115/07/28', pt: '115/07/31' });
await t('C. 室內裝修 截止投標 115/08/01~115/08/07', '室內裝修', { df: '115/08/01', dt: '115/08/07' });
await t('D. 室內裝修 公告+截止 同時給', '室內裝修', { pf: '115/07/27', pt: '115/07/31', df: '115/08/05', dt: '115/08/20' });
await t('E. 西元格式 2026-07-28~2026-07-31 應等同 B', '室內裝修', { pf: '2026-07-28', pt: '2026-07-31' });
await t('F. 翻頁測試：關鍵字「工程」無條件', '工程');
