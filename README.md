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
│   ├── seed.js              # optional: adds 6 demo profiles
│   ├── routes/                # auth, users, swipes, matches
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
| Voice & video calling | **Real** — WebRTC peer-to-peer, signaled via Socket.io |
| Country picker | **Real** — static list of ~190 countries |
| "Continue with Google" | **Mocked** — see section 6 below |
| Free/₹49/₹99/₹199 subscription checkout | **Mocked** — no payment gateway wired up yet, see section 7 |
| Cookie consent banner | **Real** — stores the choice in `localStorage` |
| "Download app" (desktop) | **Real** PWA install prompt, via `manifest.json` + service worker |
| AI bio generator, icebreakers, compatibility score, translation | **Real logic, mock-or-real AI** — works with built-in fallback templates by default; add `ANTHROPIC_API_KEY` for real AI output (see section 9) |

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

## 4. (Optional) seed demo profiles

```bash
npm run seed
```

Adds 6 demo accounts (password `password123` for all — `demo1@matchify.app` … `demo6@matchify.app`). Skipped automatically if the `users` table already has rows.

## 5. Run it

```bash
npm start
```

Open **http://localhost:4000** — API, frontend, and the call-signaling
socket are all served from the same origin.

## 6. About sign-in

There is no login/signup flow. On first load the frontend calls
`POST /api/auth/demo` (`routes/auth.js`), which gets-or-creates a single
shared "You" account and hands back a JWT — the same auth/JWT machinery
used everywhere else, just without a form in front of it. Every visitor
shares that one account.

## 7. Making the subscription real (Razorpay)

`POST /api/users/subscribe` currently just flips `premium`/`plan` in the
database with no payment — that's the "mock for now" part. There are four
tiers, all billed monthly: `free` (₹0), `plus` (₹49), `pro` (₹99, the
recommended plan), and `ultra` (₹199). The accepted values are enforced by
the `PLANS` array in `server/routes/users.js`. To wire up real payments
(matches the flow you're already using in TradeMind AI):

1. Create a Razorpay order server-side for the selected plan's monthly
   amount (₹49 / ₹99 / ₹199).
2. On the frontend, open Razorpay Checkout with that order.
3. On successful payment, verify the payment signature server-side, **then**
   call the same subscribe logic to activate the plan.

## 8. How calling works

- Voice/video calls use **WebRTC** directly between the two browsers (peer-to-peer audio/video).
- **Socket.io** is only used to pass along the small bits of signaling data (who's calling whom, the connection offer/answer, network candidates) — no audio/video ever passes through the server.
- STUN is set to Google's public server (`stun:stun.l.google.com:19302`), which works for most networks. If calls fail to connect on some cellular/corporate networks, add a TURN server (e.g. Twilio Network Traversal, Xirsys, or your own `coturn`) — see `ICE_SERVERS` in `public/js/app.js`.
- Every finished/declined call is logged to the database and shown as a message in the chat thread.

## 9. AI features (Phase 1 of the Matchlify roadmap)

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

## 10. Notes / things to know before treating this as production

- Photos are entered as image URLs (no file upload pipeline) — wire up `multer` (already in `package.json`) + storage (S3, etc.) for real photo uploads.
- Chat updates via polling (every 3s); calling uses real-time Socket.io. If you want the chat list itself to be fully real-time too, extend `socket.js` to also broadcast new messages.
- There's no rate limiting, email verification, or password reset flow yet.
- Distance/location matching isn't implemented — `lat`/`lng` columns exist but discovery doesn't use them; the country/city fields are for display only.
- See sections 6 and 7 above for turning the two mocked pieces (Google sign-in, payments) into real integrations.
