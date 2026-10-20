import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { groqChat, extractJsonArray, GroqError, GroqUsage, GROQ_MODEL, newUsage, hasGroqKey } from './groq-client.js';
import { jevAsk, jevQuestion, noulToScore, JevError, JEV_MODEL, JEV_CONCURRENCY, hasJevKey } from './jev-client.js';

/**
 * 依主題把一批標案／決標案分成 A 必納／B AI 補抓／C 低分。
 *
 * 規則來自 2026-09-17 實測（2,031 筆勞務決標，對照關鍵字歸類＋人工裁定）：
 * - AI 只能「加案」不能「刪案」：關鍵字命中一律 A 組，AI 分數再低也不移出
 * - 批次 40 筆時「…委託監造設計案」會被打 0 分、單筆重問是 3 分 → 批次縮到 12，
 *   低分但名稱含主題詞的再單筆複查
 * - AI 的主要誤判是把「施工／維護作業本身」當成服務，B 組一定要人工確認
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');
const RANK_DIR = join(ROOT, 'rankings');
const SCORE_CACHE = join(ROOT, 'ai-scores.json');

export const BATCH_SIZE = 12;
/** 單筆複查上限，避免主題詞太寬時一次燒掉幾百次呼叫 */
export const MAX_RECHECK = 40;

export type RankGroup = 'A' | 'B' | 'C';
export type RankEngine = 'groq' | 'jev';

export interface RankItem {
  /** 決標 pk 或招標 pk；同一個 ranking 內唯一 */
  pk: string;
  url: string;
  orgName: string;
  caseNo: string;
  tenderName: string;
  amount: number | null;
  date: string;
  /** -1＝未評分（執行中斷或模型一直回錯格式） */
  score: number;
  rechecked?: boolean;
  /** 實際給分的引擎；工作的引擎失敗時會改由另一個補分，所以可能和 job.engine 不同 */
  engine?: RankEngine;
  keywordHits?: string[];
  group?: RankGroup;
}

export interface RankJob {
  id: string;
  topic: string;
  keywords: string[];
  source: 'awards' | 'tenders' | 'export';
  conditions: string;
  createdAt: string;
  updatedAt: string;
  state: 'running' | 'paused' | 'done' | 'error';
  message: string;
  model: string;
  /** 舊版工作檔沒有這欄＝groq */
  engine?: RankEngine;
  items: RankItem[];
  /** 單筆複查用的主題詞（AI 產生），第一次跑時才產 */
  recheckTerms?: string[];
  recheckDone?: boolean;
  recheckSkipped?: number;
  /** 改送另一個引擎時的說明 */
  fallbackNote?: string;
  usage: GroqUsage;
}

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- 分數快取（同引擎＋同模型＋同主題＋同機關名稱＋同標案名稱，不重算） ----------

let scoreCache: Record<string, number> | null = null;

/** groq 的 key 維持舊格式，既有快取繼續有效；jev 加前綴區分 */
function scoreKey(topic: string, orgName: string, tenderName: string, engine: RankEngine = 'groq'): string {
  const model = engine === 'jev' ? `jev:${JEV_MODEL}` : GROQ_MODEL;
  return createHash('sha1').update(`${model}\u0000${topic.trim()}\u0000${orgName}\u0000${tenderName}`).digest('hex');
}

async function loadScoreCache(): Promise<Record<string, number>> {
  if (scoreCache) return scoreCache;
  try { scoreCache = JSON.parse(await readFile(SCORE_CACHE, 'utf8')); } catch { scoreCache = {}; }
  return scoreCache!;
}

async function saveScoreCache(): Promise<void> {
  if (!scoreCache) return;
  await mkdir(ROOT, { recursive: true });
  await atomicWrite(SCORE_CACHE, JSON.stringify(scoreCache));
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  try { await rename(tmp, file); } catch (e) { await unlink(tmp).catch(() => undefined); throw e; }
}

// ---------- 工作檔 ----------

export function makeRankId(topic: string, keywords: string[], pks: string[], engine: RankEngine = 'groq'): string {
  // groq 不加引擎字樣，舊 rankId 不變
  const h = createHash('sha1').update(`${engine === 'jev' ? 'jev\u0000' : ''}${topic}\u0000${keywords.join(',')}\u0000${pks.join(',')}`).digest('hex');
  return `rank_${h.slice(0, 10)}`;
}

export async function saveRankJob(job: RankJob): Promise<void> {
  job.updatedAt = nowIso();
  await mkdir(RANK_DIR, { recursive: true });
  await atomicWrite(join(RANK_DIR, `${job.id}.json`), JSON.stringify(job, null, 1));
}

export async function loadRankJob(id: string): Promise<RankJob | null> {
  if (!/^rank_[0-9a-f]{10}$/.test(id)) return null;
  try { return JSON.parse(await readFile(join(RANK_DIR, `${id}.json`), 'utf8')); } catch { return null; }
}

export async function listRankJobs(): Promise<RankJob[]> {
  try {
    const files = (await readdir(RANK_DIR)).filter(f => /^rank_[0-9a-f]{10}\.json$/.test(f));
    const jobs = await Promise.all(files.map(f => loadRankJob(f.replace(/\.json$/, ''))));
    return jobs.filter((j): j is RankJob => Boolean(j)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function createRankJob(input: {
  topic: string; keywords: string[]; source: RankJob['source']; conditions: string;
  items: Omit<RankItem, 'score'>[]; engine?: RankEngine;
}): Promise<RankJob> {
  const engine = input.engine ?? 'groq';
  const seen = new Set<string>();
  const items: RankItem[] = [];
  for (const it of input.items) {
    if (!it.pk || seen.has(it.pk)) continue;
    seen.add(it.pk);
    items.push({ ...it, score: -1 });
  }
  const id = makeRankId(input.topic, input.keywords, items.map(i => i.pk), engine);
  const existing = await loadRankJob(id);
  if (existing) return existing;
  const job: RankJob = {
    id, topic: input.topic.trim(), keywords: input.keywords, source: input.source, conditions: input.conditions,
    createdAt: nowIso(), updatedAt: nowIso(), state: 'paused', message: '尚未開始',
    model: engine === 'jev' ? JEV_MODEL : GROQ_MODEL, engine,
    items, usage: newUsage(),
  };
  assignGroups(job);
  await saveRankJob(job);
  return job;
}

// ---------- 分組 ----------

export function keywordHits(name: string, keywords: string[]): string[] {
  const n = name.toLowerCase();
  return keywords.filter(k => k && n.includes(k.toLowerCase()));
}

export function groupOf(item: Pick<RankItem, 'score' | 'keywordHits'>): RankGroup {
  if (item.keywordHits?.length) return 'A';
  return item.score >= 2 ? 'B' : 'C';
}

export function assignGroups(job: RankJob): void {
  for (const it of job.items) {
    it.keywordHits = keywordHits(it.tenderName, job.keywords);
    it.group = groupOf(it);
  }
}

const GROUP_ORDER: Record<RankGroup, number> = { A: 0, B: 1, C: 2 };

/** A → B → C；組內分數高的先，同分金額大的先 */
export function compareRank(a: RankItem, b: RankItem): number {
  return GROUP_ORDER[a.group ?? 'C'] - GROUP_ORDER[b.group ?? 'C']
    || b.score - a.score
    || (b.amount ?? 0) - (a.amount ?? 0);
}

// ---------- Prompt ----------

function scorePrompt(topic: string, list: RankItem[]): string {
  return `你是台灣政府採購案件分類員。判斷每一案是否屬於下列主題。

主題：${topic}

每案給一個分數：3=確定是、2=大概是、1=大概不是、0=確定不是。
請依案件「實際要採購的標的」判斷：名稱裡出現工程或設備名詞，不代表採購的就是施工或設備本身；
「委託…技術服務」「…規劃設計」「…監造」是服務，「…工程」「…修繕」「…維護工作」是作業本身。
只輸出一個 JSON 整數陣列，長度必須剛好 ${list.length}，順序與輸入相同，不要任何其他文字。

${list.map((x, k) => `${k + 1}. [${x.orgName}] ${x.tenderName}`).join('\n')}`;
}

function termsPrompt(topic: string, max: number): string {
  return `列出最多 ${max} 個「最常直接出現在台灣政府採購標案名稱裡、而且能代表下列主題」的詞。
每個詞 2~5 個字，要是標案名稱裡真的會寫的字（例如「監造」「裝潢」），不要解釋性的長句。
查詢是「名稱包含這個詞」的比對，所以詞要短、而且彼此是不同的說法（同義詞、別稱、常見簡寫）；
不要在同一個詞前後加字（有了「室內裝修」，「室內裝修工程」「室內裝修施工」就是多餘的）。
只輸出 JSON 字串陣列，不要任何其他文字。

主題：${topic}`;
}

/** AI 產生主題詞；過濾掉非字串、太短太長、重複的 */
export async function suggestTerms(topic: string, max: number, usage: GroqUsage, deadline?: number): Promise<string[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const arr = extractJsonArray(await groqChat(termsPrompt(topic, max), usage, { maxTokens: 1500, deadline }));
    if (!arr) continue;
    const terms = [...new Set(arr
      .filter((v): v is string => typeof v === 'string')
      .map(s => s.trim().replace(/^["「『]|["」』]$/g, ''))
      .filter(s => s.length >= 2 && s.length <= 8))].slice(0, max);
    if (terms.length) return terms;
  }
  return [];
}

async function scoreBatch(topic: string, list: RankItem[], usage: GroqUsage, deadline: number): Promise<number[] | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const arr = extractJsonArray(await groqChat(scorePrompt(topic, list), usage, { deadline }));
    if (arr && arr.length === list.length && arr.every(v => v === 0 || v === 1 || v === 2 || v === 3)) return arr as number[];
  }
  return null;
}

/** 批次評分；格式一直不對就對半拆，拆到單筆還不行就留 -1 */
async function scoreList(job: RankJob, list: RankItem[], deadline: number, cache: Record<string, number>): Promise<void> {
  const got = await scoreBatch(job.topic, list, job.usage, deadline);
  if (got) {
    list.forEach((it, k) => { it.score = got[k]; it.engine = 'groq'; cache[scoreKey(job.topic, it.orgName, it.tenderName)] = got[k]; });
    return;
  }
  if (list.length === 1) return;
  const mid = Math.floor(list.length / 2);
  await scoreList(job, list.slice(0, mid), deadline, cache);
  await scoreList(job, list.slice(mid), deadline, cache);
}

// ---------- 背景執行 ----------

const running = new Set<string>();

const pending = (job: RankJob) => job.items.filter(it => it.score < 0 && !it.rechecked);

/** Groq 等限速會超過時間上限、改送 Jev 時，Jev 另給的時間（2,000 筆實測 48 秒） */
const JEV_FALLBACK_GRACE_MS = 5 * 60_000;

/**
 * jev：一案一請求、8 併發。每 40 筆存一次檔；running=false 表示被暫停。
 * 回錯格式的案子標 rechecked 留 -1，後面的 groq 批次迴圈就不會再碰它。
 * 逾時／5xx 重試用完／金鑰被拒時不丟錯：停止再打 Jev，剩下的留 -1 交給呼叫端改送 Groq，錯誤放 error 回傳。
 */
async function runJevScoring(job: RankJob, todo: RankItem[], deadline: number, cache: Record<string, number>): Promise<{ running: boolean; error?: JevError }> {
  const question = jevQuestion(job.topic);
  let failed: JevError | undefined;
  let next = 0, sinceSave = 0;
  let saving: Promise<void> = Promise.resolve();
  const checkpoint = async () => {
    assignGroups(job);
    job.message = `逐案評分 ${job.items.filter(it => it.score >= 0).length}/${job.items.length}`;
    await persist(job);
    await saveScoreCache();
  };
  const worker = async () => {
    while (next < todo.length && job.state === 'running' && !failed) {
      const it = todo[next++];
      let p: number | null;
      try {
        p = await jevAsk(question, it.orgName, it.tenderName, job.usage, deadline);
      } catch (e) {
        if (e instanceof JevError && e.kind !== 'deadline') { failed ??= e; break; }
        throw e;
      }
      if (p == null) it.rechecked = true;
      else {
        it.score = noulToScore(p);
        it.engine = 'jev';
        cache[scoreKey(job.topic, it.orgName, it.tenderName, 'jev')] = it.score;
      }
      if (++sinceSave >= 40) { sinceSave = 0; saving = saving.then(checkpoint); await saving; }
    }
  };
  await Promise.all(Array.from({ length: JEV_CONCURRENCY }, worker));
  await saving;
  await checkpoint();
  return { running: job.state === 'running', error: failed };
}

/** 存檔前保留檔案上的暫停狀態：stop 是另一次工具呼叫寫進檔案的，不能被背景迴圈的舊狀態蓋掉 */
async function persist(job: RankJob): Promise<void> {
  const cur = await loadRankJob(job.id);
  if (cur?.state === 'paused' && job.state === 'running') {
    job.state = 'paused';
    job.message = cur.message;
  }
  await saveRankJob(job);
}

export async function setRankState(id: string, state: 'running' | 'paused'): Promise<RankJob | null> {
  const job = await loadRankJob(id);
  if (!job) return null;
  if (job.state === 'done') return job;
  job.state = state;
  job.message = state === 'running' ? '啟動中' : '已暫停（可再啟動續跑）';
  await saveRankJob(job);
  return job;
}

/**
 * 三階段：1) 從快取補分數 2) 批次評分 3) 低分但含主題詞的單筆複查。
 * 每批存一次檔，重開 Claude 後用同一個 rankId 再 start 就從斷點續跑。
 */
export async function runRankJob(id: string, opts: { maxMinutes?: number } = {}): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  const deadline = Date.now() + (opts.maxMinutes ?? 120) * 60_000;
  try {
    let job = await loadRankJob(id);
    if (!job) return;
    const cache = await loadScoreCache();

    const engine = job.engine ?? 'groq';
    let fromCache = 0;
    for (const it of job.items) {
      const k = scoreKey(job.topic, it.orgName, it.tenderName, engine);
      if (it.score < 0 && cache[k] !== undefined) { it.score = cache[k]; it.engine = engine; fromCache++; }
    }
    if (fromCache) { assignGroups(job); job.message = `從快取取得 ${fromCache} 筆分數`; await persist(job); }

    if (engine === 'jev') {
      const r = await runJevScoring(job, pending(job), deadline, cache);
      if (!r.running) return;
      job.recheckDone = true;  // 已是一案一問，不需要單筆複查
      if (r.error) {
        // Jev 失敗的那幾筆留 -1，由下面的 groq 批次迴圈接手
        const rest = pending(job);
        if (hasGroqKey()) {
          job.fallbackNote = `Jev 失敗（${r.error.message}），${rest.length} 筆改送 Groq`;
        } else {
          for (const it of rest) it.rechecked = true;
          job.fallbackNote = `Jev 失敗（${r.error.message}），又找不到 GROQ_API_KEY，${rest.length} 筆未評分`;
        }
        await persist(job);
      }
    }

    for (;;) {
      if (job.state !== 'running') return;
      const todo = pending(job);
      if (!todo.length) break;
      // 單筆拆到底還是 -1 的會一直留在 todo，用 rechecked 標記避免無限迴圈
      const batch = todo.slice(0, BATCH_SIZE);
      try {
        await scoreList(job, batch, deadline, cache);
      } catch (e) {
        // Groq 等 429 會超過時間上限：還沒評分的全部改送 Jev（Jev 本身失敗過就不再送回去）
        if (!(e instanceof GroqError && e.kind === 'deadline' && engine === 'groq' && hasJevKey())) throw e;
        const rest = pending(job);
        job.fallbackNote = `Groq 限速等待會超過時間上限，${rest.length} 筆改送 Jev（單筆複查也要用 Groq，本次略過）`;
        job.recheckDone = true;
        await persist(job);
        const r = await runJevScoring(job, rest, Math.max(deadline, Date.now()) + JEV_FALLBACK_GRACE_MS, cache);
        if (!r.running) return;
        if (r.error) throw r.error;
        continue;
      }
      for (const it of batch) if (it.score < 0) it.rechecked = true;
      assignGroups(job);
      const done = job.items.filter(it => it.score >= 0).length;
      job.message = `批次評分 ${done}/${job.items.length}`;
      await persist(job);
      await saveScoreCache();
    }

    if (!job.recheckDone) {
      if (!job.recheckTerms) {
        job.recheckTerms = await suggestTerms(job.topic, 12, job.usage, deadline);
        await persist(job);
        if (job.state !== 'running') return;
      }
      const terms = [...new Set([...(job.recheckTerms ?? []), ...job.keywords])];
      const suspects = job.items
        .filter(it => it.score >= 0 && it.score < 2 && !it.rechecked && keywordHits(it.tenderName, terms).length > 0)
        .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
      job.recheckSkipped = Math.max(0, suspects.length - MAX_RECHECK);
      for (const it of suspects.slice(0, MAX_RECHECK)) {
        if (job.state !== 'running') return;
        const got = await scoreBatch(job.topic, [it], job.usage, deadline);
        it.rechecked = true;
        if (got && got[0] > it.score) {
          it.score = got[0];
          it.engine = 'groq';
          cache[scoreKey(job.topic, it.orgName, it.tenderName)] = got[0];
        }
        assignGroups(job);
        job.message = `單筆複查 ${job.items.filter(x => x.rechecked).length}/${Math.min(suspects.length, MAX_RECHECK)}`;
        await persist(job);
        await sleep(200);
      }
      job.recheckDone = true;
      await saveScoreCache();
    }

    assignGroups(job);
    job.state = 'done';
    const unscored = job.items.filter(it => it.score < 0).length;
    job.message = `完成${unscored ? `，${unscored} 筆模型一直回錯格式、未評分（歸 C 組）` : ''}`;
    await saveRankJob(job);
  } catch (e: any) {
    const job = await loadRankJob(id);
    if (job) {
      const isDeadline = (e instanceof GroqError || e instanceof JevError) && e.kind === 'deadline';
      job.state = isDeadline ? 'paused' : 'error';
      job.message = isDeadline
        ? '達到本次執行時間上限，可再次 start 續跑（已評分的不重算）'
        : `執行失敗：${e.message}`;
      await saveRankJob(job);
    }
    await saveScoreCache().catch(() => undefined);
  } finally {
    running.delete(id);
  }
}

export function rankCounts(job: RankJob) {
  const c = { A: 0, B: 0, C: 0, scored: 0, total: job.items.length, aLowScore: 0 };
  for (const it of job.items) {
    c[it.group ?? 'C']++;
    if (it.score >= 0) c.scored++;
    if (it.group === 'A' && it.score >= 0 && it.score < 2) c.aLowScore++;
  }
  return c;
}

export function rankSummary(job: RankJob): string {
  const c = rankCounts(job);
  const fmt = (n: number) => n.toLocaleString('en-US');
  const u = job.usage;
  // 免費額度 8,000 TPM；以已評分筆數推估剩餘時間
  const perItem = c.scored ? (u.promptTokens + u.completionTokens) / Math.max(1, c.scored) : 250;
  const remainMin = Math.ceil(((c.total - c.scored) * perItem) / 8000);
  const jev = job.engine === 'jev';
  const byJev = job.items.filter(it => it.score >= 0 && it.engine === 'jev').length;
  const byGroq = job.items.filter(it => it.score >= 0 && it.engine === 'groq').length;
  return [
    `- 狀態：${job.state === 'running' ? '執行中' : job.state === 'done' ? '已完成' : job.state === 'paused' ? '已暫停' : '錯誤'}｜${job.message}`,
    `- 主題：${job.topic}｜必納關鍵字：${job.keywords.length ? job.keywords.join('、') : '（未給）'}`,
    `- 評分：${fmt(c.scored)} / ${fmt(c.total)} 筆${job.state === 'running' && c.total > c.scored && !jev ? `（免費額度下約還要 ${remainMin} 分鐘）` : ''}`,
    `- 分組：A 必納 ${fmt(c.A)}｜B AI 補抓 ${fmt(c.B)}｜C 低分 ${fmt(c.C)}`,
    ...(job.fallbackNote ? [`- ⚠️ 改送另一個引擎：${job.fallbackNote}`] : []),
    `- 實際給分引擎：Jev ${fmt(byJev)}｜Groq ${fmt(byGroq)}${c.scored > byJev + byGroq ? `｜舊版未記錄 ${fmt(c.scored - byJev - byGroq)}` : ''}`,
    `- ${byJev && byGroq ? 'Jev＋Groq 合計' : jev ? 'Jev（TypeSafe，逐案）' : 'Groq'}：${fmt(u.calls)} 次呼叫｜輸入 ${fmt(u.promptTokens)}／輸出 ${fmt(u.completionTokens)} token｜等待${jev ? '重試' : '限速'} ${Math.round(u.waitedMs / 1000)} 秒｜模型 ${job.model}`,
    `- 資料範圍：${job.conditions}`,
  ].join('\n');
}
