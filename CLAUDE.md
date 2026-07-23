# 這是什麼

監控實驗室的內部即時監控工具。

# 指令

npm workspaces monorepo（`packages/*`）。除了 agent 用 [Bun](https://bun.sh) 編譯外，其餘都需要 Node 20+、npm 10+。

```bash
npm install                                   # 專案根目錄執行一次

# 改了 packages/shared 之後——其他套件吃的是它的 dist/，不是原始碼
npm run build --workspace=packages/shared     # 或用 `npm run dev --workspace=packages/shared` 開 watch mode

npm run dev --workspace=packages/collector    # tsx watch，會用 Node 內建 --env-file-if-exists 讀根目錄 .env：ws://localhost:8080, http://localhost:8081
npm run dev --workspace=packages/frontend     # Vite dev server：http://localhost:5173

npm run dev --workspace=packages/agent        # tsx 跑原始碼，預設吃 packages/agent/dev-config.json，不用每次改動都重新編譯執行檔

npm run build --workspace=packages/agent      # 編成 packages/agent/dist-bin/agent-linux-{x64,arm64}（Bun 交叉編譯兩種架構，這步驟真的需要 Bun，npm 生態沒有現成等價指令）
npm run build                                 # shared -> collector -> frontend，依序（agent 不含在內，另外用 Bun 編譯）

npm test                                              # 先 build shared，再跑所有 workspace 的測試
npm run test --workspace=packages/collector           # 117 個測試：狀態機、SQLite、NAS/Email/遠端安裝、WS/HTTP、整合測試
npm run test --workspace=packages/agent                # 29 個測試：各項 collector、config、WS client
npm run test --workspace=packages/frontend              # 39 個測試：WsProvider、Dashboard、表單頁
npx vitest run path/to/some.test.ts --workspace=packages/collector   # 只跑單一測試檔
```

測試檔就放在被測檔案旁邊（`src/**/*.test.ts`），collector 的 `tsconfig.json` 已排除這些檔案，不會被打包進 `dist/`。

# 架構

**套件與依賴方向：** `shared` → `collector` / `agent` / `frontend`。`shared` 存放三者共用的 WS 協定型別與狀態機時間常數；它是以編譯後的 `dist/` 被引用，所以只改 shared 的原始碼，在重新 build 之前其他套件完全看不到變化。

**資料流：** `agent`（跑在每台受監控的 Ubuntu 主機上，用 Bun 編譯，刻意不進容器——需要直接存取宿主機硬體資訊）每隔 `AGENT_REPORT_INTERVAL_MS` 收集一次指標，透過 WebSocket 推給 `collector`。Collector 把資料寫進 SQLite，再用同一個 WS server、不同的訊息類型廣播給所有連線中的 `frontend` dashboard。NAS 沒有 agent——`nas-prober.ts` 直接對其 ping，並把結果餵給同一個狀態機。

**NAS 主機清單不是環境變數設定的，是前端動態新增的**：Settings 頁面呼叫 `POST /api/nas-hosts`（`{name, ip}`），collector 產生 `id`（`randomUUID()`），寫進 `nas_host` 表（同時也 upsert 一筆 `host` 表的列，type 為 `nas`），並呼叫 `nasProber.addHost()` 讓它立刻被排進輪詢、且馬上 ping 一次（不用等下一輪 30 秒週期）。`nas-prober.ts` 本身完全不碰 storage 的寫入邏輯了——`start()` 只從 `storage.listNasHosts()` 載入現有清單開始輪詢，新增/刪除都是靠 `addHost()`/`removeHost()` 這兩個執行期方法（`DELETE /api/hosts/:id` 刪除任一種 host 時，會一併呼叫 `nasProber.removeHost()`，否則背景輪詢會繼續 ping 一個已經從資料庫消失的主機）。

**離線判定狀態機**（`collector/src/state-machine.ts`）是核心的領域邏輯：與傳輸層無關，純粹由 `signalUp(hostId)` / `signalDown(hostId)` 驅動，讓 WS server（判斷 agent 是否存活）與 NAS prober（ping 結果）能共用同一套實作，彼此互不依賴。狀態演進：`online` → `disconnected`（30 秒緩衝期，僅是暫態，不會寫入 `status_event`）→ `offline`（5 分鐘後）→ `notified`。連續收到下線訊號時絕對不能重置升級計時器，否則主機會永遠卡在 `disconnected`，升級不了。

**`ws-server.ts` 是純傳輸層**——只負責解析/驗證訊息、追蹤連線，完全不知道狀態機或儲存層的存在。真正把這些串起來的是 `server.ts`（agent 回報 → 寫入儲存層與狀態機 → 廣播給前端）。之後要擴充功能時，新的傳輸邏輯與商業邏輯要維持這個分工，不要混在一起。

**遠端安裝器**（`collector/src/remote-installer/`）會 SSH 進目標主機，也跑一次 `hostname` 當作 dashboard 上顯示的主機名稱（純粹是好看，跟 `uname -m` 判斷架構是分開的兩次 exec；抓不到時退回用 `targetIp`，不會讓整個安裝失敗），再跑 `uname -m` 判斷目標架構（`x86_64` → `agent-linux-x64`、`aarch64`/`arm64` → `agent-linux-arm64`，其他架構直接失敗），選對的 agent 執行檔跟產生好的 systemd unit 上傳到 SSH 使用者可寫入的暫存目錄，再用 `sudo -S`（從 SSH exec channel 的 stdin 讀密碼）把檔案搬進 `/opt/labmon-agent` 與 `/etc/labmon-agent` 並啟用服務。安裝表單的 `sudoPassword` 欄位是選填，前端留白時直接用 SSH 密碼頂替（兩者相同是常見情況），送到後端的 `InstallRequest.sudoPassword` 一律是非空字串。不會嘗試先用免密碼 sudo、失敗才問——`sudo -S` 對已設好 NOPASSWD 的機器一樣能跑（它根本不會去讀 stdin），所以不用在流程中途暫停詢問密碼。密碼只在記憶體中用一次、不落地，跟 SSH 密碼的處理方式一致；`SshSession.exec()` 支援傳入 stdin 字串，內容是依指令鏈裡 `sudo -S` 出現次數重複的密碼行。安裝成功與否是看 agent 是否真的在時限內透過 WS 連回來，而不是只看 SSH 指令的 exit code——就算每一步 SSH 指令都成功，只要 agent 沒有回連，仍會回報安裝失敗。

**儲存層**（`collector/src/storage/`，用 better-sqlite3）：`host`、`metric_snapshot`（高流量資料，超過 `METRIC_RETENTION_MS` 後由定期清理任務刪除）、`status_event`（永久保留的離線歷史稽核紀錄，不會被清理）、`system_config`（key/value，目前只存通知信箱）、`nas_host`（`id`/`name`/`ip`，`id` 對應 `host.id`；`deleteHost()` 會把兩張表的列一起刪掉，避免兩邊資料drift）。

**HTTP API**（`collector/src/http-server.ts`）：`GET /api/hosts`、`GET /api/hosts/:id/metrics`、`DELETE /api/hosts/:id`、`GET|POST /api/nas-hosts`、`GET|PUT /api/config`、`POST /api/install`。沒有用任何路由框架，是手動比對路徑片段。

# 環境變數

完整清單見 `.env.example`，這裡列的是不容易一眼看懂用途的幾個：

- `COLLECTOR_WS_URL`——必須填 collector 主機真實的區網 IP，不能是 `localhost`。這個值會被寫進每一台新安裝 agent 的設定檔，讓它知道要回連到哪裡。
- `VITE_HTTP_BASE_URL` / `VITE_WS_URL`——在 *build time* 就烤進前端的靜態檔案，Docker build 完之後再改 `.env` 不會生效，要重新 build 才會反映。
- 沒設定 `SMTP_USER`/`SMTP_APP_PASSWORD` 只會讓對應子模組印一行 log 並自我停用，不會噴錯——本機開發時這是正常狀況。NAS 主機清單不在這裡設定，見上面「架構」一節。

# Docker 部署

容器裡只跑 `collector` 和 `frontend`；agent 刻意永遠不進容器。Collector image 的 build 階段會順便用 Bun 把 x64 跟 arm64 兩種架構的 agent 執行檔都編好並打包進去（實驗室機器不假設只有一種 CPU 架構），所以剛部署好的 collector，遠端安裝功能就能直接使用。
