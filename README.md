# 實驗室電腦監控系統

即時監控實驗室 8 台 Ubuntu 主機（CPU/記憶體/磁碟/GPU）與 2 台 NAS（在線狀態）的內部工具。細節設計請見專案交付時附上的技術藍圖文件；本文件只說明**如何動手開發**。

## 專案結構

npm workspaces monorepo：

```
packages/
  shared/     @labmon/shared    -- 前後端與 Agent 共用的 TypeScript 型別與常數（WS 協定、狀態機時間常數等）
  collector/  @labmon/collector -- 核心後端：WebSocket server、離線判定狀態機、SQLite、NAS 探測、Email 通知、遠端安裝（Node.js）
  agent/      @labmon/agent     -- 跑在每台受監控主機上的常駐程式，編譯為單一執行檔（Bun）
  frontend/   @labmon/frontend  -- Dashboard SPA（React + Vite）
```

`packages/shared` 是型別合約，其他三個套件都依賴它 build 完成後的 `dist/`，**修改 shared 後務必重新 build** 才會反映到其他套件。

## 環境需求

- Node.js 20+、npm 10+（collector / frontend / shared）
- [Bun](https://bun.sh)（僅 agent 需要，用來 `bun build --compile` 成單一執行檔）
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- Docker + Docker Compose（僅部署 collector/frontend 時需要；agent 不進容器）

## 首次設定

```bash
git clone <this-repo>
cd monitor
npm install          # 一次安裝所有 workspace 的依賴
cp .env.example .env # 開發時若要跑 collector 完整流程（Email/NAS/遠端安裝），依需要填入
```

## 開發流程

### 1. 修改 `packages/shared` 之後

任何套件都是吃 `packages/shared/dist`，不是原始碼，所以改完型別要先 build：

```bash
npm run build --workspace=packages/shared
```

（或在另一個終端機跑 `npm run dev --workspace=packages/shared` 開 watch mode，改了就自動重編。）

### 2. Collector（後端）

```bash
npm run dev --workspace=packages/collector    # tsx watch，改檔自動重啟
```

會用 Node 內建的 `--env-file-if-exists` 讀取專案根目錄的 `.env`（檔案不存在也不會報錯，直接跳過）；`npm run start` 也一樣。改了 `.env` 記得重啟這個指令才會生效——只是重啟並不會回頭去改已經裝在受監控主機上的 agent 設定檔，那份是安裝當下寫死的（見「除錯小抄」）。

預設監聽：
- `ws://localhost:8080` — Agent / Dashboard 共用的 WebSocket
- `http://localhost:8081` — HTTP API（`GET /api/hosts`、`GET /api/hosts/:id/metrics`、`GET|PUT /api/config`、`POST /api/install`）

SQLite 檔案預設寫在 `./data/collector.db`（`data/` 已在 `.gitignore` 中）。常用環境變數（完整列表見 `.env.example`）：

| 變數 | 用途 | 預設值 |
|---|---|---|
| `WS_PORT` / `HTTP_PORT` | 監聽埠 | `8080` / `8081` |
| `DB_PATH` | SQLite 位置 | `./data/collector.db` |
| `SMTP_USER` / `SMTP_APP_PASSWORD` | 寄信用的獨立 Gmail 帳號（見 `.env.example` 註解） | 未設定則自動停用通知，不會噴錯 |
| `COLLECTOR_WS_URL` | 寫入新安裝 Agent 設定檔的回連位址，**必須是區網真實 IP**，不能是 `localhost` | `ws://localhost:8080` |
| `AGENT_BINARY_DIR` | 遠端安裝用，存放各架構 Agent 執行檔（`agent-linux-x64`、`agent-linux-arm64`）的目錄 | 見 `packages/collector/src/remote-installer/index.ts` |

沒有設定 SMTP 帳密也能正常開發，這個子模組會記 log 並自我停用，不影響其他功能。NAS 主機不是環境變數設定的，是透過 Settings 頁面（`POST /api/nas-hosts`）動態新增，存在 SQLite 的 `nas_host` 表裡，新增後立刻開始 ping，不用重啟 collector。

### 3. Frontend

```bash
npm run dev --workspace=packages/frontend     # Vite dev server, http://localhost:5173
```

Vite 會讀 `packages/frontend/.env`（可從 `.env.example` 複製）決定要打哪個 collector：

```
VITE_HTTP_BASE_URL=http://localhost:8081
VITE_WS_URL=ws://localhost:8080
```

沒有 `.env` 就直接用上面兩個預設值，本機開發通常不用另外設定，只要 collector 是跑在預設埠上即可。

### 4. Agent

Agent 平常不需要每次改動都編成執行檔，直接用 Bun 跑原始碼最快：

```bash
LABMON_AGENT_CONFIG=dev-config.json bun run --cwd packages/agent src/index.ts
```

`dev-config.json` 範例（正式環境是 Remote Installer 在安裝時自動產生這份檔案，路徑固定在受監控主機的 `/etc/labmon-agent/config.json`）：

```json
{ "hostId": "dev-host-1", "collectorWsUrl": "ws://localhost:8080" }
```

要編成正式的執行檔（跟遠端安裝流程一樣的產出物）：

```bash
npm run build --workspace=packages/agent
# 產出 packages/agent/dist-bin/agent-linux-x64 與 agent-linux-arm64
# 兩種架構都編，因為實驗室主機不保證同一種 CPU 架構——遠端安裝時用 `uname -m` 挑對應的那個上傳
```

GPU 相關指標需要本機有 `nvidia-smi`；沒有的話該欄位會回報 `errors.gpu`，其餘欄位不受影響，這是預期行為（見 `packages/agent/src/collectors/gpu.ts`）。

## 測試

每個套件用 [Vitest](https://vitest.dev/)（frontend 另外加 jsdom + React Testing Library）。

```bash
npm test                                      # 依序 build shared，再跑三個套件全部測試
npm run test --workspace=packages/collector   # 只跑 collector（117 tests：狀態機、SQLite、NAS/Email/遠端安裝、WS/HTTP、整合測試）
npm run test --workspace=packages/agent       # 只跑 agent（29 tests：各項 collector、config、WS client）
npm run test --workspace=packages/frontend    # 只跑 frontend（39 tests：WsProvider、Dashboard、表單頁）
```

新增功能或修 bug 時，優先在對應套件內加 `*.test.ts`（或 `.tsx`），檔案放在被測檔案旁邊即可（Vitest 設定為 glob `src/**/*.test.ts`）。collector 的 `tsconfig.json` 已排除 `*.test.ts`，不會被打包進 `dist/`。

## Build 全部套件

```bash
npm run build     # shared -> collector -> frontend（依序，因為後者吃前者的 dist）
```

Agent 不含在這個指令裡，因為它用 Bun 另外編譯（見上方「Agent」一節）。

## 用 Docker 部署（collector + frontend）

Agent 刻意不進容器（需要直接存取宿主機硬體資訊），Collector 的 image 會在 build 階段順便用 Bun 把 Agent 執行檔編好、打進 image 裡，讓遠端安裝功能開箱即用。

```bash
cp .env.example .env
# 編輯 .env：COLLECTOR_WS_URL / VITE_HTTP_BASE_URL / VITE_WS_URL 務必改成正式主機的區網 IP
# （VITE_* 是在 build time 就烤進前端靜態檔案的，事後改 .env 不會生效，要重新 build）
docker compose build
docker compose up -d
```

- Collector：`ws://<host>:8080`、`http://<host>:8081`
- Frontend：`http://<host>:3000`
- SQLite 資料庫與 Collector 的 SSH 金鑰都在 `./data`（bind mount），重啟容器不會遺失。

## 除錯小抄

- **改了 shared 但其他套件行為沒變** → 忘記 `npm run build --workspace=packages/shared` 了。
- **Frontend 連不上 collector** → 檢查 `packages/frontend/.env` 的埠號是否跟 collector 實際監聽的一致；瀏覽器主控台看 WS 是否一直重連。
- **遠端安裝一直卡在 waiting_for_connection 最後 failed** → 先確認 `COLLECTOR_WS_URL` 是不是設成 `localhost`（對受監控主機來說沒有意義，一定要填 Collector 所在主機的區網 IP）。
- **改了 `COLLECTOR_WS_URL` 重啟 collector，已經裝好的 agent 卻還是連到舊位址** → 這個值只在**安裝當下**被讀一次、寫進那台主機的 `/etc/labmon-agent/config.json`，之後不會被重新推送。修法：在 dashboard 用 Remove host 移掉這台後重新跑一次 Remote Install，或直接 SSH 進去手動改那個檔案再 `sudo systemctl restart labmon-agent`。
- **Email 通知沒有寄出** → 檢查 log 是否印出 `[email-notifier] SMTP_USER/SMTP_APP_PASSWORD not set` 或 `No "notify_email" configured`，兩者都是「已知未設定、正常跳過」，不是錯誤。
