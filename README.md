# kahoot-cf

A self-hostable, **Kahoot 1:1 clone** running on the Cloudflare free tier. Auth via **Cloudflare Zero Trust (Access)** — no passwords stored, your IdP (Google, GitHub, OTP-email, SAML, etc.) handles login. Visual style: **Bauhaus**.

- Live multiplayer quiz over WebSocket
- PIN-based player join (no signup for players)
- Real-time leaderboard
- Quiz editor with CSV/JSON import + downloadable templates
- Inline quiz rename + autosaving title field
- Host auth via Cloudflare Access (free for ≤50 users)
- Up to ~1000 players per live game
- Fits inside the Cloudflare free plan for small/medium use

## Stack

- Cloudflare Workers (HTTP + WebSocket router)
- Cloudflare Durable Objects (one per active game; SQLite-backed)
- Cloudflare D1 (users, quizzes, questions, game history)
- **Cloudflare Zero Trust Access** for host auth
- Hono web framework (`hono/jwt` for Access JWT verification)
- TypeScript + vanilla HTML/CSS/JS frontend (no build step)

## Deploy

### Step 1 — Deploy the Worker

```bash
pnpm install           # or npm install
wrangler login
make setup             # creates the D1 DB; prints database_id
# Paste the printed database_id into wrangler.toml
make migrate           # applies schema.sql to remote D1
make deploy            # publishes to a workers.dev URL (or your custom domain)
```

At this point the player flow already works. Hosts get a 500 ("missing Access config") — that's expected; fix it next.

### Step 2 — Bind a custom domain (optional but recommended)

If you have a domain in your Cloudflare account, add a Workers Custom Domain route in `wrangler.toml`:

```toml
workers_dev = false
routes = [
  { pattern = "kahoot.example.com", custom_domain = true },
]
```

Then `make deploy` again. Cloudflare auto-creates the DNS record. Disabling `workers_dev` ensures Access is the only entry point.

### Step 3 — Configure Cloudflare Zero Trust Access

You need three apps under your Zero Trust account:

| App | Purpose | Policy | Destinations |
|---|---|---|---|
| `kahoot-cf-host` | Protect host paths | **Allow** / single email | `kahoot.example.com/dashboard*`, `/editor*`, `/host*`, `/api/*` |
| `kahoot-cf-static` | Bypass for static UI | **Bypass** / Everyone | `kahoot.example.com/`, `/index.html`, `/play.html`, `/style.css`, `/app.js` |
| `kahoot-cf-player-api` | Bypass for player API | **Bypass** / Everyone | `kahoot.example.com/health`, `/api/games/*/check`, `/api/games/ws/play` |

Cloudflare evaluates Bypass before Allow, and a more-specific path wins on overlap — so the `/api/*` host destination doesn't lock players out of `/api/games/PIN/check`.

#### API method (recommended — repeatable)

1. Generate an API token at `https://dash.cloudflare.com/profile/api-tokens` with:
   - `Account → Access: Apps and Policies → Edit`
   - `Account → Access: Organizations, Identity Providers, and Groups → Read`

2. Export to `.env` (gitignored — **do not** name it `CF_API_TOKEN`, that collides with wrangler's own auth env):

   ```bash
   KAHOOT_CF_API_TOKEN=cfut_...
   CF_ACCOUNT_ID=<your account id>
   CF_HOST_EMAIL=you@example.com
   CF_APP_HOSTNAME=kahoot.example.com
   ```

3. Discover your team domain + IdP id:

   ```bash
   . ./.env
   curl -H "Authorization: Bearer $KAHOOT_CF_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/organizations" \
     | jq '.result.auth_domain'

   curl -H "Authorization: Bearer $KAHOOT_CF_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/identity_providers" \
     | jq '.result[] | {name, type, id}'
   ```

4. Create the three apps. Example for the host app (returns `id` and `aud`):

   ```bash
   curl -X POST -H "Authorization: Bearer $KAHOOT_CF_API_TOKEN" \
     -H 'Content-Type: application/json' \
     "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" \
     -d '{
       "name": "kahoot-cf-host",
       "type": "self_hosted",
       "session_duration": "24h",
       "app_launcher_visible": false,
       "allowed_idps": ["<IDP_ID>"],
       "destinations": [
         {"type":"public","uri":"kahoot.example.com/dashboard*"},
         {"type":"public","uri":"kahoot.example.com/editor*"},
         {"type":"public","uri":"kahoot.example.com/host*"},
         {"type":"public","uri":"kahoot.example.com/api/*"}
       ]
     }'
   ```

   Then attach the Allow policy:

   ```bash
   curl -X POST -H "Authorization: Bearer $KAHOOT_CF_API_TOKEN" \
     -H 'Content-Type: application/json' \
     "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/<APP_ID>/policies" \
     -d '{"name":"Only me","decision":"allow","include":[{"email":{"email":"'$CF_HOST_EMAIL'"}}],"precedence":1}'
   ```

   Repeat for the two Bypass apps (`decision: "bypass"`, `include: [{"everyone":{}}]`). Cloudflare's GUI caps destinations at 5 per app — splitting the public paths across two bypass apps stays within that.

5. Take the `aud` from the host app and your team domain (prefix of `*.cloudflareaccess.com`) and paste into `wrangler.toml`:

   ```toml
   [vars]
   CF_ACCESS_TEAM_DOMAIN = "yourteam"
   CF_ACCESS_AUD = "abc123…"
   ```

6. `make deploy` once more. Done.

#### GUI method (alternative)

Same shape, three Self-hosted Access apps with the destinations and policies from the table above. The dashboard caps destinations per app at 5, which is why public paths are split across two bypass apps.

## Local development

Cloudflare Access isn't available in `wrangler dev`. Create a `.dev.vars` file (gitignored) with a dev user email:

```bash
cp .dev.vars.example .dev.vars
make dev
```

When `DEV_USER_EMAIL` is set, the Worker auto-provisions that user and bypasses all Access verification. You see the app exactly as a real host would.

## Project layout

```
src/
  index.ts        — Worker entry, Hono routes
  auth.ts         — Cloudflare Access JWT verification (hono/jwt), /api/me
  quizzes.ts      — quiz + question CRUD
  games.ts        — create game → route to Durable Object
  game-room.ts    — Durable Object: WS coordination, scoring, timer
  crypto.ts       — PIN + ID generation
  types.ts
public/
  index.html      — landing + PIN join + sign-in link
  dashboard.html  — quiz list (inline rename, CSV/JSON import modal)
  editor.html     — quiz / question editor (autosave + correct-answer badge)
  host.html       — live host screen (graceful reconnect on WS close)
  play.html       — player screen (full-bleed answer buttons)
  app.js          — fetch wrapper + /api/me helper
  style.css       — Bauhaus stylesheet
schema.sql        — D1 schema (no passwords)
wrangler.toml     — Cloudflare config (Workers, D1, Custom Domain, Access vars)
```

## Cost on free tier

A single 100-player × 10-question game costs roughly 1000 DO requests and ~5 GB-s of DO duration — well under the free limits of 100K req/day and 13,000 GB-s/day. Zero Trust Access is free for the first 50 seats.

## What's intentionally NOT included

Per spec: no word cloud, no PowerPoint/PDF import, no video questions, no LMS integration, no public quiz search. The architecture supports adding any of these later.

## License

MIT
