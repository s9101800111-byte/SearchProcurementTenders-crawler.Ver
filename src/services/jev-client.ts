import axios from 'axios';
import { envOrRegistry, GroqUsage } from './groq-client.js';

/**
 * TypeSafe Jev（systemone）呼叫。只給 rank_by_topic engine="jev" 用。
 *
 * 一案一請求、不批次：批次是 Groq 漏案的主因。2026-10-19 在 2,031 筆勞務決標實測
 * 8 併發 48 秒跑完、約 0.05 美元；關鍵字分類的 341 筆同意 337 筆，疏濬、用戶新裝等施工都正確判否。
 * 金鑰只從 TYPESAFE_API_KEY 讀（行程變數沒有就讀 HKCU\Environment），永遠不寫進程式或輸出。
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const JEV_CONCURRENCY = 8;

export class JevError extends Error {
  constructor(message: string, readonly kind: 'no-key' | 'auth' | 'deadline' | 'http') {
    super(message);
  }
}

const jevKey = () => envOrRegistry('TYPESAFE_API_KEY');

export function hasJevKey(): boolean {
  return Boolean(jevKey());
}

export const NO_JEV_KEY_MESSAGE = '找不到 TYPESAFE_API_KEY，engine="jev" 需要 TypeSafe 金鑰（engine="groq" 與其他工具不受影響）。'
  + '已找過行程環境變數與 Windows 使用者環境變數（HKCU\\Environment）。請用 setx TYPESAFE_API_KEY 設定後完全關閉再重開 Claude。';

/** 依主題組判斷說明。服務／作業本身的分辨清單沿用實測腳本，讓主題是服務或施工都能用。 */
export function jevQuestion(topic: string) {
  return {
    type: 'noul',
    instructions: `只根據機關名稱與標案名稱判斷：這個台灣政府採購案「實際要採購的標的」是否屬於主題「${topic}」？`
      + '名稱裡出現工程或設備名詞，不代表採購的就是施工或設備本身。'
      + '技術服務包含：規劃、設計、監造、專案管理、檢測、鑑定、測量、調查評估、可行性研究等委託專業單位的工作；'
      + '作業本身包含：施工、修繕、維護保養、清潔、疏濬、裝設、用戶新裝改裝等。'
      + '名稱裡同時有「工程」與「委託設計／監造／技術服務」時，以委託的技術服務為準。'
      + '主題是技術服務時，作業本身與活動、資訊、餐飲、運輸、保險等一般勞務都答否；主題是作業本身時，只做技術服務的案子答否。',
    criteria: {
      true: `屬於主題：${topic}`,
      false: `不屬於主題：不是「${topic}」要找的標的`,
    },
  };
}

/** noul（0~1）換成 rank_by_topic 的 0~3 分 */
export function noulToScore(p: number): number {
  return p >= 0.8 ? 3 : p >= 0.5 ? 2 : p >= 0.3 ? 1 : 0;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 問一案，回傳 noul；回應格式不對回 null。429／5xx 退避重試，金鑰被拒或超過 deadline 丟錯。 */
export async function jevAsk(question: ReturnType<typeof jevQuestion>, orgName: string, tenderName: string, usage: GroqUsage, deadline?: number): Promise<number | null> {
  const key = jevKey();
  if (!key) throw new JevError(NO_JEV_KEY_MESSAGE, 'no-key');
  const state = `${orgName ? `機關名稱：${orgName}\n` : ''}標案名稱：${tenderName}`;

  for (let attempt = 1; ; attempt++) {
    if (deadline && Date.now() > deadline) throw new JevError('已達本次執行時間上限', 'deadline');
    const r = await axios.post(ENDPOINT, { model: JEV_MODEL, state, questions: { eng: question } }, {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 60_000,
      validateStatus: () => true,
    }).catch((e: any) => ({ status: 0, data: { error: e.message } }));

    if (r.status === 200) {
      usage.calls++;
      usage.promptTokens += r.data?.usage?.input_tokens ?? 0;
      usage.completionTokens += r.data?.usage?.output_tokens ?? 0;
      const p = r.data?.answers?.eng?.noul;
      return typeof p === 'number' && p >= 0 && p <= 1 ? p : null;
    }
    if (r.status === 401 || r.status === 403) {
      throw new JevError(`TypeSafe 拒絕金鑰（HTTP ${r.status}），請確認 TYPESAFE_API_KEY 是否有效。`, 'auth');
    }
    // 其他 4xx 是這一案的問題，留 -1 繼續跑別案
    if (r.status >= 400 && r.status < 500 && r.status !== 429) return null;
    if (attempt >= 4) {
      throw new JevError(`TypeSafe 呼叫失敗（HTTP ${r.status}）：${JSON.stringify(r.data).slice(0, 200)}`, 'http');
    }
    const wait = 2000 * attempt;
    usage.waitedMs += wait;
    await sleep(wait);
  }
}
