# 更新說明 (Changelog)

本文件記錄 Taiwan Tender MCP 的變更細節。

## [0.0.3] - 2026-09-02

### 新功能 (Added)
- **`search_tender_archive`：可查已截止的歷史標案**。走官網「全文檢索（電子公報）」
  `readBulletion`，涵蓋民國 88 年起的公報，補上 `search_tenders`（只有等標期內）查不到的範圍。
  支援布林查詢語法、公報種類（招標／決標／公開閱覽及公開徵求／政府採購預告）、
  多年度（一次最多 3 年）與本地日期區間過濾；輸出自動分成「等標期內」與「已截止／歷史案」兩段。
  回傳的「查看」連結是 `tpam?pk=`，可直接餵給 `get_tender_detail`。
- **MCP server instructions**：把「查標案要分等標期內／已截止兩段回報、0 筆也要明寫」等
  行為規則寫進 server instructions，任何 client 掛上這支 MCP 就生效。

### 已知限制 (Known Limitations)
- 全文檢索**單次上限 100 筆／年度**：`pageSize` 帶 200/500/1000 一律只回 100 筆；
  官網分頁（`d-<id>-p`）是伺服器 session 狀態式的，GET／POST／完整 cookie jar／正確 Referer
  四種組合實測都只回沒有結果的表單頁（同一網址在瀏覽器可用）。
  因此改為「取最新 100 筆並誠實回報官網命中總數」，超出時提示縮小條件，不用瀏覽器自動化硬翻。

### 驗收 (Verification)
- `_smoke_archive.mjs`：36 項（年度解析、列表解析、截斷回報、歷史年度已截止判定、日期過濾、多年度合併）。
- `_smoke_mcp_archive.mjs`：stdio handshake 檢查工具註冊、instructions 內容與實際呼叫輸出分段；
  以「讀到回應才往下」取代定時 sleep，避免舊 `_smoke_mcp.mjs` 的假 FAIL。

## [0.0.2] - 2026-02-02

### 結構優化 (Refactoring)
- 重構專案架構，將爬蟲邏輯、業務邏輯與工具函數分離至 `services` 與 `utils` 目錄。
- 統一日期處理邏輯，建立 `src/utils/date.ts`。

### 爬蟲功能增強 (Crawler Improvements)
- **編碼修復**：引入 `iconv-lite` 自動處理政府網站的 Big5 編碼問題，修正搜尋結果亂碼。
- **解析優化**：改進標案案號與案名的拆分邏輯，提升抓取成功率。
- **Header 模擬**：優化瀏覽器 Header 模擬，降低被網站攔截的風險。

### 其他變更 (Other Changes)
- 修正 TypeScript 在 strict 模式下的型別錯誤。
- 清理根目錄，將測試腳本移至 `debug/` 資料夾。
- 更新版本號至 0.0.2 並同步 MCP Server 版本資訊。

## [0.0.1] - 2026-01-28

### 新功能 (Added)
- 初始版本：支援基本爬蟲搜尋與 MCP 工具介接。

---
*最後編輯: 2026-09-02*