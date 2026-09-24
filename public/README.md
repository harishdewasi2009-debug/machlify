# Matchify

A real, working dating-app web project: Node/Express + **PostgreSQL** backend,
Socket.io for live call signaling, and a frontend served from the same
server. Accounts, swipes, matches, messages, and call history are all
persisted in a real database — nothing resets when the server restarts.

```
matchify/
├── server/
│   ├── index.js        # entry point — Express + HTTP + Socket.io, also serves the frontend
│   ├── db.js            # PostgreSQL schema + connection pool
│   ├── socket.js          # WebRTC call signaling (invite/accept/reject/ICE relay)
│   ├── config.js              # centralized constants (MAX_PROFILE_PHOTOS, DEMO_MODE, age bounds, plans)
│   ├── seed.js              # adds 30 fictional demo profiles (is_demo = true)
│   ├── routes/                # auth, users, swipes, matches, safety (block/report), notifications, verification, ai
│   ├── middleware/auth.js
│   └── .env.example
└── public/
    ├── index.html
    ├── css/style.css
    ├── manifest.json + service-worker.js + icon-*.png   # PWA "install/download" support
    └── js/
        ├── app.js
        └── countries.js   # static list used for the country dropdown
```

## 1. What's real vs. mocked right now

| Feature | Status |
|---|---|
| Accounts, swipes, matches, chat, call history | **Real** — stored in Postgres |
| Sign up / log in with email + password | **Real** — bcrypt-hashed passwords, JWT sessions, 18+ age enforced at signup |
| Guest / demo mode | **Real, toggleable** — `DEMO_MODE=true` (default) shows a "Continue as guest" option and 30 seeded fictional demo profiles; set `DEMO_MODE=false` to require real accounts and hide demo profiles entirely |
| Block, report, unmatch | **Real** — `server/routes/safety.js`; blocking removes any match and hides both users from each other's Discover feed |
| Voice & video calling | **Real** — WebRTC peer-to-peer, signaled via Socket.io |
| Notifications (new match / unread message / missed call) | **Real**, computed from existing data — see section 11 |
| Country picker | **Real** — static list of ~190 countries |
| Profile photos | **Real** — up to `MAX_PROFILE_PHOTOS` (9, `server/config.js`) image URLs per profile, with basic URL/size validation |
| "Continue with Google" | **Mocked** — see section 6 below |
| Free/Day Pass/Plus/Pro subscription checkout | **Mocked** — no payment gateway wired up yet, see section 8 |
| Cookie consent banner | **Real** — stores the choice in `localStorage` |
| "Download app" (desktop) | **Real** PWA install prompt, via `manifest.json` + service worker |
| AI bio generator, icebreakers, compatibility score, translation | **Real logic, mock-or-real AI** — works with built-in fallback templates by default; add `ANTHROPIC_API_KEY` for real AI output (see section 9) |
| Rate limiting, security headers | **Real** — `express-rate-limit` + `helmet` in `server/index.js` |

## 2. Requirements

- Node.js 18+
- A PostgreSQL database (local Postgres for dev, or Render's managed Postgres for production)

## 3. Local setup

```bash
cd server
npm install
cp .env.example .env
```

Edit `.env`:

```
PORT=4000
JWT_SECRET=paste-a-long-random-string-here
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/matchify
```

Generate a strong `JWT_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Create the database once (if it doesn't exist yet):
```bash
createdb matchify
```

The app creates its own tables automatically on first boot — no separate migration step.

## 4. Seed demo profiles

```bash
npm run seed
```

Adds 30 fictional demo profiles across ~25 countries (password `password123`
for all, `demo1@matchify.app` … `demo30@matchify.app`). Every seeded row is
marked `is_demo = true` in the database and shows a "DEMO PROFILE" badge in
the UI. Photos are generated placeholder avatars (DiceBear), never real
people's photos. Skipped automatically if any `is_demo = true` rows already
exist — delete those rows first to reseed.

## 5. Run it

```bash
npm start
```

Open **http://localhost:4000** (or `5050`/whatever `PORT` you set) — API,
frontend, and the call-signaling socket are all served from the same origin.

## 6. Sign-in: real accounts + optional demo mode

There are now two ways in, controlled by the `DEMO_MODE` env var
(`server/config.js`):

- **`DEMO_MODE=true` (default):** the auth screen still shows real
  "Log in" / "Sign up" tabs, plus a "Continue as guest (demo mode)" button.
  Guests get a single shared demo "You" account (`POST /api/auth/demo`),
  same as before — useful for a quick, frictionless look at the product.
- **`DEMO_MODE=false`:** the guest button is hidden, `POST /api/auth/demo`
  returns `403`, and seeded demo profiles (`is_demo = true`) are filtered out
  of Discover. Everyone must sign up (`POST /api/auth/signup`) or log in
  (`POST /api/auth/login`) with a real email + password. Signup enforces a
  minimum age of 18 (`MIN_AGE` in `server/config.js`) — this is a
  self-reported age field, not verified ID, so treat it as a first layer
  only; see section 6b below for the real verification gate.

Passwords are hashed with bcrypt; sessions are the same JWT machinery as
before.

## 6b. Real age/identity verification (the actual adults-only gate)

Self-reported age at signup is **not** treated as sufficient on its own —
it's just a form validation. The real gate is a separate verification step,
controlled by `REQUIRE_AGE_VERIFICATION` (`server/config.js`, default `true`):

- While a user's `verification_status` is `unverified`, `pending`, or
  `rejected`, the `requireVerified` middleware (`server/middleware/auth.js`)
  blocks `GET /api/users/discover`, `POST /api/swipes`, and every
  `/api/matches` route that reads/sends messages or logs calls — so nobody
  can be matched with or contacted by anyone until they're verified. Editing
  your own profile, and unmatching, still work while unverified.
- The frontend shows a dedicated verification-gate screen after login/signup
  (before the main app) whenever verification isn't complete yet, and polls
  `GET /api/verification/status` while it's `pending`.
- **This does not do its own ID checking** — that requires a licensed
  identity-verification provider (Persona, Onfido, Veriff, Stripe Identity,
  Jumio, etc.) that can check a government ID plus a liveness/selfie match
  and confirm real age. Rolling that yourself is both a compliance and a
  safety liability, so `server/routes/verification.js` is built as the
  *integration seam*, not a working checker:
  - `POST /api/verification/start` is where you'd call the provider's API to
    create a hosted verification session and return their redirect URL —
    right now it returns `501` with an explanatory error if
    `VERIFICATION_PROVIDER` is set (no SDK wired up yet), or marks the user
    `pending` with a note if no provider is configured at all.
  - `POST /api/verification/webhook` is where the provider calls back with
    the real result (server-to-server, signature-checked against
    `VERIFICATION_WEBHOOK_SECRET`). It also double-checks any "verified"
    result against `MIN_AGE` before trusting it.
  - `POST /api/verification/dev-simulate` lets you exercise the
    verified/rejected states locally without a real provider account — it's
    compiled out entirely when `NODE_ENV=production`, so it can't be used to
    fake a verification in a real deployment. The frontend only shows the
    "simulate" buttons when `verificationProviderConfigured` is false.
- Demo accounts (`is_demo = true`, including the shared guest "You" account)
  bypass verification — they're a fictional persona, not a real end user.

**To go live with real verification:** pick a provider, set
`VERIFICATION_PROVIDER` and `VERIFICATION_WEBHOOK_SECRET` in `.env`, and
replace the `TODO` in `POST /start` with that provider's SDK call. Nothing
else in the app needs to change — `requireVerified` and the frontend gate
already key off `verification_status` however it gets set.

## 7. Safety: block, report, unmatch

`server/routes/safety.js` adds:

- `POST /api/safety/block/:id` — blocks a user and immediately deletes any
  existing match with them (both directions). Blocked users are excluded
  from each other's Discover feed and can't swipe/match/message each other
  again unless unblocked.
- `DELETE /api/safety/block/:id` — unblock.
- `GET /api/safety/blocked` — list who you've blocked.
- `POST /api/safety/report` — files a report (`reason` + optional free-text
  `details`, optionally tied to a `matchId`/`messageId`) into the `reports`
  table for later moderation review. Reasons include
  `underage_suspected` for flagging a profile you believe belongs to a minor.

All three actions are reachable from the "⋯" menu in the chat header in the
UI, plus a report reason picker modal.

## 8. Making the subscription real (Razorpay)

`POST /api/users/subscribe` currently just flips `premium`/`plan`/`billing_cycle`/`autopay`
in the database with no payment — that's the "mock for now" part. Pricing
(`server/config.js` → `PRICING`):

| Plan | Price | What it unlocks |
|---|---|---|
| `free` | ₹0 | Basic matching, limited daily swipes, no calls |
| `day_pass` | ₹50 one-time (24h) | Unlimited swipes + unlimited chat/calls for 24 hours, no subscription |
| `plus` | ₹99/month or ₹999/year | Unlimited swipes + voice/video calls, no ads |
| `pro` | ₹499/month or ₹4999/year (**yearly is autopay**) | Everything in Plus + the AI chat assistant (icebreakers, reply suggestions, translation — gated in `server/routes/ai.js` by `plan === 'pro'`) |

`day_pass` sets `plan_expires_at` to +24h and `billing_cycle = 'one_time'`.
`plus`/`pro` require a `billingCycle` of `monthly` or `monthly`/`yearly` in
the request body and set `plan_expires_at` to +30/+365 days respectively;
`autopay` is only set `true` for Pro yearly, matching the pricing plan. To
wire up real payments:

1. Create a Razorpay order server-side for the selected plan/cycle's amount.
2. On the frontend, open Razorpay Checkout with that order.
3. On successful payment, verify the payment signature server-side, **then**
   call the same subscribe logic to activate the plan. For Pro yearly,
   also set up a Razorpay subscription (not a one-off order) so the autopay
   renewal is real, not just the `autopay` flag in the database.

## 9. How calling works

- Voice/video calls use **WebRTC** directly between the two browsers (peer-to-peer audio/video).
- **Socket.io** is only used to pass along the small bits of signaling data (who's calling whom, the connection offer/answer, network candidates) — no audio/video ever passes through the server.
- STUN is set to Google's public server (`stun:stun.l.google.com:19302`), which works for most networks. If calls fail to connect on some cellular/corporate networks, add a TURN server (e.g. Twilio Network Traversal, Xirsys, or your own `coturn`) — see `ICE_SERVERS` in `public/js/app.js`.
- Every finished/declined call is logged to the database and shown as a message in the chat thread.
- Calling is currently available to everyone with a match, not gated to Plus/Pro — gate it in `chatCallAudioBtn`/`chatCallVideoBtn` handlers in `public/js/app.js` plus a server-side check in `socket.js` if you want calls themselves to be paywalled.

## 10. AI features (Phase 1 of the Matchlify roadmap)

Four AI features are wired in under `/api/ai`:

| Feature | Route | Access |
|---|---|---|
| AI bio generator | `POST /api/ai/bio` | Everyone |
| AI icebreakers (shown when a chat has no messages yet) | `POST /api/ai/icebreakers` | Everyone |
| AI compatibility score (shown as a badge in the chat header) | `GET /api/ai/compatibility/:matchId` | Everyone gets score + one-line reason; **Plus/Pro/Ultra** additionally get a per-category breakdown and a richer AI explanation |
| Message translation (a "Translate" link under incoming messages) | `POST /api/ai/translate` | **Plus/Pro/Ultra only** (returns HTTP 402 for Free users) |

All four call the Anthropic API (`server/lib/ai.js`) when `ANTHROPIC_API_KEY`
is set in `.env`. **Without a key, every route still works** — it falls back
to fast deterministic templates (see the `source: 'template'` field in each
response), so the app is fully demoable out of the box and lights up with
real AI the moment you add a key.

To enable real AI on Render: add `ANTHROPIC_API_KEY` (and optionally
`ANTHROPIC_MODEL`, defaults to `claude-sonnet-4-6`) as environment variables
on your Render service — no code changes needed.

Deploying to Render

**A. Create the database first**
1. In the Render dashboard: **New → PostgreSQL**. Pick a name/region and create it.
2. Once it's up, copy the **Internal Database URL** (starts with `postgresql://`) — you'll use it as `DATABASE_URL` below.

**B. Create the web service**
1. Push this whole project (`server/` and `public/`, same relative layout) to a GitHub repo.
2. In Render: **New → Web Service** → connect that repo.
3. **Root Directory**: `server`
4. **Build Command**: `npm install`
5. **Start Command**: `npm start`
6. Under **Environment**, add:
   - `JWT_SECRET` — a long random string (never reuse the example value)
   - `DATABASE_URL` — the Internal Database URL you copied in step A
   - `PORT` — Render sets this automatically; you don't need to set it
7. Deploy. On first boot the server creates all tables automatically.
8. (Optional) Run `npm run seed` once via Render's **Shell** tab to add demo profiles.

**Notes:**
- Because Postgres is a proper managed database (not a file), your data survives redeploys and restarts — this is what makes chat history, matches, and calls "fully stored."
- Everything (API, frontend, WebSocket signaling) is served from one Render service and one origin, so there's no CORS setup needed.
- If you later split the frontend onto a separate domain, set the `API` constant at the top of `public/js/app.js` and make sure Socket.io's client connects to that same URL explicitly (`window.io('https://your-api-domain')`).

## 11. Notifications

`GET /api/notifications` (`server/routes/notifications.js`) returns a merged,
sorted feed of new matches, unread messages, and missed calls — derived from
existing tables, no separate notifications table to keep in sync. The shape
of each item (`type`, `text`, `matchId`, `createdAt`) is what a real push
service (FCM/APNs/web push) would consume; wiring one up means calling out
to it at the same points this route reads from (new match created, new
message inserted, call logged as missed) instead of polling. The UI polls
this endpoint every 15s and shows a badge + dropdown from the sidebar bell.

## 12. Notes / things to know before treating this as production

- **Age verification is self-reported.** Signup collects a numeric age and
  enforces 18+ (`MIN_AGE` in `server/config.js`), but nothing verifies it
  against real identity. Treat this as a first filter, not a guarantee — a
  production deployment should add real ID/age verification (a third-party
  KYC provider, government ID check, etc.) before removing that caveat.
- Photos are entered as image URLs (no file upload pipeline) — wire up
  `multer` (already in `package.json`) + storage (S3, etc.) for real photo
  uploads. `MAX_PROFILE_PHOTOS` (currently 9) is centralized in
  `server/config.js` — change it there, not in multiple places.
- Chat updates via polling (every 3s); calling uses real-time Socket.io. If
  you want the chat list itself to be fully real-time too, extend
  `socket.js` to also broadcast new messages.
- Basic rate limiting (`express-rate-limit`) and security headers (`helmet`)
  are in place; there's still no email verification or password reset flow.
- Reports filed via `/api/safety/report` land in the `reports` table with no
  admin UI yet to review them — that's the next piece to build if you need
  active moderation rather than just data collection.
- Distance/location matching isn't implemented — `lat`/`lng` columns exist
  but discovery doesn't use them; the country/city fields are for display
  only.
- See sections 6 and 8 above for turning the two mocked pieces (Google
  sign-in, payments) into real integrations.


## Added Random Talk + AI Talk
- Random Talk can match verified 18+ users worldwide or by selected country and gender preference.
- Discover supports country and gender filters.
- Pro includes an AI Talk companion with multiple conversation personas.
- Pricing: ₹50 day pass, ₹99/month or ₹999/year Plus, ₹499/month or ₹4,999/year Pro.
- Subscription endpoint remains a mock until a payment provider is connected.
