# kahoot.c11g.tw 部署教學

> 個人化部署指南 — fork 自 [htlin222/kahoot-cf](https://github.com/htlin222/kahoot-cf)
> Target: `kahoot.c11g.tw` (Cloudflare Workers + Durable Objects + D1 + Zero Trust)
> Cost: ~NT$890/year (domain) + $0 Cloudflare free tier
> Time: ~1 hour first-time setup

## 📋 流程總覽

```
1. Cloudflare 註冊 (5 min)         [免費]
2. TWNIC 註冊 c11g.tw  (15 min)    [NT$890/year]
3. 切 nameserver 到 Cloudflare (10 min + DNS propagation up to 24h)
4. wrangler login + D1 setup (10 min)
5. 設定 Zero Trust Access (15 min)
6. make deploy (5 min)
7. 測試 / 第一場 quiz!
```

---

## Step 1 — Cloudflare 註冊（5 min, 免費）

1. 到 https://dash.cloudflare.com/sign-up
2. 填 email (建議用 `medilife.c11g@gmail.com`) + 強密碼
3. 開啟兩步驟驗證（建議 — Workers / D1 / Zero Trust 都會跟你的帳號綁）
4. **記下你的 Account ID**：dash → 右下角 → "Workers & Pages" → "Account ID"
   - 64 char hex
   - 之後 wrangler 會用

---

## Step 2 — 註冊 c11g.tw（15 min, NT$890/year）

**Cloudflare 不能直接賣 .tw**（TWNIC 管理）。推薦 registrar：

| Registrar | 一年費用 | 備註 |
|---|---|---|
| **HiNet** (中華電信) | NT$850 | 老牌穩定、付款方便 |
| **NEXT** (next.com.tw) | NT$890 | 介面現代化 |
| **GoDaddy.tw** | NT$1,200+ | 國際大廠但較貴 |
| **PChome 網站家族** | NT$880 | 中文支援強 |

**操作步驟**（以 HiNet 為例）：

1. https://domain.hinet.net → 搜尋 `c11g.tw`
2. 確認可購 → 加入購物車
3. 註冊資訊：英文姓名（與 email 對應）+ 完整地址
4. 付款（信用卡 / ATM）
5. 拿到註冊確認 email + 後台帳號

> ⚠️ `.tw` 域名一年 lock-in 不能 transfer 到別家 registrar，但 nameserver 可隨時改。

---

## Step 3 — 把 c11g.tw 切到 Cloudflare（10 min + DNS 等待）

### 3.1 在 Cloudflare 加 site

1. dash.cloudflare.com → 左側 "Websites" → "Add a site"
2. 輸入 `c11g.tw` → "Continue"
3. Plan: 選 **Free** ($0/month)
4. Cloudflare 會掃描現有 DNS（可能空白）→ "Continue"
5. **重要**：Cloudflare 會給你 **兩個 nameserver**，類似：
   ```
   ada.ns.cloudflare.com
   ben.ns.cloudflare.com
   ```
   把這兩個 **複製下來**

### 3.2 在 TWNIC registrar 改 nameserver

1. 登入 HiNet domain 後台
2. 找 `c11g.tw` → "修改 DNS Server" / "NS Records"
3. **刪除預設 nameserver**（通常是 HiNet 的 `dns.hinet.net` 之類）
4. **新增 Cloudflare 給的兩個 NS**
5. 儲存

### 3.3 等待 propagation

```bash
# 在你的 Mac 上跑這個檢查
dig +short NS c11g.tw
```

如果輸出包含 `cloudflare.com` 就 OK 了。通常 10 min - 2 hr，最壞 24-48 hr。

回 Cloudflare dashboard → 應該會自動偵測到 → status 變 "Active" ✓

---

## Step 4 — wrangler 設定 + D1 創建（10 min）

```bash
cd ~/Projects/kahoot-cf

# wrangler 已裝好 (v4.93.1)，直接登入：
wrangler login
# → 瀏覽器會跳出，授權給 wrangler 用你的 Cloudflare 帳號
```

```bash
# 創建 D1 database
make setup

# 輸出大概像：
#   ✅ Successfully created DB 'kahoot-cf'
#   database_id = "abcdef-..."
```

**複製 `database_id`** → 打開 `wrangler.toml` → 把 `database_id = "TBD-after-make-setup"` 換成剛拿到的 ID。

```bash
# Run schema
make migrate

# 應該看到 5 個 tables 創建成功：users / quizzes / questions / game_history / 等
```

---

## Step 5 — Zero Trust Access 設定（15 min）

Zero Trust = 用 Google/GitHub/SAML 登入保護 host 介面。**只有 host 路徑需要保護**，player 介面要公開。

### 5.1 啟用 Zero Trust

1. dash.cloudflare.com → 左側 "Zero Trust"（如果沒有，會跳 onboarding）
2. **Team name**：輸入 `c11g`（建議短好記）→ 完整 team URL: `c11g.cloudflareaccess.com`
3. Plan: **Free**（最多 50 users，給你個人 / 演講團隊用綽綽有餘）

### 5.2 設定 Identity Provider

1. Zero Trust → Settings → Authentication → Login methods
2. 加 **Google** 為主要 IdP（建議）
   - Add new → "Google"
   - 用 default credentials（Cloudflare 提供的 Google OAuth app）
   - Test → 應該可以用 medilife.c11g@gmail.com 登入

### 5.3 建立 3 個 Access Applications

#### App 1: Host (Allow with Google login)

1. Access → Applications → "Add an application" → "Self-hosted"
2. 設定：
   - Name: `kahoot-cf-host`
   - Subdomain: `kahoot`
   - Domain: `c11g.tw`
   - **Path**: 留空 → 保護整個 domain（之後 bypass 細項覆蓋）
3. **Identity providers**: ☑ Google
4. Policy:
   - Name: `Allow myself`
   - Action: `Allow`
   - Include: `Emails` → `medilife.c11g@gmail.com`
5. Save
6. 點剛建好的 app → **Overview tab** → 複製 **AUD (Application Audience)** tag → 64 char hex

**填回 `wrangler.toml`**：
```toml
[vars]
CF_ACCESS_TEAM_DOMAIN = "c11g"
CF_ACCESS_AUD = "<剛複製的 64 char hex>"
```

#### App 2: Static Bypass

1. Access → Applications → Add → Self-hosted
2. Name: `kahoot-cf-static`
3. Domain: `kahoot.c11g.tw`
4. **Path**: `/play.html` 跟 `/index.html` 跟 `/style.css` 跟 `/app.js`
   - 實際上設定為 `/play.html, /index.html, /style.css, /app.js`（or 用 multiple rules）
5. Policy: Action = **Bypass**（任何人都不需登入即可訪）
6. Include: Everyone

#### App 3: Player API Bypass

1. Access → Applications → Add → Self-hosted
2. Name: `kahoot-cf-player-api`
3. Domain: `kahoot.c11g.tw`
4. **Path**: `/api/play/*` (玩家 API endpoints)
5. Policy: Action = **Bypass**
6. Include: Everyone

> 💡 **Cloudflare evaluation order**: Bypass evaluated BEFORE Allow, and more-specific path wins on overlap. 所以 `/play.html` (Bypass) 會優先於整 domain Allow，達到「playerpaths 公開、其他要登入」效果。

---

## Step 6 — Deploy 🚀

```bash
cd ~/Projects/kahoot-cf

# 安裝 dependencies
make install

# Deploy 到 Cloudflare
make deploy

# 應該看到：
#   ✅ Successfully deployed to Cloudflare Workers
#   Published kahoot-cf (X.YZ sec)
#     https://kahoot.c11g.tw
```

打開 `https://kahoot.c11g.tw` 應該：
- 第一次訪問會跳 Google login (Zero Trust)
- 登入後可建 quiz、開房間、生 PIN
- 學員打 `https://kahoot.c11g.tw` (or 直接到 player URL) + PIN 加入

---

## Step 7 — 本地測試（optional, dev mode）

```bash
# .dev.vars 設定本地 bypass
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars 把 DEV_USER_EMAIL 設成 medilife.c11g@gmail.com

# 啟動本地 dev server
make dev
# → 開 http://localhost:8787
# → 本地不會跳 Zero Trust，直接用 .dev.vars 模擬已登入
```

---

## 🎯 第一場 Quiz 測試

1. 訪問 `https://kahoot.c11g.tw` → Google 登入
2. Dashboard → "New Quiz" → 設題目
3. "Start Game" → 拿到 4-digit PIN
4. 學員手機掃 QR 或打 URL + PIN → 進房間
5. 主持人 "Start" → 即時計分

---

## 🛠 Troubleshooting

### "wrangler login" 卡在瀏覽器

- 確認 Cloudflare 帳號已 verify email
- 試 `wrangler login --browser=false` 拿到 OAuth URL 手動開

### `make migrate` 報 "Database not found"

- 確認 `wrangler.toml` 內 `database_id` 已換成 step 4 拿到的 ID
- 確認 `database_name = "kahoot-cf"` 沒打錯

### 部署後訪問 `kahoot.c11g.tw` 看到 522 error

- 表示 Worker route 沒抓到。檢查：
  - dash.cloudflare.com → Websites → c11g.tw → DNS → `kahoot` CNAME 是否指向 Worker
  - wrangler.toml 內 `routes` 是否拼對

### Zero Trust 不跳登入

- App 1 (host) 的 Policy "Allow myself" 必須勾 `Include` → `Emails` 加你 email
- IdP 必須選 Google (or 你用的那個)
- 清 browser cache + cookies

### Player 看不到 quiz 介面

- App 2/3 (bypass) path 拼錯。重新檢查：
  - `/play.html` `/index.html` `/style.css` `/app.js` 必須在 Static Bypass app
  - `/api/play/*` 必須在 Player API Bypass app

---

## 💰 成本估計

| 項目 | 一次性 | 年費 |
|---|---|---|
| `c11g.tw` (HiNet) | — | NT$890 |
| Cloudflare Free | $0 | $0 |
| Workers Free (100k req/day) | $0 | $0 |
| D1 Free (5GB) | $0 | $0 |
| Durable Objects Free (1M req/month) | $0 | $0 |
| Zero Trust Free (50 users) | $0 | $0 |
| **Total** | **$0** | **NT$890** |

> 如果單場 quiz 超過 100 人 / 月用量超 100k req → 升 Cloudflare Workers Paid $5/month。
> 大部分教學場景**永遠在免費 tier 內**。

---

## 🎁 後續客製化建議

- **改 logo / 配色**：`public/style.css` 改 Bauhaus 風格
- **加題庫**：可以匯入 POCUS 教學常用題庫 (CSV/JSON)
- **整合 Slack/Discord**：用 Workers Webhook 通知遊戲結果
- **多語言**：原 repo 是英文 UI，可改 i18n 支援中文

---

## 📞 出問題找誰

- htlin222 原作者 issue: https://github.com/htlin222/kahoot-cf/issues
- 你的 fork: https://github.com/medilife-c11g/kahoot-cf

---

Generated 2026-05-22 by Claude Code based on htlin222/kahoot-cf repo state at commit `Player options: stack A/B/C/D badge`.
