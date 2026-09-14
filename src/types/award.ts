/** 決標查詢（readTenderAgent）用的型別 */

export type AwardCategory = '工程' | '財物' | '勞務';
export type AwardStatus = '決標' | '無法決標' | '撤銷';

export interface AwardQuery {
  /** 決標公告日起，民國 yyyMMdd 整數（例：1150711） */
  from: number;
  /** 決標公告日迄，民國 yyyMMdd 整數 */
  to: number;
  /** 不給＝不限 */
  category?: AwardCategory;
  /** 履約地點代碼（單選）；空字串或不給＝不限 */
  execLocation?: string;
  orgName?: string;
  tenderName?: string;
  /** 預設 決標 */
  status?: AwardStatus;
  gottenVendorName?: string;
  gottenVendorId?: string;
  submitVendorName?: string;
  submitVendorId?: string;
}

/** 清單頁的一列 */
export interface AwardRow {
  /** 「檢視」連結上的 pk（決標是 pkAtmMain，不可餵給招標內頁） */
  pk: string;
  /** 連結型態：atm＝決標公告、nonAtm＝無法決標公告 */
  linkType: string;
  url: string;
  orgName: string;
  /** 已去掉「(更正公告)」字樣 */
  caseNo: string;
  isCorrection: boolean;
  tenderName: string;
  tenderWay: string;
  category: string;
  /** 決標公告日，民國字串原樣；更正公告列是更正日 */
  awardNoticeDate: string;
  /** 未公開或空白為 null */
  amount: number | null;
  awardSeq: string;
  nonAwardSeq: string;
  isNonAward: boolean;
  /** 查到這列時用的履約地點代碼（'' = 不限） */
  execLocation: string;
}

export interface AwardQueryResult {
  /** 官網「共有 N 筆」 */
  siteTotal: number;
  rows: AwardRow[];
  /** 因 maxRows 上限而沒抓完 */
  truncated: boolean;
  /** 本次實際連線次數 */
  requests: number;
  /** 非截斷造成的失敗（連線、版型不符、驗證碼）；有值代表 rows 可能不完整 */
  error?: string;
  /** 遇到驗證碼或 WAF 封鎖，呼叫端應停止後續查詢 */
  blocked?: boolean;
}

export interface ExecLocationOption {
  code: string;
  label: string;
}

export interface LocationStat extends ExecLocationOption {
  siteTotal: number | null;
  fetched: number;
  truncated: boolean;
  error?: string;
  /** 前面已被封鎖，這個代碼沒查 */
  skipped?: boolean;
}

export interface MultiLocationResult {
  perLocation: LocationStat[];
  /** 合併去重後的列，依決標公告日新到舊 */
  rows: AwardRow[];
  /** 各代碼官網總數加總（有代碼查失敗時為下限） */
  siteTotal: number;
  /** 有代碼拿不到官網總數時為 true，siteTotal 只是下限 */
  siteTotalIsLowerBound: boolean;
  /** 去重前實抓列數 */
  fetchedTotal: number;
  duplicates: number;
  truncated: boolean;
  requests: number;
  hasError: boolean;
}
