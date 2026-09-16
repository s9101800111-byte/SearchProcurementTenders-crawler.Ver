import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchAndFilterTenders } from "./services/tender-service.js";
import { fetchTenderDetails, KEY_FIELDS, MAX_FETCH_PER_CALL } from "./services/detail-crawler.js";
import { toROCNumber, formatROCNumber } from "./utils/date.js";
import { searchArchive, parseYears, currentROCYear, MIN_ROC_YEAR, MAX_YEARS_PER_CALL } from "./services/archive-service.js";
import { TenderStatusType } from "./types/tender.js";
import {
  queryAwardsByLocations, queryAwardsByVendor, exportAwards, isValidRocNumber, rocNumberToWestern, todayRocNumber, rocDaysBetween,
  AWARD_DATA_START_ROC, MAX_RANGE_DAYS,
} from "./services/award-service.js";
import { resolveCounties, listCounties, OTHER_LOCATION_CODE } from "./services/award-locations.js";
import { ExecLocationOption } from "./types/award.js";
import {
  fetchAwardDetails, renderAwardDetails, MAX_AWARD_FETCH_PER_CALL, MAX_AWARD_CASES,
  DETAIL_WINDOW_MAX, DETAIL_WINDOW_MS, FULL_FIELDS_MAX_CASES,
} from "./services/award-detail-crawler.js";

const server = new McpServer({
  name: "taiwan-tender-searcher",
  version: "0.0.3",
}, {
  // 行為規則放 server instructions：任何 client 掛上這支 MCP 就生效，不依賴 skill 觸發或記憶命中
  instructions: `查台灣政府採購標案的固定作法：

1. 兩個查詢工具的涵蓋範圍**互不重疊**，不可互相取代：
   - search_tenders：只有「等標期內」還能投標的案子（官網 dateType=isSpdt）
   - search_tender_archive：全文檢索電子公報，民國 88 年起，**含已截止的歷史案**
2. 使用者沒有明確限定範圍時，**兩個工具都要跑**，並把結果分成兩段回報：
   「等標期內（還能投標）」與「已截止／歷史案（僅供參考，不能投標）」。
   每段都要標明筆數；某段是 0 筆也要明寫「0 筆」，**不可靜默省略**（省略會被誤讀成沒查過）。
3. 只有使用者明講「只要現在能投的」才可以只跑 search_tenders。
   反之，使用者問的案子查不到時，要先確認是不是已截止、改用 search_tender_archive 再答，
   不要把「工具查不到」講成「這個案子不存在」。
4. 判斷案子性質與可投性，用 get_tender_detail 看「標的分類」與「廠商資格摘要」兩個欄位，
   不要只靠標案名稱關鍵字（分類碼比關鍵字可靠，但資格摘要才決定誰能投）。
5. get_tender_detail 受網站流量控制，一次最多 8 筆未快取的案子。遇到驗證碼頁就附連結
   請使用者人工開啟，**不要重試迴圈，也不要試圖繞過驗證碼**。
6. 查「已決標」案件（某期間／某縣市／某分類的決標案、決標金額）一律用 search_awards，
   **不要用 search_tender_archive 篩決標日期**——archive 的公告日是招標公告日，會篩錯。
7. 要查得標廠商／投標家數／落標廠商，用 get_award_detail（餵 search_awards 表格裡的連結）。
   **不要把決標公告或無法決標公告的連結餵給 get_tender_detail**——pk 屬於不同編號空間，會回傳別的案子。
   get_award_detail 任意 ${DETAIL_WINDOW_MS / 60000} 分鐘內最多 ${DETAIL_WINDOW_MAX} 次內頁請求（種類不符、解析失敗、連線錯誤也會佔額度），
   跨呼叫與跨行程共用，超出的會附最早可再查的時間；遇到驗證碼就停，不要重試。`,
});

server.tool(
  "search_tenders",
  "Search for Taiwan government procurement tenders (web.pcc.gov.tw), optionally narrowed by an announcement-date range (publishFrom/publishTo) and/or a bid-deadline range (deadlineFrom/deadlineTo). Can also search by procuring agency name (orgName, partial match: '空軍' matches '國防部空軍司令部'). At least one of keyword / orgName is required; giving both narrows to tenders matching name AND agency. Note the agency is the one that PUBLISHES the tender, which is often NOT the unit named as the construction site. Scope is limited to tenders still open for bidding (等標期內); closed/historical tenders are not covered. This tool returns a pre-formatted Markdown table. The LLM MUST output this table verbatim to the user without modifying its format, columns, or content.",
  {
    keyword: z.string().optional().describe("Tender-NAME keyword (e.g., 'indoor renovation'). Matches the tender name only - not the case number, not the agency."),
    orgName: z.string().optional().describe("機關名稱，部分比對（例：空軍、國防部空軍司令部）。keyword 與 orgName 至少要給一個。"),
    publishFrom: z.string().optional().describe("公告日期起 (民國或西元皆可：115/07/01、1150701、2026-07-01)"),
    publishTo: z.string().optional().describe("公告日期迄 (同上格式)"),
    deadlineFrom: z.string().optional().describe("截止投標日起 (同上格式)"),
    deadlineTo: z.string().optional().describe("截止投標日迄 (同上格式)"),
  },
  async ({ keyword, orgName, publishFrom, publishTo, deadlineFrom, deadlineTo }) => {
    try {
      if (!keyword && !orgName) {
        return { content: [{ type: "text", text: "請至少給 keyword（標案名稱關鍵字）或 orgName（機關名稱）其中一個。" }] };
      }
      const label = [keyword && `「${keyword}」`, orgName && `機關「${orgName}」`].filter(Boolean).join('＋');
      const raw = { publishFrom, publishTo, deadlineFrom, deadlineTo };
      const filter = {
        publishFrom: toROCNumber(publishFrom),
        publishTo: toROCNumber(publishTo),
        deadlineFrom: toROCNumber(deadlineFrom),
        deadlineTo: toROCNumber(deadlineTo),
      };

      // 有給日期卻解析不出來，直接告訴使用者，不要默默當成不限
      const bad = (Object.keys(raw) as (keyof typeof raw)[])
        .filter(k => raw[k] && filter[k] == null);
      if (bad.length > 0) {
        return { content: [{ type: "text", text: `日期格式無法解析：${bad.map(k => `${k}="${raw[k]}"`).join('、')}。請用 115/07/01 或 2026-07-01 這類格式。` }] };
      }

      const range = (from: number | null, to: number | null) =>
        from == null && to == null ? '' : `${from ? formatROCNumber(from) : '不限'} ~ ${to ? formatROCNumber(to) : '不限'}`;
      const conditions = [
        range(filter.publishFrom, filter.publishTo) && `公告日 ${range(filter.publishFrom, filter.publishTo)}`,
        range(filter.deadlineFrom, filter.deadlineTo) && `截止投標 ${range(filter.deadlineFrom, filter.deadlineTo)}`,
      ].filter(Boolean).join('｜');

      const { results, totalBeforeFilter, hasMore } = await fetchAndFilterTenders(keyword ?? '', filter, orgName);

      if (results.length === 0) {
        const suffix = conditions ? `（條件：${conditions}；等標期內共掃描 ${totalBeforeFilter} 筆）` : '';
        return { content: [{ type: "text", text: `找不到與 ${label} 相關且可投標的案件。${suffix}` }] };
      }

      // 格式化為高品質 Markdown 表格
      let markdownTable = `### ${label} 標案搜尋結果 (共 ${results.length} 筆)\n\n`;
      if (conditions) {
        markdownTable += `> 篩選條件：${conditions}　(等標期內共 ${totalBeforeFilter} 筆，符合 ${results.length} 筆)\n\n`;
      }
      markdownTable += `| 案號 | 標案名稱 | 預算金額 | 公告日 | 截止投標 | 剩餘天數 | 連結 |\n`;
      markdownTable += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

      results.forEach(t => {
        // 標案名稱過長時適度截斷，保持表格美觀
        const displayTitle = t.title.length > 35 ? t.title.substring(0, 33) + '...' : t.title;
        markdownTable += `| **${t.caseId}** | ${displayTitle} | ${t.budget} | ${t.publishDate} | ${t.deadline} | **${t.remainingDays}** | [查看](${t.viewLink}) |\n`;
      });

      if (results.length === 0) {
        markdownTable = `### ${label} 搜尋結果\n\n目前沒有搜尋到相關標案。`;
      } else if (hasMore) {
        markdownTable += `\n> *註：關鍵字命中數超過抓取上限（500 筆），結果可能不完整，請縮小關鍵字或加上日期條件。*\n`;
      }

      return {
        content: [
          {
            type: "text", 
            text: markdownTable
          },
          {
            type: "text",
            text: `(隱藏分析數據：共找到 ${results.length} 筆資料，來源：${(results as any).source || 'web'})`
          }
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `搜尋失敗: ${error.message}` }] };
    }
  }
);

server.tool(
  "get_tender_detail",
  `Fetch the DETAIL page of specific tenders from web.pcc.gov.tw, given the links returned by search_tenders (or raw pk values). Returns fields that the search listing does NOT contain: 標的分類 (category code, e.g. 5177 室內裝潢工程 / 5179 其他裝修工程), 廠商資格摘要 (vendor qualification), 截止投標 with time-of-day, 決標方式, 押標金, 履約地點/期限, and agency contact info. Use this to judge whether a tender really is the type of work the user wants — the category code is far more reliable than keyword matching on the tender name. IMPORTANT: the site rate-limits detail pages; at most ${MAX_FETCH_PER_CALL} uncached tenders per call, results are cached locally so re-querying the same tender is free. If the site returns its CAPTCHA page the remaining items are reported as not-retrieved with their links — do NOT retry in a loop, tell the user to open those links manually. SCOPE: this tool is for TENDER notices (招標公告) only. Award-notice links — 決標公告 (…/common/atm?pk=), 無法決標公告 (…/common/nonAtm?pk=), or any URL carrying pkAtmMain=, which is what search_awards and search_tender_archive return for awards — live in a DIFFERENT key space and are now rejected WITHOUT a request; use get_award_detail for those. (Before this guard, feeding an award pk here silently returned a DIFFERENT tender that happened to share the number.)`,
  {
    cases: z.array(z.string()).min(1).describe("標案內頁連結（search_tenders 回傳的「查看」網址）或 pk 值，一次最多建議 8 筆"),
    full: z.boolean().optional().describe("true 則回傳內頁全部欄位（約 70 項），預設只回精選欄位"),
  },
  async ({ cases, full }) => {
    try {
      const { details, blocked, fetched } = await fetchTenderDetails(cases);

      let out = `### 標案內頁明細（${details.length} 筆）\n\n`;
      const failed: typeof details = [];

      details.forEach((d, i) => {
        if (!d.ok) { failed.push(d); return; }

        const f = d.fields;
        const title = f['標案名稱'] || '(無標案名稱)';
        const caseId = f['標案案號'] || d.pk;
        out += `#### ${i + 1}. ${title}\n`;
        out += `案號 \`${caseId}\`　${d.cached ? '（本地快取）' : '（本次抓取）'}\n\n`;
        out += `| 欄位 | 內容 |\n| :--- | :--- |\n`;

        const keys = full ? Object.keys(f) : KEY_FIELDS.filter(k => f[k]);
        keys.forEach(k => {
          if (k === '標案名稱' || k === '標案案號') return;
          const v = (f[k] || '').replace(/\|/g, '\\|');
          if (!v) return;
          out += `| ${k} | ${v.length > 300 ? v.slice(0, 300) + '…' : v} |\n`;
        });
        out += `\n[開啟內頁](${d.url})\n\n`;
      });

      if (failed.length > 0) {
        out += `---\n\n**以下 ${failed.length} 筆未取得，請自行點開確認：**\n\n`;
        failed.forEach(d => {
          const why = d.reason === 'captcha' ? '網站流量控制（驗證碼）'
            : d.reason === 'award' ? (d.message || '這是決標類公告連結，請改用 get_award_detail')
            : d.reason === 'parse' ? (d.message || '內頁版型不符，可能非一般招標公告')
            : d.message || '連線失敗';
          out += `- ${d.url ? `[${d.pk}](${d.url})` : d.input} — ${why}\n`;
        });
        if (blocked) {
          out += `\n> 政府採購網已對本次連線啟動流量控制。這是網站的防自動化機制，不是違規紀錄。請稍後再試，或在瀏覽器開啟上列連結（會要求點選撲克牌驗證）。**不要重複重試**。\n`;
        }
      }

      out += `\n> 本次實際連線抓取 ${fetched} 筆，其餘來自本地快取。\n`;

      return { content: [{ type: "text", text: out }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `取得標案明細失敗: ${error.message}` }] };
    }
  }
);

server.tool(
  "search_tender_archive",
  `Search the FULL-TEXT bulletin archive (電子公報全文檢索) of web.pcc.gov.tw. This is the ONLY way to find tenders whose bidding period has already CLOSED — search_tenders covers ONLY tenders still open for bidding (等標期內). Covers ROC years ${MIN_ROC_YEAR} to ${currentROCYear()}; the site accepts one year per request, so this tool queries at most ${MAX_YEARS_PER_CALL} years per call. Returns 種類 (招標公告 / 決標公告 / 無法決標公告), 機關名稱, 標案案號, 標案名稱, and BOTH dates the bulletin carries: 招標公告日 and 決標/無法決標公告日, plus 截止投標日期 and a detail link. TWO CORRECTNESS NOTES: (a) the site's own 種類 column labels 無法決標公告 as 決標公告 — this tool re-derives it from the link type (atm vs nonAtm) and the "(無法決標)" suffix, so trust the 種類 column here, not the site's; (b) this tool's publishFrom/publishTo filter and the bulletin's sort key are the 招標公告日, NOT the award date — for "which cases were awarded in period X" use search_awards instead, which filters server-side on 決標公告日. Feed 招標公告 links to get_tender_detail and 決標/無法決標公告 links to get_award_detail (different key spaces). Results are split into 等標期內 (still open) and 已截止／歷史 (closed) sections. Each year returns at most the 100 most recent matches (the site caps one response at 100 rows and its pagination needs a real browser session), and the output states the site-wide hit count whenever it is larger — narrow with a 標案案號, a tighter keyword, or one year per call instead of expecting more rows. Unless the user explicitly asked only for tenders they can still bid on, run this tool ALONGSIDE search_tenders and report both sections with their counts — write "0 筆" explicitly for an empty section instead of omitting it. This tool returns pre-formatted Markdown; output it verbatim without changing its structure.`,
  {
    keyword: z.string().min(1).describe("全文查詢字串。支援布林語法：AND（或 , &）、OR（或 ; |）、NOT（或 !）與括號；含保留字請用雙引號包住。也可直接放標案案號。"),
    years: z.string().optional().describe(`民國年度，官網一次只吃一年，本工具一次最多 ${MAX_YEARS_PER_CALL} 年。可寫 115、114,115、113-115。預設當年（${currentROCYear()}），範圍 ${MIN_ROC_YEAR}~${currentROCYear()}。`),
    statusTypes: z.array(z.enum(["招標", "決標", "公開閱覽及公開徵求", "政府採購預告"])).optional().describe("公報種類，預設 ['招標']。要查決標結果或無法決標請加 '決標'。"),
    publishFrom: z.string().optional().describe("招標公告日期起 (民國或西元皆可：115/07/01、1150701、2026-07-01)"),
    publishTo: z.string().optional().describe("招標公告日期迄 (同上格式)"),
    deadlineFrom: z.string().optional().describe("截止投標日起 (同上格式)"),
    deadlineTo: z.string().optional().describe("截止投標日迄 (同上格式)"),
    fullText: z.boolean().optional().describe("預設 false＝只比對機關名稱與標案名稱。true 會比對公告全文，命中數暴增，只在窄關鍵字時用。"),
  },
  async ({ keyword, years, statusTypes, publishFrom, publishTo, deadlineFrom, deadlineTo, fullText }) => {
    try {
      const { years: yearList, invalid } = parseYears(years);
      if (invalid.length > 0) {
        return { content: [{ type: "text", text: `年度無法解析或超出範圍（${MIN_ROC_YEAR}~${currentROCYear()}）：${invalid.join('、')}。請用民國年，例如 115 或 113-115。` }] };
      }
      if (yearList.length > MAX_YEARS_PER_CALL) {
        return { content: [{ type: "text", text: `一次最多查 ${MAX_YEARS_PER_CALL} 個年度（本次給了 ${yearList.length} 個：${yearList.join('、')}），請分批查詢。` }] };
      }

      const raw = { publishFrom, publishTo, deadlineFrom, deadlineTo };
      const filter = {
        publishFrom: toROCNumber(publishFrom),
        publishTo: toROCNumber(publishTo),
        deadlineFrom: toROCNumber(deadlineFrom),
        deadlineTo: toROCNumber(deadlineTo),
      };
      // 有給日期卻解析不出來，直接告訴使用者，不要默默當成不限
      const bad = (Object.keys(raw) as (keyof typeof raw)[]).filter(k => raw[k] && filter[k] == null);
      if (bad.length > 0) {
        return { content: [{ type: "text", text: `日期格式無法解析：${bad.map(k => `${k}="${raw[k]}"`).join('、')}。請用 115/07/01 或 2026-07-01 這類格式。` }] };
      }

      const kinds = (statusTypes ?? ["招標"]) as TenderStatusType[];
      const { results, scanned, siteTotal, truncated } = await searchArchive(
        keyword, yearList, kinds, filter, { matchNameOnly: !fullText }
      );

      const scope = `${yearList.join('、')} 年度公報｜種類 ${kinds.join('、')}｜${fullText ? '全文比對' : '只比對機關名與標案名'}`;
      if (results.length === 0) {
        return { content: [{ type: "text", text: `### 全文檢索「${keyword}」：0 筆\n\n> 範圍：${scope}\n> 官網該關鍵字命中 ${siteTotal} 筆，本次掃描 ${scanned} 筆，套用日期條件後 0 筆。\n\n查不到不代表案子不存在——可放寬年度、改用標案案號當關鍵字，或加 fullText=true 比對公告全文。` }] };
      }

      const open = results.filter(r => !r.closed);
      const closed = results.filter(r => r.closed);

      const table = (rows: typeof results) => {
        let t = `| 種類 | 機關 | 案號 | 標案名稱 | 招標公告日 | 決標/無法決標公告日 | 截止投標 | 狀態 | 連結 |\n`;
        t += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
        rows.forEach(r => {
          const title = r.title.length > 35 ? r.title.slice(0, 33) + '...' : r.title;
          t += `| ${r.kind} | ${r.orgName} | **${r.caseId}** | ${title} | ${r.publishDate || '-'} | ${r.awardDate || '-'} | ${r.deadline || '-'} | ${r.status} | ${r.link ? `[查看](${r.link})` : '-'} |\n`;
        });
        return t;
      };

      let out = `### 全文檢索「${keyword}」（共 ${results.length} 筆）\n\n> 範圍：${scope}\n\n`;
      out += `#### 等標期內（還能投標）：${open.length} 筆\n\n`;
      out += open.length > 0 ? table(open) + '\n' : `（0 筆）\n\n`;
      out += `#### 已截止／歷史案（僅供參考，不能投標）：${closed.length} 筆\n\n`;
      out += closed.length > 0 ? table(closed) + '\n' : `（0 筆）\n\n`;
      out += `> 官網該關鍵字命中 ${siteTotal} 筆，本次掃描 ${scanned} 筆，套用條件後 ${results.length} 筆。\n`;
      if (truncated) {
        out += `> **註：官網命中 ${siteTotal} 筆，但單次只取得最新 100 筆／年度（官網分頁需瀏覽器 session、pageSize 硬上限 100），結果不完整。請縮小條件：改用標案案號、更精準的關鍵字，或逐年分開查。**\n`;
      }
      out += `> 「種類」已依連結型態修正：官網該欄把無法決標公告也寫成「決標公告」，本表以 atm／nonAtm 與「(無法決標)」後綴判定。\n`;
      out += `> 日期有兩欄：「招標公告日」是公報排序與本工具日期篩選的依據；「決標/無法決標公告日」是決標側的日期。**要依決標期間查案件請用 search_awards**，用本工具的日期條件會篩到招標公告日。\n`;
      out += `> 招標公告的「查看」連結可餵給 get_tender_detail；決標／無法決標公告的連結要餵 get_award_detail（兩者 pk 屬不同編號空間）。\n`;

      return { content: [{ type: "text", text: out }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `全文檢索失敗: ${error.message}` }] };
    }
  }
);

server.tool(
  "search_awards",
  `Query AWARDED cases (決標公告) from web.pcc.gov.tw's award-query endpoint (決標查詢 readTenderAgent). Use this — NOT search_tender_archive — for any question about awards in a period (決標案件、決標金額、某期間某縣市的決標): search_tender_archive's date is the 招標公告日 and gives wrong answers for award dates. Server-side filters verified to work: 決標公告日 range (from/to), 標的分類 (category), 履約地點 (counties — status 決標 only, see limit 5; each county auto-expands to ALL of its site codes, including the separate 原住民地區 codes and legacy pre-merger county codes such as 臺中縣, queried one by one and merged/deduplicated by 機關＋案號＋決標公告序號), plus 機關名稱 / 標案名稱 partial match and status (決標／無法決標／撤銷). Auto-paginates (100 rows/page, ≥1.5 s between requests; the listing endpoint has no CAPTCHA rate limit, detail pages are never opened). The summary reports, for every site code, 官網共有 N 筆 vs 實抓 M 筆, the total, the sum of 決標金額 and the number of correction notices, and states explicitly when maxRows truncated the result. Site limits: data only from 112/07/01 onward; one call's date range may not exceed ${MAX_RANGE_DAYS} days. The listing has NO winning-vendor column. When there are more rows than previewRows, ALL rows are written to CSV (UTF-8 with BOM, Chinese headers) and JSON under the project's .cache/exports/ and both absolute paths are returned. SEMANTIC LIMITS — tell the user whenever they affect the answer: (1) 決標公告日 ≠ 決標日: the notice usually lags the award by 1~20 days, so the right end of a recent range is structurally UNDERCOUNTED (re-query around T+30 days for completeness). (2) 履約地點 is a coarse field self-reported by the agency; it is NOT necessarily the actual work site. (3) There is an 「其他」 bucket (EXECUTE_LOCATION_20000007): cases of agencies located in the requested counties are sometimes filed there — set includeOther=true to add it (the bucket is nationwide, so judge its rows by 機關名稱). (4) Rows flagged 更正公告 show the CORRECTION date, not the original award notice date (the original can be much earlier); the date filter matches original OR correction date. (5) The 履約地點 filter does NOT work for 無法決標 notices (measured 勞務 115/07/11~09/11: 3,960 nationwide vs 6 for 臺中市 and 0 for 雲林縣; 撤銷 results likewise lose their 無法決標 rows), so status 無法決標／撤銷 combined with counties is REJECTED — query nationwide without counties and narrow with orgName instead. This tool returns pre-formatted Markdown; output it verbatim without changing its structure.`,
  {
    from: z.string().describe("決標公告日起（必填）。民國或西元皆可：115/07/11、1150711、2026-07-11、2026/07/11"),
    to: z.string().optional().describe("決標公告日迄（同上格式），預設今天"),
    category: z.enum(["工程", "財物", "勞務"]).optional().describe("標的分類；不填＝全部"),
    counties: z.array(z.string()).optional().describe("縣市名陣列，例 ['南投縣','臺中市']；台/臺皆可、可省略縣市字（有歧義如「新竹」會要求指明）。每個縣市自動展開成它全部的履約地點代碼（含原住民地區、舊制縣代碼）。不填＝全國。只能搭配 status=決標（官網履約地點篩選對無法決標公告無效）"),
    includeOther: z.boolean().optional().describe("有給 counties 時是否加查履約地點「其他」桶（全國性），預設 false"),
    orgName: z.string().optional().describe("機關名稱，部分比對"),
    tenderName: z.string().optional().describe("標案名稱，部分比對"),
    status: z.enum(["決標", "無法決標", "撤銷"]).optional().describe("標案狀態，預設 決標（決標公告）。無法決標／撤銷 不可搭配 counties，要縮小範圍請用 orgName"),
    maxRows: z.number().int().min(1).max(3000).optional().describe("最多回傳幾列，預設 500，上限 3000"),
    previewRows: z.number().int().min(0).max(500).optional().describe("回傳文字的表格只列前幾列，預設 50；結果多於此數時全部結果另存 CSV＋JSON"),
  },
  async ({ from, to, category, counties, includeOther, orgName, tenderName, status, maxRows, previewRows }) => {
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
    try {
      const cap = maxRows ?? 500;
      const preview = previewRows ?? 50;
      const st = status ?? "決標";

      // 有給日期卻解析不出來，直接告訴使用者，不要默默當成不限
      const fromN = toROCNumber(from);
      const toN = to ? toROCNumber(to) : todayRocNumber();
      const bad = [
        (fromN == null || !isValidRocNumber(fromN)) && `from="${from}"`,
        (toN == null || !isValidRocNumber(toN)) && `to="${to}"`,
      ].filter(Boolean);
      if (bad.length > 0 || fromN == null || toN == null) {
        return reply(`日期格式無法解析：${bad.join('、')}。請用 115/07/11 或 2026-07-11 這類格式（無法解析的日期不會被當成不限日期）。`);
      }
      if (fromN > toN) {
        return reply(`決標公告日起 ${formatROCNumber(fromN)} 晚於迄 ${formatROCNumber(toN)}，請對調。`);
      }
      if (toN < AWARD_DATA_START_ROC) {
        return reply(`官網決標查詢只提供 112/07/01 之後的資料，${formatROCNumber(fromN)} ~ ${formatROCNumber(toN)} 整段早於此，查不到。更早的決標案只能用 search_tender_archive 全文檢索（其日期是招標公告日）。`);
      }
      const notes: string[] = [];
      let effFrom = fromN;
      if (fromN < AWARD_DATA_START_ROC) {
        effFrom = AWARD_DATA_START_ROC;
        notes.push(`起日 ${formatROCNumber(fromN)} 早於官網資料下限 112/07/01，已改從 112/07/01 起查；更早的決標案此端點不提供。`);
      }
      const days = rocDaysBetween(effFrom, toN);
      if (days > MAX_RANGE_DAYS) {
        return reply(`決標公告日區間 ${formatROCNumber(effFrom)} ~ ${formatROCNumber(toN)} 相差 ${days} 天，超過官網未登入查詢上限 ${MAX_RANGE_DAYS} 天。請分段查詢；分段合併時更正公告可能在兩段各出現一次，要以 機關＋案號 去重。`);
      }

      let locations: ExecLocationOption[];
      let scopeText: string;
      if (counties && counties.some(c => c.trim())) {
        // 官網履約地點篩選對無法決標公告（nonAtm）幾乎無效，照查會回嚴重偏低的筆數，寧可拒絕
        if (st !== '決標') {
          return reply(`status=${st} 不能搭配 counties：官網的「履約地點」篩選對無法決標公告幾乎無效（撤銷查詢裡的無法決標列也一樣），照查會得到嚴重偏低的筆數，不能當成該縣市的清單，所以本工具不接受這個組合。

實測（勞務、115/07/11~09/11）：無法決標全國 3,960 筆，但履約地點＝臺中市只有 6 筆、雲林縣 0 筆，全國結果裡的「臺中市豐原區公所 11506B」不在臺中市代碼的結果中；撤銷查詢的決標公告列篩得到，無法決標列（例：新北市政府消防局、臺北市濱江實驗國民中學、國立土庫高級商工職業學校）在各自縣市代碼下都篩不到。

改法：拿掉 counties 改查全國（官網總數才正確），用 orgName 以機關名稱縮小，例如 orgName="臺中市" 會命中臺中市政府各局處、區公所、市立學校；中央機關或國立學校在該縣市的案子不會命中，要另外用機關名查。結果超過 maxRows 時請縮短日期區間。`);
        }
        const { groups, invalid } = resolveCounties(counties);
        if (invalid.length > 0) {
          const why = invalid.map(i => i.candidates.length > 0 ? `「${i.input}」有歧義：${i.candidates.join('／')}` : `「${i.input}」`).join('；');
          return reply(`縣市名無法辨識：${why}。可用縣市：${listCounties().join('、')}`);
        }
        locations = groups.flatMap(g => g.locations);
        scopeText = groups.map(g => `${g.county}（${g.locations.length} 個代碼）`).join('、');
        if (includeOther) {
          locations.push({ code: OTHER_LOCATION_CODE, label: '其他' });
          scopeText += '＋「其他」桶（全國性）';
        }
      } else {
        locations = [{ code: '', label: '不限（全國）' }];
        scopeText = '全國（不限）';
        if (includeOther) notes.push('未指定 counties 時本來就是全國查詢（已含「其他」），includeOther 不另外查。');
      }

      const r = await queryAwardsByLocations(
        { from: effFrom, to: toN, category, orgName, tenderName, status: st },
        locations,
        { maxRows: cap },
      );

      const fmt = (n: number) => n.toLocaleString('en-US');
      const statusText = st === '決標' ? '決標公告' : st === '撤銷' ? '撤銷公告' : '無法決標';
      const cond = [
        `決標公告日 ${formatROCNumber(effFrom)} ~ ${formatROCNumber(toN)}（送出 ${rocNumberToWestern(effFrom)}~${rocNumberToWestern(toN)}）`,
        `標的分類 ${category ?? '不限'}`,
        `狀態 ${statusText}`,
        `履約地點 ${scopeText}`,
        orgName && `機關含「${orgName}」`,
        tenderName && `標案名稱含「${tenderName}」`,
      ].filter(Boolean).join('｜');

      // 有代碼沒拿到官網總數時，加總只是下限
      const siteTotalTxt = (r.siteTotalIsLowerBound ? '至少 ' : '') + fmt(r.siteTotal);
      let out = `### 決標查詢：回傳 ${fmt(r.rows.length)} 筆（官網共有 ${siteTotalTxt} 筆）\n\n> 條件：${cond}\n\n`;
      out += `#### 各履約地點代碼\n\n`;
      for (const p of r.perLocation) {
        const state = p.skipped ? '未查（前面已遭官網封鎖）'
          : p.error ? `失敗：${p.error}`
          : p.truncated ? '達 maxRows 截斷'
          : p.fetched === p.siteTotal ? '完整' : '筆數不符';
        out += `- ${p.label}（${p.code || '不限'}）：官網共有 ${p.siteTotal == null ? '?' : fmt(p.siteTotal)} 筆／實抓 ${fmt(p.fetched)} 筆｜${state}\n`;
      }

      const withAmount = r.rows.filter(x => x.amount != null);
      const amountSum = withAmount.reduce((s, x) => s + (x.amount ?? 0), 0);
      const corrections = r.rows.filter(x => x.isCorrection).length;
      out += `\n#### 摘要\n\n`;
      out += `- 總筆數：官網共有 ${siteTotalTxt} 筆；實抓 ${fmt(r.fetchedTotal)} 筆；合併去重後回傳 ${fmt(r.rows.length)} 筆`;
      out += r.duplicates > 0 ? `（去除重複 ${r.duplicates} 筆，鍵＝機關＋案號＋決標公告序號）\n` : `\n`;
      out += `- 決標金額合計：${fmt(amountSum)} 元（${fmt(withAmount.length)} 筆有金額；未公開／空白 ${fmt(r.rows.length - withAmount.length)} 筆不計）\n`;
      out += `- 更正公告：${fmt(corrections)} 筆（這些列顯示的是更正日，不是原決標公告日）\n`;
      if (r.truncated) {
        out += `- **已截斷：官網共有 ${siteTotalTxt} 筆，maxRows=${cap}，實際只回傳 ${fmt(r.rows.length)} 筆。要完整結果請調高 maxRows（上限 3000）或縮小條件。**\n`;
      }
      if (r.hasError) {
        out += `- **有代碼查詢失敗或未查，結果不完整（見上方各代碼狀態）。**\n`;
      }
      if (st === '撤銷') notes.push('撤銷公告列的日期欄可能是原公告日而非撤銷日（實測出現區間外日期）。');
      notes.forEach(n => { out += `- ${n}\n`; });
      out += `- 本次連線 ${r.requests} 次（僅清單端點，未開內頁）\n`;
      out += `\n> 提醒：決標公告日 ≠ 決標日，公告通常落後 1～20 天，區間右端會低估｜履約地點是機關自填的粗欄位，不等於實際施作地｜有「其他」桶，本次${locations.some(l => l.code === OTHER_LOCATION_CODE || l.code === '') ? '已涵蓋' : '未查（可加 includeOther=true）'}｜清單沒有得標廠商欄位\n`;

      if (r.rows.length > preview) {
        try {
          const { csvPath, jsonPath } = await exportAwards(r.rows, {
            query: { from: formatROCNumber(effFrom), to: formatROCNumber(toN), category: category ?? null, status: st, counties: counties ?? null, includeOther: Boolean(includeOther), orgName: orgName ?? null, tenderName: tenderName ?? null, maxRows: cap },
            perLocation: r.perLocation,
            siteTotal: r.siteTotal,
            truncated: r.truncated,
          });
          out += `\n**全部 ${fmt(r.rows.length)} 筆已匯出（下表只列前 ${preview} 筆）：**\n- CSV：${csvPath}\n- JSON：${jsonPath}\n`;
        } catch (e: any) {
          out += `\n**匯出檔寫入失敗：${e.message}**（下表只列前 ${preview} 筆，其餘沒有輸出）\n`;
        }
      }

      if (r.rows.length === 0) {
        out += `\n（0 筆）\n`;
      } else if (preview > 0) {
        const cellText = (s: string) => s.replace(/\|/g, '\\|');
        out += `\n#### 前 ${Math.min(preview, r.rows.length)} 筆\n\n`;
        out += `| 決標公告日 | 履約地點 | 機關 | 案號 | 標案名稱 | 招標方式 | 決標金額 | 更正 | 連結 |\n`;
        out += `| :--- | :--- | :--- | :--- | :--- | :--- | ---: | :--- | :--- |\n`;
        for (const x of r.rows.slice(0, preview)) {
          const place = (locations.find(l => l.code === x.execLocation)?.label ?? '').replace('(非原住民地區)', '');
          const title = x.tenderName.length > 35 ? x.tenderName.slice(0, 33) + '...' : x.tenderName;
          const link = x.url ? `[${x.isNonAward ? '無法決標公告' : '決標公告'}](${x.url})` : '-';
          out += `| ${x.awardNoticeDate} | ${place} | ${cellText(x.orgName)} | ${cellText(x.caseNo)} | ${cellText(title)} | ${x.tenderWay} | ${x.amount == null ? (x.isNonAward ? '-' : '未公開') : fmt(x.amount)} | ${x.isCorrection ? '更正' : ''} | ${link} |\n`;
        }
      }

      return reply(out);
    } catch (error: any) {
      return reply(`決標查詢失敗: ${error.message}`);
    }
  }
);

server.tool(
  "get_award_detail",
  `Fetch the AWARD NOTICE detail page (決標公告內頁 QueryAtmAwardDetail, or 無法決標公告 QueryAtmNonAwardDetail) for cases given as the links in search_awards' table (or raw pk values). This is the ONLY complete source of winning vendors — the award listing has no vendor column. Per case it returns 得標廠商 with 統編, 投標廠商家數, 落標廠商, 預算金額, 總決標金額, 減標率 (1 − 總決標金額/預算金額), 決標方式, 決標日期, 決標公告日期, 履約地點（含地區）, 履約起迄, and a bidder table (序號/廠商名稱/統編/是否得標/中小企業/地址/決標金額); 無法決標 notices show the reason and dates. full=true appends every field on the page, but only for the first ${FULL_FIELDS_MAX_CASES} successful cases (the rest get the summary table only). LIMITS — tell the user whenever they affect the answer: (1) RATE LIMIT: the site CAPTCHA-locks detail pages after roughly 5~8 consecutive requests (the lock lasts 20+ minutes), so each call makes at most ${MAX_AWARD_FETCH_PER_CALL} detail-page requests, sequentially and ≥3 s apart, and this server makes at most ${DETAIL_WINDOW_MAX} detail-page requests in ANY rolling ${DETAIL_WINDOW_MS / 60000}-minute window, shared across all calls (including concurrent ones) and across MCP processes — 任意 ${DETAIL_WINDOW_MS / 60000} 分鐘內最多 ${DETAIL_WINDOW_MAX} 次內頁請求（種類不符、解析失敗、連線錯誤也會佔額度）; cases whose parse can be trusted are cached locally, and re-querying them is free and does not use that quota. Cases beyond the quota are listed as not retrieved with the earliest time they can be fetched — query them in a LATER call after that time, do not loop. If the CAPTCHA page appears the whole batch stops immediately and this server refuses further detail requests for 20 minutes (cached cases still return): do NOT retry and never try to bypass the CAPTCHA; give the user the links to open manually. (2) 統編 may be MASKED (e.g. F1275*****, sole proprietors / individuals) — it is reported as-is, never guess the hidden digits. (3) 決標公告日期 ≠ 決標日期: the notice usually lags the award by 1~20 days. (4) Pass the FULL link: a bare pk carries no path to tell 決標 from 無法決標, so it is treated as a 決標公告. (5) Tender-notice links (tpam?pk= / searchTenderDetail?pkPmsMain=) are rejected — use get_tender_detail for 招標公告; conversely never feed 決標／無法決標 links to get_tender_detail (different pk key space, it returns a WRONG case). This tool returns pre-formatted Markdown; output it verbatim without changing its structure.`,
  {
    cases: z.array(z.string()).min(1).max(MAX_AWARD_CASES).describe(`search_awards 表格裡的「決標公告／無法決標公告」連結，或 pk 值（純 pk 預設當決標公告），1~${MAX_AWARD_CASES} 筆；每次最多 ${MAX_AWARD_FETCH_PER_CALL} 次內頁請求，且任意 ${DETAIL_WINDOW_MS / 60000} 分鐘內合計最多 ${DETAIL_WINDOW_MAX} 次內頁請求（跨呼叫與跨行程共用）`),
    full: z.boolean().optional().describe(`true 則另附內頁全部欄位（只列前 ${FULL_FIELDS_MAX_CASES} 筆成功案），預設 false 只回精選欄位與投標廠商表`),
  },
  async ({ cases, full }) => {
    try {
      const batch = await fetchAwardDetails(cases);
      return { content: [{ type: "text", text: renderAwardDetails(batch, { full: Boolean(full) }) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `取得決標公告內頁失敗: ${error.message}` }] };
    }
  }
);

server.tool(
  "find_awards_by_vendor",
  `Find which cases a VENDOR won (and optionally which it merely bid on and lost) from web.pcc.gov.tw's award-query listing. Give a 統一編號 (8 digits, exact and safest) or a company name (PARTIAL match: 「中興工程顧問」 also matches 「中興工程顧問社」, a different company). Verified live 2026-09-16: gottenVendorId / gottenVendorName / submitVendorId / submitVendorName all filter server-side, and the listing endpoint has NO CAPTCHA rate limit, so one vendor costs about one request — this is the fast way to answer "what has firm X won lately", competitor tracking, or checking a vendor before working with them. includeBids=true additionally queries the BIDDER field and reports 投標但未得標 cases (won set subtracted), which otherwise would require opening each award notice. Results are NATIONWIDE (no 履約地點 filter) within the 決標公告日 range; the site only covers 112/07/01 onward and one call's range may not exceed ${MAX_RANGE_DAYS} days. The listing gives 決標金額 but NOT the vendor's own share in a joint bid — use get_award_detail on a specific case for bidder-level numbers. CAVEATS: (1) name matching is substring-based, so a short name can pull in unrelated firms and a firm registered under a slightly different legal name will be missed — prefer 統一編號; (2) 決標公告日 ≠ 決標日 (the notice lags 1~20 days), so recent cases may not be listed yet; (3) rows flagged 更正公告 show the correction date. This tool returns pre-formatted Markdown; output it verbatim.`,
  {
    vendors: z.array(z.string().min(2)).min(1).max(20).describe("廠商統一編號（8 碼數字，精準）或廠商名稱（部分比對），一次最多 20 家"),
    from: z.string().describe("決標公告日起（必填）。民國或西元皆可：115/07/11、1150711、2026-07-11"),
    to: z.string().optional().describe("決標公告日迄（同上格式），預設今天"),
    category: z.enum(["工程", "財物", "勞務"]).optional().describe("標的分類；不填＝全部"),
    includeBids: z.boolean().optional().describe("true 則另查「投標廠商」欄，列出投標但未得標的案子（每家多一次請求），預設 false"),
    maxRowsPerVendor: z.number().int().min(1).max(1000).optional().describe("每家廠商最多回傳幾列，預設 200"),
    previewRows: z.number().int().min(0).max(200).optional().describe("每家在表格中最多列出幾列，預設 30；超過的全部結果會另存 CSV＋JSON"),
  },
  async ({ vendors, from, to, category, includeBids, maxRowsPerVendor, previewRows }) => {
    const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
    try {
      const cap = maxRowsPerVendor ?? 200;
      const preview = previewRows ?? 30;

      const fromN = toROCNumber(from);
      const toN = to ? toROCNumber(to) : todayRocNumber();
      if (fromN == null || !isValidRocNumber(fromN) || toN == null || !isValidRocNumber(toN)) {
        return reply(`日期格式無法解析：${fromN == null || !isValidRocNumber(fromN) ? `from="${from}"` : ''}${toN == null || !isValidRocNumber(toN) ? ` to="${to}"` : ''}。請用 115/07/11 或 2026-07-11 這類格式。`);
      }
      if (fromN > toN) return reply(`起日 ${formatROCNumber(fromN)} 晚於迄日 ${formatROCNumber(toN)}，請對調。`);
      if (toN < AWARD_DATA_START_ROC) return reply(`官網決標查詢只提供 112/07/01 之後的資料，${formatROCNumber(fromN)} ~ ${formatROCNumber(toN)} 整段早於此。`);
      const effFrom = Math.max(fromN, AWARD_DATA_START_ROC);
      const days = rocDaysBetween(effFrom, toN);
      if (days > MAX_RANGE_DAYS) {
        return reply(`決標公告日區間相差 ${days} 天，超過官網上限 ${MAX_RANGE_DAYS} 天，請分段查詢。`);
      }

      const fmt = (n: number) => n.toLocaleString('en-US');
      const uniq = [...new Set(vendors.map(v => v.trim()).filter(Boolean))];
      const results = [];
      for (const v of uniq) {
        results.push(await queryAwardsByVendor(
          { from: effFrom, to: toN, category, status: '決標' },
          v,
          { maxRows: cap, includeBids: Boolean(includeBids) },
        ));
        if (results[results.length - 1].blocked) break;
      }

      let out = `### 廠商反查決標案件（${results.length} 家）\n\n`;
      out += `> 決標公告日 ${formatROCNumber(effFrom)} ~ ${formatROCNumber(toN)}｜標的分類 ${category ?? '不限'}｜全國（不限履約地點）｜${includeBids ? '含投標未得標' : '只查得標'}\n\n`;

      const allRows: typeof results[number]['won'] = [];
      for (const r of results) {
        const wonAmt = r.won.reduce((s, x) => s + (x.amount ?? 0), 0);
        out += `#### ${r.vendor}${r.byId ? '（統編）' : '（名稱部分比對）'}\n\n`;
        if (r.error) out += `- **查詢異常：${r.error}**\n`;
        out += `- 得標 ${fmt(r.won.length)} 件（官網共 ${fmt(r.siteTotalWon)} 件）｜決標金額合計 ${fmt(wonAmt)} 元\n`;
        if (includeBids) {
          out += r.siteTotalBid == null
            ? `- 投標未得標：未查詢\n`
            : `- 投標未得標 ${fmt(r.lost.length)} 件（投標總計 ${fmt(r.siteTotalBid)} 件，扣掉得標 ${fmt(r.won.length)} 件）\n`;
        }
        if (r.truncated) out += `- **已達 maxRowsPerVendor=${cap} 截斷，官網件數見上方**\n`;

        const rows = [...r.won.map(x => ({ x, tag: '得標' })), ...r.lost.map(x => ({ x, tag: '投標未得標' }))];
        allRows.push(...r.won, ...r.lost);
        if (rows.length === 0) {
          out += `\n（這個區間內查無案件）\n\n`;
          continue;
        }
        out += `\n| 決標公告日 | 結果 | 機關 | 案號 | 標案名稱 | 決標金額 | 更正 | 連結 |\n`;
        out += `| :--- | :--- | :--- | :--- | :--- | ---: | :--- | :--- |\n`;
        for (const { x, tag } of rows.slice(0, preview)) {
          const title = x.tenderName.length > 32 ? x.tenderName.slice(0, 30) + '...' : x.tenderName;
          const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          out += `| ${x.awardNoticeDate} | ${tag} | ${cell(x.orgName)} | ${cell(x.caseNo)} | ${cell(title)} | ${x.amount == null ? '未公開' : fmt(x.amount)} | ${x.isCorrection ? '更正' : ''} | ${x.url ? `[公告](${x.url})` : '-'} |\n`;
        }
        if (rows.length > preview) out += `\n> 這家還有 ${fmt(rows.length - preview)} 列未列出（見下方匯出檔）。\n`;
        out += `\n`;
      }

      if (allRows.length > preview) {
        try {
          const { csvPath, jsonPath } = await exportAwards(allRows, {
            tool: 'find_awards_by_vendor', vendors: uniq, includeBids: Boolean(includeBids),
            from: formatROCNumber(effFrom), to: formatROCNumber(toN), category: category ?? null,
          });
          out += `**全部 ${fmt(allRows.length)} 列已匯出：**\n- CSV：${csvPath}\n- JSON：${jsonPath}\n\n`;
        } catch (e: any) {
          out += `**匯出檔寫入失敗：${e.message}**\n\n`;
        }
      }

      const blocked = results.some(r => r.blocked);
      if (blocked) out += `> **官網對本次連線啟動流量控制，已停止後續廠商的查詢（清單端點少見，請稍後再試，不要重複重試）。**\n`;
      out += `> 本次連線 ${fmt(results.reduce((s, r) => s + r.requests, 0))} 次（僅清單端點）。\n`;
      out += `> 名稱是部分比對（「中興工程顧問」會連「中興工程顧問社」一起命中），要精準請給 8 碼統一編號；決標公告日落後決標日 1~20 天，最近的案子可能還沒公告。\n`;
      out += `> 清單沒有共同投標時各家的分攤金額，要看個別廠商金額請對該案用 get_award_detail。\n`;

      return reply(out);
    } catch (error: any) {
      return reply(`廠商反查失敗: ${error.message}`);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Taiwan Tender MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server fatal error:", error);
  process.exit(1);
});
