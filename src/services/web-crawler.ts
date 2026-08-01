import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { Tender, SearchParams } from '../types/tender.js';

export class WebCrawlerService {
  private readonly baseUrl = 'https://web.pcc.gov.tw/prkms/tender/common/basic/readTenderBasic';
  
  private readonly defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  /**
   * 依關鍵字抓取「等標期內」標案，自動翻頁直到抓完或達 maxPages 上限。
   *
   * 註：政府採購網的 dateType=isDate（公告日期區間）實測一律回「無符合條件資料」，
   * 連用網站自己的送出程式在瀏覽器操作也一樣，因此日期區間改由本專案在結果上自行過濾。
   */
  async search(params: SearchParams): Promise<{ tenders: Tender[]; truncated: boolean }> {
    const pageSize = params.pageSize ?? 100; // 官網上限 100
    const maxPages = params.maxPages ?? 5;

    const all: Tender[] = [];
    const seen = new Set<string>();
    let pageParam = ''; // displaytag 的翻頁參數名，例如 d-49738-p
    let truncated = false;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1 && !pageParam) break; // 找不到翻頁參數就只取第一頁

      const urlParams = new URLSearchParams({
        pageSize: String(pageSize),
        firstSearch: 'true',
        searchType: 'basic',
        isBinding: 'N',
        isLogIn: 'N',
        level_1: 'on',
        tenderName: params.tenderName,
        tenderType: params.tenderType || 'TENDER_DECLARATION',
        tenderWay: params.tenderWay || 'TENDER_WAY_ALL_DECLARATION',
        dateType: 'isSpdt',
      });
      if (page > 1) urlParams.set(pageParam, String(page));

      const html = await this.fetchHtml(`${this.baseUrl}?${urlParams.toString()}`);
      // 分頁連結在 HTML 裡是 &amp; 編碼過的，別用 [?&] 當前綴去比對
      if (!pageParam) pageParam = html.match(/(d-\d+-p)=/)?.[1] ?? '';

      const rows = this.parseRows(html);
      const fresh = rows.filter(t => !seen.has(t.id));
      fresh.forEach(t => seen.add(t.id));
      all.push(...fresh);

      // 這一頁沒滿或沒有新資料，表示已到最後一頁
      if (rows.length < pageSize || fresh.length === 0) break;

      // 還有下一頁卻已用完頁數配額，標記為截斷，不要假裝抓完了
      if (page === maxPages) truncated = true;
    }

    return { tenders: all, truncated };
  }

  private async fetchHtml(fullUrl: string): Promise<string> {
    try {
      const response = await axios.get(fullUrl, {
        headers: this.defaultHeaders,
        responseType: 'arraybuffer',
        timeout: 20000
      });
      return this.decodeHtml(response.data, response.headers['content-type']);
    } catch (error: any) {
      console.error('Web Crawler Error:', error);
      throw new Error(`網頁抓取失敗: ${error.message}`);
    }
  }

  private parseRows(html: string): Tender[] {
    const $ = cheerio.load(html);
    const tenders: Tender[] = [];

      $('table tr').each((_, el) => {
        const cols = $(el).find('td');
        
        if (cols.length >= 9) {
          const nameCol = $(cols[2]);
          const { id, name, link } = this.parseTenderIdentity(nameCol);

          // 核心過濾：案號必須存在且不能是說明文字
          if (!id || id.length > 30 || id.includes('說明') || id.includes('◎') || !name || name.includes('Geps3.')) {
            return;
          }

          const orgName = $(cols[1]).text().trim();
          if (orgName.includes('圖例說明') || orgName.includes('若查不到')) {
            return;
          }

          const tenderWay = $(cols[4]).text().trim();
          const tenderType = $(cols[5]).text().trim();
          const publishDate = $(cols[6]).text().trim();
          const endDate = $(cols[7]).text().trim();
          const budgetStr = $(cols[8]).text().trim();

          tenders.push({
            id,
            name,
            orgName,
            tenderWay,
            tenderType,
            publishDate,
            endDate,
            link: link ? (link.startsWith('http') ? link : `https://web.pcc.gov.tw${link}`) : '',
            budget: this.parseBudget(budgetStr),
            source: 'web'
          });
        }
      });

    return tenders;
  }

  private decodeHtml(data: Buffer, contentType?: string): string {
    let html = data.toString('utf8');
    if (contentType?.toLowerCase().includes('big5') || html.includes(' charset=big5') || html.includes(' charset="big5"')) {
      return iconv.decode(data, 'big5');
    }
    return html;
  }

  private parseTenderIdentity(col: any) {
    const linkEl = col.find('a');
    const link = linkEl.attr('href') || '';
    
    // 獲取 HTML 全文，用來解析 JS 內的名稱
    const html = col.html() || '';
    
    // 案號解析
    const fullText = col.text().trim().replace(/\s+/g, ' ');
    const idMatch = fullText.match(/([A-Za-z0-9\-\.]{4,})/); // 案號通常至少 4 碼
    const id = idMatch ? idMatch[1] : '';

    // 名稱解析：從 Geps3.CNS.pageCode2Img("...") 提取
    let name = '';
    const imgMatch = html.match(/pageCode2Img\("([^"]+)"\)/);
    if (imgMatch) {
      name = imgMatch[1];
    } else {
      // 備案：如果沒有 JS 混淆，直接取連結文字
      name = linkEl.text().trim();
    }

    // 清理名稱中的標籤
    name = name
      .replace(/\(更正公告\)/g, '')
      .replace(/更正公告/g, '')
      .replace(/\(招標公告\)/g, '')
      .replace(/招標公告/g, '')
      .trim();

    return { id, name, link };
  }

  private parseBudget(budgetStr: string): number {
    if (!budgetStr) return 0;
    const cleanStr = budgetStr.replace(/,/g, '').replace(/[^\d.]/g, '');
    const budget = parseFloat(cleanStr);
    return isNaN(budget) ? 0 : budget;
  }
}