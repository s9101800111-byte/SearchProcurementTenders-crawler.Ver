/**
 * search_tender_archive（全文檢索／已截止歷史案）驗收腳本
 * 跑法：node _smoke_archive.mjs
 * 只打列表頁（不碰標案內頁），沒有流量控制風險。
 */
import { parseYears, currentROCYear, MIN_ROC_YEAR, MAX_YEARS_PER_CALL, searchArchive } from './build/services/archive-service.js';
import { BulletionCrawlerService } from './build/services/bulletion-crawler.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const Y = currentROCYear();

console.log('\n[1] 年度解析');
ok('未給年度預設當年', JSON.stringify(parseYears().years) === JSON.stringify([Y]));
ok('單一年度 115', JSON.stringify(parseYears('115').years) === JSON.stringify([115]));
ok('逗號多年 114,115 由新到舊', JSON.stringify(parseYears('114,115').years) === JSON.stringify([115, 114]));
ok('全形逗號 114，115', parseYears('114，115').years.length === 2);
ok('範圍 113-115 展開三年', JSON.stringify(parseYears('113-115').years) === JSON.stringify([115, 114, 113]));
ok('波浪號範圍 113~114', JSON.stringify(parseYears('113~114').years) === JSON.stringify([114, 113]));
ok('去重 115,115', JSON.stringify(parseYears('115,115').years) === JSON.stringify([115]));
ok(`低於下限 ${MIN_ROC_YEAR - 1} 視為無效`, parseYears(String(MIN_ROC_YEAR - 1)).invalid.length === 1);
ok('未來年度視為無效', parseYears(String(Y + 1)).invalid.length === 1);
ok('非數字視為無效', parseYears('abcd').invalid.length === 1);
ok('部分有效部分無效分開回報', (() => { const r = parseYears('115,9999'); return r.years.length === 1 && r.invalid.length === 1; })());

console.log('\n[2] 公報列表解析（真連線，115 年度「室內裝修」）');
const crawler = new BulletionCrawlerService();
const r1 = await crawler.search({ querySentence: '室內裝修', year: 115, statusTypes: ['招標'] });
ok('有抓到資料列', r1.tenders.length > 0, `tenders=${r1.tenders.length}`);
ok('解析到官網總筆數（數字被 span 包住）', r1.total > 0, `total=${r1.total}`);
ok('單次不超過官網硬上限 100', r1.tenders.length <= BulletionCrawlerService.PAGE_LIMIT, `${r1.tenders.length} 筆`);
ok('每列都有標案名稱（pageCode2Img 抽取成功）', r1.tenders.every(t => t.name.length > 0),
  r1.tenders.filter(t => !t.name).slice(0, 2).map(t => t.caseId).join(','));
ok('每列都有案號', r1.tenders.every(t => t.caseId.length > 0));
ok('案號不含 JS 殘留', r1.tenders.every(t => !/var hw|pageCode2Img/.test(t.caseId)));
ok('每列都有內頁連結且可餵 get_tender_detail', r1.tenders.every(t => /tpam\?pk=/.test(t.link)),
  `${r1.tenders.filter(t => !/tpam\?pk=/.test(t.link)).length} 筆無連結`);
ok('公告日期為民國格式', r1.tenders.every(t => /^\d{3}\/\d{2}\/\d{2}$/.test(t.publishDate)),
  r1.tenders.slice(0, 3).map(t => t.publishDate).join(' '));
ok('種類欄有值', r1.tenders.every(t => t.kind.length > 0));
ok('沒有把表頭當資料', r1.tenders.every(t => t.kind !== '種類'));
ok('key 無重複', new Set(r1.tenders.map(t => t.key)).size === r1.tenders.length);

console.log('\n[3] 截斷誠實回報（官網命中 > 單次可取得筆數時要標 truncated）');
ok('truncated 與 total/筆數一致', r1.truncated === (r1.total > r1.tenders.length),
  `total=${r1.total} rows=${r1.tenders.length} truncated=${r1.truncated}`);
const narrow = await crawler.search({ querySentence: '室內裝修 and 圖書', year: 115, statusTypes: ['招標'] });
ok('窄關鍵字（布林 AND）命中數變少', narrow.total < r1.total, `窄=${narrow.total} 寬=${r1.total}`);
ok('窄關鍵字未被截斷', narrow.total <= 100 ? narrow.truncated === false : true,
  `total=${narrow.total} truncated=${narrow.truncated}`);

console.log('\n[4] 歷史年度含已截止案（114 年度）');
const h = await searchArchive('室內裝修', [114], ['招標'], {});
ok('114 年度抓到資料', h.results.length > 0, `${h.results.length} 筆`);
ok('114 年度全部歸為已截止', h.results.every(x => x.closed),
  h.results.filter(x => !x.closed).slice(0, 2).map(x => `${x.caseId}/${x.deadline}`).join(','));
ok('狀態欄標記為已截止或已決標', h.results.every(x => x.status === '已截止' || x.status === '已決標'),
  [...new Set(h.results.map(x => x.status))].join(','));

console.log('\n[5] 本地日期區間過濾');
const all115 = await searchArchive('室內裝修', [115], ['招標'], {});
const win = await searchArchive('室內裝修', [115], ['招標'], { publishFrom: 1150801, publishTo: 1150831 });
ok('日期區間有收斂結果', win.results.length < all115.results.length,
  `不限=${all115.results.length} 8月=${win.results.length}`);
ok('過濾後公告日都在區間內', win.results.every(x => {
  const n = parseInt(x.publishDate.replace(/\//g, ''), 10);
  return n >= 1150801 && n <= 1150831;
}), win.results.slice(0, 3).map(x => x.publishDate).join(' '));
ok('掃描筆數 >= 過濾後筆數', win.scanned >= win.results.length);

console.log('\n[6] 多年度合併（113~114）');
const multi = await searchArchive('室內裝修', [114, 113], ['招標'], {});
ok('兩年度都有結果', new Set(multi.results.map(r => r.year)).size === 2,
  [...new Set(multi.results.map(r => r.year))].join(','));
ok('筆數為兩年度相加量級', multi.results.length > h.results.length);

console.log('\n[7] 常數合理性');
ok('MIN_ROC_YEAR = 88', MIN_ROC_YEAR === 88);
ok('MAX_YEARS_PER_CALL 介於 1~5', MAX_YEARS_PER_CALL >= 1 && MAX_YEARS_PER_CALL <= 5);
ok('PAGE_LIMIT = 100', BulletionCrawlerService.PAGE_LIMIT === 100);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
