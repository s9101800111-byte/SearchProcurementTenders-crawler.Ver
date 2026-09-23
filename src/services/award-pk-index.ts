import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AwardRow } from '../types/award.js';
import { rocStringToNumber } from '../utils/date.js';

/**
 * pk → 決標公告日 的索引。
 *
 * 為什麼要有這支：g0v 鏡像是用「日期」出貨的（listbydate 一次一整天），
 * 但 get_award_detail 收到的只有一個 pk，pk 本身看不出日期，所以走不了鏡像那條快路。
 * 清單查詢（search_awards）每一列都同時有 pk 與決標公告日，順手記下來就補上了這一段。
 * 純屬加速用的快取：查不到就照原本的官方內頁流程走，不影響正確性。
 */

// build 後此檔在 build/services/，快取固定放專案根的 .cache/
// ⚠️ 不可依賴工作目錄：MCP 由 GUI 啟動時 CWD 是 C:\Windows\System32，寫入會被拒
export const AWARD_PK_INDEX_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'award-pk-dates.json');

/** 上限；超過就從最舊的丟（Map 的插入順序就是先後） */
const MAX_ENTRIES = 50_000;
const FLUSH_DELAY_MS = 2000;

let index: Map<string, number> | null = null;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;
let tmpSeq = 0;

async function load(file: string): Promise<Map<string, number>> {
  if (index) return index;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, number>;
    index = new Map(Object.entries(parsed).filter(([, v]) => typeof v === 'number'));
  } catch {
    index = new Map();
  }
  return index;
}

async function flush(file: string): Promise<void> {
  if (!dirty || !index) return;
  dirty = false;
  // 超量就砍掉最舊的一段
  if (index.size > MAX_ENTRIES) {
    const keep = [...index.entries()].slice(-MAX_ENTRIES);
    index = new Map(keep);
  }
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(Object.fromEntries(index)), 'utf8');
    await rename(tmp, file);
  } catch (e: any) {
    await unlink(tmp).catch(() => undefined);
    console.error(`[AwardPkIndex] 寫入失敗（不影響查詢結果）: ${e.message}`);
  }
}

/** 記下這批清單列的 pk → 決標公告日；寫檔延後合併，不擋查詢 */
export function rememberAwardDates(rows: AwardRow[], file = AWARD_PK_INDEX_FILE): void {
  void (async () => {
    const map = await load(file);
    for (const r of rows) {
      if (!r.pk) continue;
      const d = rocStringToNumber(r.awardNoticeDate);
      if (d == null) continue;
      if (map.get(r.pk) === d) continue;
      map.delete(r.pk); // 重設插入順序，常用的不會被當成最舊的丟掉
      map.set(r.pk, d);
      dirty = true;
    }
    if (dirty && !flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; void flush(file); }, FLUSH_DELAY_MS);
      flushTimer.unref?.();
    }
  })();
}

/** 查某個 pk 的決標公告日（民國 yyyMMdd）；沒記過回 null */
export async function lookupAwardDate(pk: string, file = AWARD_PK_INDEX_FILE): Promise<number | null> {
  const map = await load(file);
  return map.get(pk) ?? null;
}
