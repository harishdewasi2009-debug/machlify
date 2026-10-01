# Random Chat

"Meet real Matchify members randomly." Spontaneous 1:1 text chat between two
real, eligible members. A dating **match** only exists after both people tap
Like (same `Swipe` → `Match` → `Conversation` pipeline as Discovery).

## Set up

```bash
cd backend
npm install
npx prisma migrate dev --name random_chat   # creates the new tables / columns
npm run dev
```

New env vars (all optional, defaults in `src/config/env.ts`):

| Var | Default | Meaning |
|---|---|---|
| `RC_QUEUE_FRESH_SECONDS` | 25 | A waiting user must have heart-beaten this recently to be matched |
| `RC_QUEUE_STALE_SECONDS` | 45 | Waiting rows with no heartbeat are deleted |
| `RC_WAIT_TIMEOUT_SECONDS` | 90 | Then the user is told nobody is available |
| `RC_SESSION_STALE_SECONDS` | 60 | Silent **and** socket-offline participant ends a session |
| `RC_REMATCH_COOLDOWN_MINUTES` | 60 | Same pair can't be re-paired inside this window |
| `RC_MAX_SESSIONS_PER_HOUR` | 40 | Per-user session cap |
| `RC_MSG_BURST` / `RC_MSG_WINDOW_SECONDS` | 6 / 8 | Message rate limit |
| `RC_MAX_MESSAGE_LENGTH` | 1000 | |
| `RC_MESSAGE_RETENTION_DAYS` | 30 | Messages of ended sessions are purged after this |
| `RC_AUTO_BAN_REPORTERS` / `RC_AUTO_BAN_HOURS` | 3 / 24 | N distinct reporters in 24h ⇒ automatic temp ban (still queued for human review) |
| `RC_ADMIN_CAN_VIEW_REPORTED_MESSAGES` | false | Lets ADMIN role read the chat of a *reported* session (audit-logged). Leave off unless your privacy policy and local law allow it |
| `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY` | unset | Enables a CAPTCHA step for accounts with open abuse alerts |

## Who can use it

Same gate as Discovery plus: age ≥ `MIN_AGE_YEARS` (computed from DOB), identity
verified (when `REQUIRE_IDENTITY_VERIFICATION`), ≥ 1 approved photo, profile
visibility `PUBLIC` or `RANDOM_CHAT`, and not Random-Chat-banned.

## Matching

`services/randomChat/matchmaking.service.ts → tryMatch`. One Postgres
transaction: lock own queue row `FOR UPDATE`, rank candidates, then lock the
chosen candidate `FOR UPDATE SKIP LOCKED` and re-check `WAITING`. A row can only
flip to `CHATTING` inside the transaction holding its lock, so two users can
never receive the same person and nobody deadlocks. Lost races are retried by
the sweeper every 5 s.

* **Hard filters:** age range (both ways), gender preference (both ways),
  same-region (only if requested), blocks (both ways), active/recent session with
  the same person, bans, account status.
* **Soft ranking (never excludes):** shared language, shared interests, wait time.
* If nobody fits, the user waits, then gets: *"Not enough people are available
  right now."* No fake users exist anywhere in the system.

## Privacy

* `card.ts → buildProfile` is the only place that decides what a stranger sees.
  It returns **no user id, email, phone, coordinates**, and honours the user's
  `showAge / showBio / showInterests / showLocation` switches.
* "Location" shown is a free-text label the user typed (`locationLabel`), never
  derived from stored coordinates.
* Compatibility % uses only fields the other person chose to show.
* Partners are addressed by **session id** (`/session/:id/like|block|report|profile`),
  so the client never learns the other person's internal id. This replaces the
  `/api/users/:id/...` routes from the brief, which would have required exposing ids.
* A one-sided like is never revealed; the other side only hears about it as a match.
* Messages: links, emails, phone numbers, contact-app handles and OTP/password
  phrases are rejected server-side (`utils/randomChatFilter.ts`).

## API

All under `/api/random-chat`, cookie-authenticated.

```
GET   /config                       PATCH /settings        GET /settings
GET   /status                       POST  /join            POST /leave
POST  /next                         POST  /heartbeat
GET   /session/:id                  POST  /session/:id/end
GET   /session/:id/messages         POST  /session/:id/messages   (REST fallback, idempotent via clientId)
GET   /session/:id/profile          POST  /session/:id/like
POST  /session/:id/block            POST  /session/:id/report     {reason, description?}
```

Admin (`/api/admin/random-chat/...`): `stats`, `sessions`, `sessions/:id/end`,
`alerts`, `alerts/:id/resolve`, `reports`, `bans`, `users/:id/review`,
`users/:id/ban|unban` (ADMIN only), `reports/:id/messages` (ADMIN only, flag-gated).

Socket events (client → server, all with acks): `random_chat:join|leave|next|end|
resume|heartbeat|message|typing|read|block|report`.
Server → client: `random_chat:waiting|matched|message|typing|read|presence|match|ended|timeout`.

## Lifecycle & cleanup (`workers.ts`)

Every 5 s, under a Postgres advisory lock (so only one instance sweeps):
drop stale queue rows → time out long waits → end sessions whose participant is
silent **and** has no live socket → retry matching. Hourly: purge old messages,
expired bans, stale presence. Logout and admin suspension also clean the user up.

## Scaling notes (not done here)

* Single instance works as-is. For several instances add the Socket.IO Redis
  adapter, move the in-process rate limiters (`SlidingWindowLimiter`) to Redis,
  and replace `isUserOnline` with the shared presence set. Matching itself is
  already multi-instance safe because it relies on database locks.
* Redis is *not* required for correctness; it's a throughput optimisation.

## Not included (by design)

Voice, video and photo sharing are not part of this feature. The session model
leaves room for them but each needs its own consent + safety design.
