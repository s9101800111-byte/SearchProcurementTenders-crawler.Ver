export interface Tender {
  /** 標案案號 */
  id: string;
  /** 標案名稱 */
  name: string;
  /** 機關名稱 */
  orgName: string;
  /** 剩餘天數 (截止 - 現在) */
  remainingDays?: string;
  /** 等標期 (截止 - 公告) */
  tenderPeriod?: string;
  /** 招標方式 */
  tenderWay: string;
  /** 招標類型 */
  tenderType: string;
  /** 公告日期 */
  publishDate: string;
  /** 截止投標日期 */
  endDate: string;
  /** 預算金額 */
  budget?: number;
  /** 標案連結 */
  link: string;
  /** 檢視連結 (通常同 link) */
  viewLink?: string;
  /** 來源 (API 或 Web) */
  source?: 'api' | 'web';
}

export interface SearchParams {
  tenderName: string;
  tenderType?: string;
  tenderWay?: string;
  /** 單頁筆數，政府採購網最大可接受 100 */
  pageSize?: number;
  /** 最多抓幾頁（避免關鍵字太廣時無限翻頁） */
  maxPages?: number;
}

/** 單一標案內頁的解析結果 */
export interface TenderDetail {
  /** 傳入的原始識別字串（連結或 pk） */
  input: string;
  /** 解析出的 pkPmsMain */
  pk: string;
  /** 內頁網址 */
  url: string;
  /** 是否成功取得內容（false 代表被驗證碼擋或版型不符） */
  ok: boolean;
  /** 失敗原因：captcha=流量控制驗證碼、parse=版型不符、error=連線錯誤 */
  reason?: 'captcha' | 'parse' | 'error';
  /** 錯誤訊息（reason=error 時） */
  message?: string;
  /** 欄位表（label -> value） */
  fields: Record<string, string>;
  /** 這筆是否來自本地快取 */
  cached: boolean;
}

/** 日期區間過濾條件，皆為民國 yyyMMdd 整數（例：1150701） */
export interface DateFilter {
  /** 公告日期起 */
  publishFrom?: number | null;
  /** 公告日期迄 */
  publishTo?: number | null;
  /** 截止投標日起 */
  deadlineFrom?: number | null;
  /** 截止投標日迄 */
  deadlineTo?: number | null;
}
