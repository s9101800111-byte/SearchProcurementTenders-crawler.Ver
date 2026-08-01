import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchAndFilterTenders } from "./services/tender-service.js";
import { fetchTenderDetails, KEY_FIELDS, MAX_FETCH_PER_CALL } from "./services/detail-crawler.js";
import { toROCNumber, formatROCNumber } from "./utils/date.js";

const server = new McpServer({
  name: "taiwan-tender-searcher",
  version: "0.0.2",
});

server.tool(
  "search_tenders",
  "Search for Taiwan government procurement tenders (web.pcc.gov.tw), optionally narrowed by an announcement-date range (publishFrom/publishTo) and/or a bid-deadline range (deadlineFrom/deadlineTo). Scope is limited to tenders still open for bidding (等標期內); closed/historical tenders are not covered. This tool returns a pre-formatted Markdown table. The LLM MUST output this table verbatim to the user without modifying its format, columns, or content.",
  {
    keyword: z.string().describe("Search keyword (e.g., 'indoor renovation', 'construction project')"),
    publishFrom: z.string().optional().describe("公告日期起 (民國或西元皆可：115/07/01、1150701、2026-07-01)"),
    publishTo: z.string().optional().describe("公告日期迄 (同上格式)"),
    deadlineFrom: z.string().optional().describe("截止投標日起 (同上格式)"),
    deadlineTo: z.string().optional().describe("截止投標日迄 (同上格式)"),
  },
  async ({ keyword, publishFrom, publishTo, deadlineFrom, deadlineTo }) => {
    try {
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

      const { results, totalBeforeFilter, hasMore } = await fetchAndFilterTenders(keyword, filter);

      if (results.length === 0) {
        const suffix = conditions ? `（條件：${conditions}；等標期內共掃描 ${totalBeforeFilter} 筆）` : '';
        return { content: [{ type: "text", text: `找不到與「${keyword}」相關且可投標的案件。${suffix}` }] };
      }

      // 格式化為高品質 Markdown 表格
      let markdownTable = `### 「${keyword}」標案搜尋結果 (共 ${results.length} 筆)\n\n`;
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
        markdownTable = `### 「${keyword}」搜尋結果\n\n目前沒有搜尋到相關標案。`;
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
  `Fetch the DETAIL page of specific tenders from web.pcc.gov.tw, given the links returned by search_tenders (or raw pk values). Returns fields that the search listing does NOT contain: 標的分類 (category code, e.g. 5177 室內裝潢工程 / 5179 其他裝修工程), 廠商資格摘要 (vendor qualification), 截止投標 with time-of-day, 決標方式, 押標金, 履約地點/期限, and agency contact info. Use this to judge whether a tender really is the type of work the user wants — the category code is far more reliable than keyword matching on the tender name. IMPORTANT: the site rate-limits detail pages; at most ${MAX_FETCH_PER_CALL} uncached tenders per call, results are cached locally so re-querying the same tender is free. If the site returns its CAPTCHA page the remaining items are reported as not-retrieved with their links — do NOT retry in a loop, tell the user to open those links manually.`,
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Taiwan Tender MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server fatal error:", error);
  process.exit(1);
});
