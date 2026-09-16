import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AwardCategory, AwardRow } from '../types/award.js';
import { queryAwards, awardDedupKey } from './award-service.js';
import { fetchAwardDetails, AWARD_DETAIL_CACHE_FILE } from './award-detail-crawler.js';

/**
 * 批次補得標廠商。
 *
 * 為什麼要有這支：清單端點查不到得標廠商，內頁才有，但內頁受驗證碼流量控制
 * （任意 10 分鐘最多 5 次請求），341 件純靠內頁要十幾個小時。
 * 實務上大部分案子可以用「免費」的清單端點解掉——同一家廠商常重複得標，
 * 拿已知廠商名去 gottenVendorName 反查，一次查詢就能一次解掉好幾案。
 *
 * 所以這支的策略是：
 *   1) 反查（免費、不受流量控制）：用已知廠商名／統編反查，能解幾件算幾件
 *   2) 內頁（受限）：剩下的依決標金額由大到小逐案開，抓到新廠商名就丟回第 1 步
 * 兩者交替直到全部解完。跑很久，所以做成背景工作＋狀態落檔，可續跑、可查進度。
 */

// build 後此檔在 build/services/，狀態固定放專案根的 .cache/resolve-jobs/
// ⚠️ 不可用 process.cwd()：MCP 由 GUI 啟動時 CWD 是 C:\Windows\System32
const JOB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'resolve-jobs');

/** 反查查詢之間的節流（清單端點沒有驗證碼限制，但不把公家端點打滿） */
const LOOKUP_GAP_MS = 1800;
/** 內頁被額度擋住時，等多久再看一次 */
const WINDOW_WAIT_MS = 60_000;
/** 內頁被驗證碼擋住時的冷卻 */
const BLOCK_WAIT_MS = 10 * 60_000;

export type ResolveSource = '內頁完整' | '反查' | '快取';

export interface ResolveCase {
  pk: string;
  url: string;
  caseNo: string;
  orgName: string;
  tenderName: string;
  amount: number | null;
  awardNoticeDate: string;
  status: 'unknown' | 'resolved' | 'failed';
  winner?: string;
  winnerId?: string | null;
  bidderCount?: number | null;
  losers?: string[];
  budget?: number | null;
  totalAward?: number | null;
  source?: ResolveSource;
  message?: string;
}

export interface ResolveJob {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  /** 反查時要套用的查詢範圍（與案件清單同一個區間，範圍越窄反查越準） */
  range: { from: number; to: number; category?: AwardCategory };
  state: 'running' | 'paused' | 'done' | 'error';
  message: string;
  cases: ResolveCase[];
  /** 待反查的廠商名／統編 */
  vendorQueue: string[];
  /** 已反查過的，不重複查 */
  triedVendors: string[];
  stats: { total: number; resolved: number; failed: number; lookups: number; detailFetches: number; solvedByLookup: number; solvedByDetail: number };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function jobPath(id: string): string {
  return join(JOB_DIR, `${id}.json`);
}

/** 原子寫入，避免半寫狀態 */
async function saveJob(job: ResolveJob): Promise<void> {
  job.updatedAt = nowIso();
  await mkdir(JOB_DIR, { recursive: true });
  const tmp = `${jobPath(job.id)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(job, null, 1), 'utf8');
  try {
    await rename(tmp, jobPath(job.id));
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export async function loadJob(id: string): Promise<ResolveJob | null> {
  try {
    return JSON.parse(await readFile(jobPath(id), 'utf8')) as ResolveJob;
  } catch {
    return null;
  }
}

export async function listJobs(): Promise<ResolveJob[]> {
  try {
    const files = (await readdir(JOB_DIR)).filter(f => f.endsWith('.json'));
    const jobs = await Promise.all(files.map(f => loadJob(f.replace(/\.json$/, ''))));
    return jobs.filter((j): j is ResolveJob => Boolean(j)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function makeJobId(seed: string): string {
  // 不用亂數：同一批案子重跑會得到同一個 id，避免堆出一堆孤兒工作
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `job_${h.toString(36)}`;
}

/** 從既有的內頁快取撈出已知廠商名與統編，當作反查的種子 */
export async function seedVendorsFromCache(cacheFile = AWARD_DETAIL_CACHE_FILE): Promise<string[]> {
  try {
    const store = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, any>;
    const out = new Set<string>();
    for (const v of Object.values(store)) {
      const rec = v?.record;
      if (!rec || rec.pageType !== 'award') continue;
      for (const b of rec.bidders ?? []) {
        if (b?.name) out.add(String(b.name));
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

export interface CreateJobInput {
  label: string;
  range: { from: number; to: number; category?: AwardCategory };
  rows: AwardRow[];
  seedVendors?: string[];
}

export async function createJob(input: CreateJobInput): Promise<ResolveJob> {
  const cases: ResolveCase[] = input.rows.map(r => ({
    pk: r.pk,
    url: r.url,
    caseNo: r.caseNo,
    orgName: r.orgName,
    tenderName: r.tenderName,
    amount: r.amount,
    awardNoticeDate: r.awardNoticeDate,
    status: 'unknown',
  }));
  const id = makeJobId(`${input.range.from}-${input.range.to}-${input.range.category ?? ''}-${cases.map(c => c.pk).join(',')}`);
  const existing = await loadJob(id);
  if (existing) return existing;

  const job: ResolveJob = {
    id,
    label: input.label,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    range: input.range,
    state: 'paused',
    message: '尚未開始',
    cases,
    vendorQueue: [...new Set(input.seedVendors ?? [])],
    triedVendors: [],
    stats: { total: cases.length, resolved: 0, failed: 0, lookups: 0, detailFetches: 0, solvedByLookup: 0, solvedByDetail: 0 },
  };
  await saveJob(job);
  return job;
}

const norm = (s: string) => String(s || '').replace(/\s+/g, '').replace(/\(更正公告\)|（更正公告）/g, '').trim();
const caseKey = (orgName: string, caseNo: string) => `${norm(orgName)}||${norm(caseNo)}`;

function recount(job: ResolveJob): void {
  job.stats.resolved = job.cases.filter(c => c.status === 'resolved').length;
  job.stats.failed = job.cases.filter(c => c.status === 'failed').length;
}

/** 一次反查：用一個廠商名／統編查同區間的決標案，命中就標記 */
async function lookupVendor(job: ResolveJob, vendor: string): Promise<number> {
  const byId = /^\d{8}$/.test(vendor);
  const q = byId
    ? { from: job.range.from, to: job.range.to, category: job.range.category, gottenVendorId: vendor }
    : { from: job.range.from, to: job.range.to, category: job.range.category, gottenVendorName: vendor };
  const r = await queryAwards(q, { maxRows: 300 });
  job.stats.lookups += r.requests;
  if (r.blocked) throw new Error('清單端點被擋');
  if (r.error) return 0;

  const byKey = new Map(job.cases.filter(c => c.status === 'unknown').map(c => [caseKey(c.orgName, c.caseNo), c]));
  const byPk = new Map(job.cases.filter(c => c.status === 'unknown').map(c => [c.pk, c]));
  let hit = 0;
  for (const row of r.rows) {
    const c = byPk.get(row.pk) ?? byKey.get(caseKey(row.orgName, row.caseNo));
    if (!c || c.status !== 'unknown') continue;
    c.status = 'resolved';
    c.winner = vendor;
    c.winnerId = byId ? vendor : null;
    c.source = '反查';
    hit++;
  }
  job.stats.solvedByLookup += hit;
  return hit;
}

/** 一次內頁：解一件，順便把新廠商名丟回反查佇列 */
async function fetchOneDetail(job: ResolveJob, target: ResolveCase): Promise<'ok' | 'limit' | 'blocked' | 'failed'> {
  const batch = await fetchAwardDetails([target.url || target.pk]);
  job.stats.detailFetches += batch.fetched;
  const r = batch.results[0];
  if (!r) return 'failed';

  if (r.ok && r.record && r.record.pageType === 'award') {
    const rec = r.record;
    const winners = rec.winners.map(b => b.name).filter(Boolean);
    target.status = 'resolved';
    target.winner = winners.join(' / ');
    target.winnerId = rec.winners.map(b => b.vendorId).filter(Boolean).join(' / ') || null;
    target.bidderCount = rec.bidderCount;
    target.losers = rec.losers.map(b => b.name).filter(Boolean);
    target.budget = rec.budget;
    target.totalAward = rec.totalAward;
    target.source = r.cached ? '快取' : '內頁完整';
    if (!r.cached) job.stats.solvedByDetail++;
    for (const b of rec.bidders) {
      if (b.name && !job.triedVendors.includes(b.name) && !job.vendorQueue.includes(b.name)) job.vendorQueue.push(b.name);
    }
    return 'ok';
  }
  if (r.ok && r.record) { // 無法決標公告：沒有得標廠商，標為已處理
    target.status = 'resolved';
    target.winner = '（無法決標）';
    target.source = r.cached ? '快取' : '內頁完整';
    return 'ok';
  }
  if (r.failure === 'limit') return 'limit';
  if (r.failure === 'cooldown' || r.failure === 'blocked') return 'blocked';
  target.status = 'failed';
  target.message = r.message;
  return 'failed';
}

/** 背景工作：反查與內頁交替，直到全解完或被叫停 */
export async function runJob(id: string, opts: { maxMinutes?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.maxMinutes ?? 720) * 60_000;
  for (;;) {
    const job = await loadJob(id);
    if (!job || job.state === 'paused' || job.state === 'done') return;
    if (Date.now() > deadline) {
      job.state = 'paused';
      job.message = '達到本次執行時間上限，可再次啟動續跑';
      await saveJob(job);
      return;
    }

    // 1. 先把免費的反查做完
    const vendor = job.vendorQueue.shift();
    if (vendor) {
      job.triedVendors.push(vendor);
      try {
        const hit = await lookupVendor(job, vendor);
        recount(job);
        job.message = `反查「${vendor}」命中 ${hit} 件｜已解 ${job.stats.resolved}/${job.stats.total}`;
        await saveJob(job);
      } catch (e: any) {
        job.vendorQueue.unshift(vendor);
        job.triedVendors.pop();
        job.message = `反查暫停：${e.message}，${Math.round(BLOCK_WAIT_MS / 60000)} 分鐘後再試`;
        await saveJob(job);
        await sleep(BLOCK_WAIT_MS);
        continue;
      }
      await sleep(LOOKUP_GAP_MS);
      continue;
    }

    // 2. 反查做完了，剩下的走內頁：金額大的先
    const pending = job.cases.filter(c => c.status === 'unknown').sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
    if (pending.length === 0) {
      recount(job);
      job.state = 'done';
      job.message = `完成：已解 ${job.stats.resolved}/${job.stats.total}${job.stats.failed ? `，失敗 ${job.stats.failed}` : ''}`;
      await saveJob(job);
      return;
    }

    const outcome = await fetchOneDetail(job, pending[0]);
    recount(job);
    if (outcome === 'limit') {
      job.message = `內頁額度用完，等 ${Math.round(WINDOW_WAIT_MS / 1000)} 秒｜已解 ${job.stats.resolved}/${job.stats.total}，剩 ${pending.length}`;
      await saveJob(job);
      await sleep(WINDOW_WAIT_MS);
      continue;
    }
    if (outcome === 'blocked') {
      job.message = `內頁被流量控制擋住，冷卻 ${Math.round(BLOCK_WAIT_MS / 60000)} 分鐘｜已解 ${job.stats.resolved}/${job.stats.total}`;
      await saveJob(job);
      await sleep(BLOCK_WAIT_MS);
      continue;
    }
    job.message = `內頁 ${pending[0].caseNo}：${outcome === 'ok' ? pending[0].winner : '失敗'}｜已解 ${job.stats.resolved}/${job.stats.total}`;
    await saveJob(job);
  }
}

export async function setJobState(id: string, state: 'running' | 'paused'): Promise<ResolveJob | null> {
  const job = await loadJob(id);
  if (!job) return null;
  if (job.state === 'done') return job;
  job.state = state;
  job.message = state === 'running' ? '啟動中' : '已暫停（可再啟動續跑）';
  await saveJob(job);
  return job;
}

export function jobSummary(job: ResolveJob): string {
  const s = job.stats;
  const pct = s.total ? Math.round((s.resolved / s.total) * 100) : 0;
  const unknown = job.cases.filter(c => c.status === 'unknown');
  const amt = (rows: ResolveCase[]) => rows.reduce((t, c) => t + (c.amount ?? 0), 0);
  const totalAmt = amt(job.cases), gotAmt = amt(job.cases.filter(c => c.status === 'resolved'));
  const fmt = (n: number) => n.toLocaleString('en-US');
  return [
    `- 狀態：${job.state === 'running' ? '執行中' : job.state === 'done' ? '已完成' : job.state === 'paused' ? '已暫停' : '錯誤'}｜${job.message}`,
    `- 進度：${fmt(s.resolved)} / ${fmt(s.total)} 件（${pct}%）｜金額涵蓋 ${fmt(gotAmt)} / ${fmt(totalAmt)} 元`,
    `- 來源：反查解出 ${fmt(s.solvedByLookup)} 件（免費）｜內頁解出 ${fmt(s.solvedByDetail)} 件（受流量控制）｜失敗 ${fmt(s.failed)} 件`,
    `- 連線：清單端點 ${fmt(s.lookups)} 次｜內頁 ${fmt(s.detailFetches)} 次`,
    `- 待解 ${fmt(unknown.length)} 件；反查佇列尚有 ${fmt(job.vendorQueue.length)} 家廠商`,
    `- 更新時間 ${job.updatedAt}`,
  ].join('\n');
}
