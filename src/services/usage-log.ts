import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 每次 HTTP 呼叫 Groq／Jev 寫一行到 .cache/usage.jsonl。
 * 只記下面這幾個欄位，絕不記金鑰、header 或請求內容。寫檔失敗不影響呼叫本身。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');
const USAGE_FILE = join(ROOT, 'usage.jsonl');

export interface UsageRecord {
  engine: 'groq' | 'jev';
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  /** HTTP 狀態碼，0＝連線失敗或逾時 */
  status: number;
  rateLimited: boolean;
}

export function logUsage(rec: UsageRecord): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n';
  void mkdir(ROOT, { recursive: true }).then(() => appendFile(USAGE_FILE, line, 'utf8')).catch(() => undefined);
}
