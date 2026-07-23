# 這是什麼

監控實驗室的內部即時監控工具。

# 指令

npm workspaces monorepo（`packages/*`）。除了 agent 用 [Bun](https://bun.sh) 編譯外，其餘都需要 Node 20+、npm 10+。

```bash
npm install                                   # 專案根目錄執行一次

# 改了 packages/shared 之後——其他套件吃的是它的 dist/，不是原始碼
npm run build --workspace=packages/shared     # 或用 `npm run dev --workspace=packages/shared` 開 watch mode

npm run dev --workspace=packages/collector    # tsx watch：ws://localhost:8080, http://localhost:8081
npm run dev --workspace=packages/frontend     # Vite dev server：http://localhost:5173

# agent：開發時直接跑原始碼，不用每次改動都重新編譯執行檔
LABMON_AGENT_CONFIG=/path/to/dev-config.json npx tsx packages/agent/src/index.ts
# dev-config.json 內容：{ "hostId": "dev-host-1", "collectorWsUrl": "ws://localhost:8080" }

npm run build --workspace=packages/agent      # 編成 packages/agent/dist-bin/agent（Bun 單一執行檔，這步驟真的需要 Bun，npm 生態沒有現成等價指令）
npm run build                                 # shared -> collector -> frontend，依序（agent 不含在內，另外用 Bun 編譯）

npm test                                              # 先 build shared，再跑所有 workspace 的測試
npm run test --workspace=packages/collector           # 91 個測試：狀態機、SQLite、NAS/Email/遠端安裝、WS/HTTP、整合測試
npm run test --workspace=packages/agent                # 29 個測試：各項 collector、config、WS client
npm run test --workspace=packages/frontend              # 25 個測試：WsProvider、Dashboard、表單頁
npx vitest run path/to/some.test.ts --workspace=packages/collector   # 只跑單一測試檔
```

測試檔就放在被測檔案旁邊（`src/**/*.test.ts`），collector 的 `tsconfig.json` 已排除這些檔案，不會被打包進 `dist/`。

# 架構

**套件與依賴方向：** `shared` → `collector` / `agent` / `frontend`。`shared` 存放三者共用的 WS 協定型別與狀態機時間常數；它是以編譯後的 `dist/` 被引用，所以只改 shared 的原始碼，在重新 build 之前其他套件完全看不到變化。

**資料流：** `agent`（跑在每台受監控的 Ubuntu 主機上，用 Bun 編譯，刻意不進容器——需要直接存取宿主機硬體資訊）每隔 `AGENT_REPORT_INTERVAL_MS` 收集一次指標，透過 WebSocket 推給 `collector`。Collector 把資料寫進 SQLite，再用同一個 WS server、不同的訊息類型廣播給所有連線中的 `frontend` dashboard。NAS 沒有 agent——`nas-prober.ts` 直接對其 ping，並把結果餵給同一個狀態機。

**離線判定狀態機**（`collector/src/state-machine.ts`）是核心的領域邏輯：與傳輸層無關，純粹由 `signalUp(hostId)` / `signalDown(hostId)` 驅動，讓 WS server（判斷 agent 是否存活）與 NAS prober（ping 結果）能共用同一套實作，彼此互不依賴。狀態演進：`online` → `disconnected`（30 秒緩衝期，僅是暫態，不會寫入 `status_event`）→ `offline`（5 分鐘後）→ `notified`。連續收到下線訊號時絕對不能重置升級計時器，否則主機會永遠卡在 `disconnected`，升級不了。

**`ws-server.ts` 是純傳輸層**——只負責解析/驗證訊息、追蹤連線，完全不知道狀態機或儲存層的存在。真正把這些串起來的是 `server.ts`（agent 回報 → 寫入儲存層與狀態機 → 廣播給前端）。之後要擴充功能時，新的傳輸邏輯與商業邏輯要維持這個分工，不要混在一起。

**遠端安裝器**（`collector/src/remote-installer/`）會 SSH 進目標主機，把 agent 執行檔與產生好的 systemd unit 上傳到 SSH 使用者可寫入的暫存目錄，再用 `sudo -n`（非互動模式——遇到需要密碼時直接快速失敗，而不是卡住等一個在這條 exec channel 上根本沒人能回應的密碼提示）把檔案搬進 `/opt/labmon-agent` 與 `/etc/labmon-agent` 並啟用服務。這要求目標主機上的 SSH 使用者對這些操作有免密碼 sudo 權限。安裝成功與否是看 agent 是否真的在時限內透過 WS 連回來，而不是只看 SSH 指令的 exit code——就算每一步 SSH 指令都成功，只要 agent 沒有回連，仍會回報安裝失敗。

**儲存層**（`collector/src/storage/`，用 better-sqlite3）：`host`、`metric_snapshot`（高流量資料，超過 `METRIC_RETENTION_MS` 後由定期清理任務刪除）、`status_event`（永久保留的離線歷史稽核紀錄，不會被清理）、`system_config`（key/value，目前只存通知信箱）。

**HTTP API**（`collector/src/http-server.ts`）：`GET /api/hosts`、`GET /api/hosts/:id/metrics`、`GET|PUT /api/config`、`POST /api/install`。沒有用任何路由框架，是手動比對路徑片段。

# 環境變數

完整清單見 `.env.example`，這裡列的是不容易一眼看懂用途的幾個：

- `COLLECTOR_WS_URL`——必須填 collector 主機真實的區網 IP，不能是 `localhost`。這個值會被寫進每一台新安裝 agent 的設定檔，讓它知道要回連到哪裡。
- `VITE_HTTP_BASE_URL` / `VITE_WS_URL`——在 *build time* 就烤進前端的靜態檔案，Docker build 完之後再改 `.env` 不會生效，要重新 build 才會反映。
- `NAS_HOSTS`——JSON 陣列；格式錯誤時會讓 collector 啟動直接崩潰，這是刻意的，避免安靜地變成監控零台 NAS。
- 沒設定 `SMTP_USER`/`SMTP_APP_PASSWORD` 或 `NAS_HOSTS` 只會讓對應子模組印一行 log 並自我停用，不會噴錯——本機開發時這是正常狀況。

# Docker 部署

容器裡只跑 `collector` 和 `frontend`；agent 刻意永遠不進容器。Collector image 的 build 階段會順便用 Bun 把 agent 執行檔編好並打包進去，所以剛部署好的 collector，遠端安裝功能就能直接使用。
