import axios from 'axios';

/**
 * g0v 政府採購網鏡像（ronnywang/pcc.g0v.ronny.tw）唯讀用戶端。
 *
 * 為什麼要有這支：官方清單端點沒有得標廠商欄位，內頁才有，但內頁受撲克牌驗證碼流量控制
 * （任意 10 分鐘最多 5 次）。鏡像的 listbydate 一個請求就回一整天全部公告，
 * 而且每筆的 companies.name_key 直接標明誰是得標廠商、誰是未得標廠商、投標廠商有幾家。
 *
 * 2026-09-23 實測（115/09/22 工程類決標 164 件）：
 *   機關名稱＋標案案號完全比對命中 151 件（92%），命中的 151 件全部都取得得標廠商。
 *   未命中的 13 件多是變更設計／後續擴充（官方案號帶 -1、-2 尾碼，鏡像收在別的案號下）；
 *   實測去尾碼再比對一件也沒多命中，所以不做模糊比對，避免把變更設計對到原案。
 *
 * 限制（呼叫端要知道）：
 *   - 有 HTTP 429 限速，3 秒間隔連打 10 次實測約兩成被擋；429 可退避重試。
 *   - 週末回 PHP warning ＋ {}（HTTP 200），那是當天沒公告，不是錯誤。
 *   - 鏡像限個人／研究等非營利用途，商業利用要走官方 OpenData。
 */

const BASE = 'https://pcc-api.openfun.app/api';
/** 每次請求之間至少間隔；鏡像是社群免費資源，不打滿 */
const THROTTLE_MS = 3000;
/** 429 退避重試次數 */
const MAX_RETRY = 3;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let lastRequestEnd = 0;

export interface MirrorAward {
  /** 得標廠商（複數決標會有多家） */
  winners: string[];
  /** 對應的統編，查不到的位置留 null */
  winnerIds: (string | null)[];
  /** 未得標廠商 */
  losers: string[];
  /** 投標廠商家數；公告沒列投標廠商時 null */
  bidderCount: number | null;
  /** 公告種類（決標公告／無法決標公告／更正決標公告…） */
  type: string;
}

/** 民國 yyyMMdd 整數轉鏡像要的西元 YYYYMMDD */
function rocToAd(roc: number): number {
  const y = Math.floor(roc / 10000) + 1911;
  return y * 10000 + (roc % 10000);
}

const norm = (s: string) => String(s || '').replace(/\s+/g, '').replace(/\(更正公告\)|（更正公告）/g, '').trim();

/** 與 resolve-service 的 caseKey 同一套：機關名稱＋標案案號 */
export function mirrorCaseKey(orgName: string, caseNo: string): string {
  return `${norm(orgName)}||${norm(caseNo)}`;
}

/**
 * name_key 的值長這樣：
 *   ["投標廠商:投標廠商2:廠商名稱", "決標品項:第1品項:得標廠商1:得標廠商"]
 *   ["投標廠商:投標廠商1:廠商名稱", "決標品項:第1品項:未得標廠商1:未得標廠商"]
 * 「未得標廠商」本身含「得標廠商」三個字，判斷得標一定要先排除未得標。
 */
function parseCompanies(brief: any): MirrorAward | null {
  const nameKey: Record<string, string[]> = brief?.companies?.name_key ?? {};
  const idKey: Record<string, string[]> = brief?.companies?.id_key ?? {};
  const names = Object.keys(nameKey);
  if (names.length === 0) return null;

  const isWinner = (keys: string[]) => keys.some(k => /得標廠商\d*:得標廠商/.test(k) && !/未得標/.test(k));
  const isLoser = (keys: string[]) => keys.some(k => /未得標廠商\d*:未得標廠商/.test(k));

  const winners = names.filter(n => isWinner(nameKey[n]));
  if (winners.length === 0) return null;

  // 統編與名稱靠「投標廠商N」的序號對起來，對不上就留 null，不硬湊
  const slotOf = (keys: string[]): string | null => {
    for (const k of keys) {
      const m = k.match(/^投標廠商:投標廠商(\d+):/);
      if (m) return m[1];
    }
    return null;
  };
  const idBySlot = new Map<string, string>();
  for (const [id, keys] of Object.entries(idKey)) {
    const slot = slotOf(keys);
    if (slot) idBySlot.set(slot, id);
  }

  const slots = new Set<string>();
  for (const keys of Object.values(nameKey)) {
    const s = slotOf(keys);
    if (s) slots.add(s);
  }

  // 複數決標的公告常常只在「投標廠商N:是否得標=否」標示落標，決標品項那邊沒有「未得標廠商N」，
  // 所以除了明寫未得標的，凡是有投標序號又不在得標名單裡的一律算落標（有投標、沒得標）
  const losers = [...new Set([
    ...names.filter(n => isLoser(nameKey[n])),
    ...names.filter(n => slotOf(nameKey[n]) !== null && !winners.includes(n)),
  ])];

  return {
    winners,
    winnerIds: winners.map(n => {
      const s = slotOf(nameKey[n]);
      return s ? idBySlot.get(s) ?? null : null;
    }),
    losers,
    bidderCount: slots.size || null,
    type: String(brief?.type ?? ''),
  };
}

export interface DayIndexResult {
  /** 機關＋案號 → 得標資訊；當天沒公告時是空的 */
  index: Map<string, MirrorAward>;
  /** 當天公告總筆數（含招標公告等非決標類） */
  records: number;
  /** 實際送出的 HTTP 請求數（含退避重試） */
  requests: number;
  /** 取不到時的原因；成功是 undefined */
  error?: string;
}

/** 抓某一天（民國 yyyMMdd）的全部公告，建成 機關＋案號 → 得標資訊 的索引 */
export async function fetchDayIndex(rocDate: number): Promise<DayIndexResult> {
  const url = `${BASE}/listbydate?date=${rocToAd(rocDate)}`;
  let requests = 0;
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const wait = THROTTLE_MS - (Date.now() - lastRequestEnd);
    if (wait > 0) await sleep(wait);

    let res;
    try {
      requests++;
      res = await axios.get(url, { timeout: 60000, responseType: 'text', validateStatus: () => true, transformResponse: r => r });
    } catch (e: any) {
      lastRequestEnd = Date.now();
      lastError = `連線失敗：${e.message}`;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    lastRequestEnd = Date.now();

    if (res.status === 429) {
      lastError = '鏡像限速（429）';
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (res.status !== 200) {
      lastError = `HTTP ${res.status}`;
      await sleep(2000 * (attempt + 1));
      continue;
    }

    let parsed: any;
    try {
      // 沒公告的日子回的是 PHP warning ＋ {}，開頭不是 { 就先切掉雜訊
      const body = String(res.data ?? '');
      const start = body.indexOf('{');
      parsed = start >= 0 ? JSON.parse(body.slice(start)) : {};
    } catch {
      lastError = '回應不是合法 JSON';
      await sleep(2000 * (attempt + 1));
      continue;
    }

    const records: any[] = Array.isArray(parsed?.records) ? parsed.records : [];
    const index = new Map<string, MirrorAward>();
    for (const r of records) {
      const award = parseCompanies(r?.brief);
      if (!award) continue;
      const key = mirrorCaseKey(r?.unit_name ?? '', r?.job_number ?? '');
      // 同一天同案號有多筆（決標＋更正決標）時保留先出現的，更正的資訊不一定更完整
      if (!index.has(key)) index.set(key, award);
    }
    return { index, records: records.length, requests };
  }

  return { index: new Map(), records: 0, requests, error: lastError || '未知錯誤' };
}
