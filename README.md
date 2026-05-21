# kahoot-cf

A self-hostable, **Kahoot 1:1 clone** running on the Cloudflare free tier. Auth via **Cloudflare Zero Trust (Access)** — no passwords stored, your IdP (Google, GitHub, OTP-email, SAML, etc.) handles login. Visual style: **Bauhaus**.

- Live multiplayer quiz over WebSocket
- PIN-based player join (no signup for players)
- Real-time leaderboard
- Quiz editor with multiple-choice questions
- Host auth via Cloudflare Access (free for ≤50 users)
- Up to ~1000 players per live game
- Fits inside the Cloudflare free plan for small/medium use

## Stack

- Cloudflare Workers (HTTP + WebSocket router)
- Cloudflare Durable Objects (one per active game; SQLite-backed)
- Cloudflare D1 (users, quizzes, questions, game history)
- **Cloudflare Zero Trust Access** for host auth
- Hono web framework
- TypeScript + vanilla HTML/CSS/JS frontend (no build step)

## Deploy

### Step 1 — Deploy the Worker

```bash
npm install
npx wrangler login
make setup     # creates the D1 DB; prints database_id
# Paste the printed database_id into wrangler.toml
make migrate   # applies schema.sql to remote D1
make deploy    # publishes to https://kahoot-cf.<your-account>.workers.dev
```

At this point the player flow already works. Hosts get a 500 ("missing Access config") — that's expected, fix it next.

### Step 2 — Set up Cloudflare Access

1. Open [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com) → **Access → Applications → Add an application → Self-hosted**.
2. **Application Configuration**:
   - **Name**: `kahoot-cf`
   - **Session Duration**: `24 hours` (or whatever you prefer)
   - **Application domain**: your Worker URL — e.g. `kahoot-cf.<account>.workers.dev`
   - **Path**: leave blank to protect everything, then add Bypass rules in step 3.
3. **Identity providers**: pick at least one (Google, GitHub, **One-time PIN** is the easiest — emails a 6-digit code).
4. **Policies**:
   - **Allow policy** named "Hosts": include the emails or domains who may host (e.g. `Selector: Emails ending in @yourdomain.com`).
   - **Bypass policy** named "Players" — this is critical so players can join without logging in. Configure it with:
     - **Action**: Bypass
     - **Selector**: Everyone
     - **Include paths** (under "Application configuration"):
       - `/`
       - `/play.html`
       - `/style.css`, `/app.js`
       - `/api/games/*/check`
       - `/api/games/ws/play*`
       - `/health`

   The simplest way is to make a *second* Access Application that covers only those player paths with a Bypass policy. Cloudflare evaluates Bypass apps before the Allow app.

5. After saving, click into the Application → **Overview** → copy:
   - **Application Audience (AUD) Tag** (hex string)
   - Your **team domain** (e.g. `yourteam.cloudflareaccess.com` → use `yourteam`)

### Step 3 — Wire the Access config into the Worker

Edit `wrangler.toml`:

```toml
[vars]
CF_ACCESS_TEAM_DOMAIN = "yourteam"
CF_ACCESS_AUD = "abc123…"
```

Redeploy:

```bash
make deploy
```

Visit your URL. The player flow works without login. Click "Sign in & host" — Access challenges with your IdP, then drops you on the dashboard.

## Local development

Cloudflare Access isn't available in `wrangler dev`. Create a `.dev.vars` file (already gitignored) with a dev user email:

```bash
cp .dev.vars.example .dev.vars
make dev
```

When `DEV_USER_EMAIL` is set, the Worker auto-provisions that user and bypasses all Access verification. You see the app exactly as a real host would.

## Project layout

```
src/
  index.ts        — Worker entry, Hono routes
  auth.ts         — Cloudflare Access JWT verification, /api/me
  quizzes.ts      — quiz + question CRUD
  games.ts        — create game → route to Durable Object
  game-room.ts    — Durable Object: WS coordination, scoring, timer
  crypto.ts       — PIN + ID generation
  types.ts
public/
  index.html      — landing + PIN join + sign-in link
  dashboard.html  — quiz list
  editor.html     — quiz / question editor (autosave)
  host.html       — live host screen
  play.html       — player screen
  app.js          — fetch wrapper + /api/me helper
  style.css       — Bauhaus stylesheet
schema.sql        — D1 schema (no passwords)
wrangler.toml     — Cloudflare config
```

## Cost on free tier

A single 100-player × 10-question game costs roughly 1000 DO requests and ~5 GB-s of DO duration — well under the free limits of 100K req/day and 13,000 GB-s/day. Zero Trust Access is free for the first 50 seats.

## What's intentionally NOT included

Per spec: no word cloud, no PowerPoint/PDF import, no video questions, no LMS integration, no public quiz search. The architecture supports adding any of these later.

## License

MIT
