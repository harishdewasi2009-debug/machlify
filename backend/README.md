# Matchify backend — Auth + Database (chunk 1 of the full build)

This is a real, runnable Express + TypeScript + Prisma/PostgreSQL backend implementing
**registration, login, Google OAuth, session/token refresh, email verification, and
password reset** — no mocked responses, no fake success states.

Nothing here was run inside the sandbox that produced it (no network/DB access there);
this is source you run in your own environment.

## What's implemented in this chunk

- Full Prisma schema for the whole app (auth tables fully used now; profile/photo/
  discovery/chat/payment/admin tables are defined so later chunks attach cleanly).
- Registration with server-side age calculation from DOB (never trusts a client-sent age).
- Password hashing with bcrypt, minimum strength check.
- Login with account lockout after repeated failures.
- Google OAuth — verifies the ID token's signature with Google directly; never trusts
  a plain email string from the frontend.
- Access tokens (short-lived JWT) + refresh tokens (opaque, hashed at rest, rotated on
  every use) stored as revocable `Session`/`RefreshToken` rows — logout and
  logout-all-devices actually work.
- Email verification and password reset via real SMTP (nodemailer). If SMTP isn't
  configured, endpoints return a real `503 CONFIGURATION_MISSING` — they never pretend
  an email was sent.
- Rate limiting on login/register/password-reset.
- Consistent error shape, no stack traces or DB errors leaked to clients.

## Setup

```bash
cd matchify-backend
npm install
cp .env.example .env
# fill in DATABASE_URL and generate real random values for JWT_ACCESS_SECRET /
# JWT_REFRESH_SECRET, e.g.:
openssl rand -hex 32

npx prisma migrate dev --name init
npm run dev
```

Server starts on `http://localhost:4000`. Health check: `GET /health`.

## Configuring external services (leave unconfigured in dev if you don't have them yet)

| Service | Env vars | Where to get it | What breaks without it |
|---|---|---|---|
| PostgreSQL | `DATABASE_URL` | Any Postgres instance (local, Supabase, RDS, Neon) | Nothing runs at all |
| SMTP / transactional email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | e.g. Postmark, SendGrid, AWS SES, or your own SMTP | `/register` and `/password/forgot` return `503 CONFIGURATION_MISSING` instead of sending mail |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) | `/google` returns `503 CONFIGURATION_MISSING` |

## Endpoints

```
POST /api/auth/register            { name, email, password, dateOfBirth, gender }
POST /api/auth/verify-email        { token }
POST /api/auth/login               { email, password }
POST /api/auth/google              { idToken }
POST /api/auth/refresh             (reads refreshToken cookie)
POST /api/auth/logout              (auth required)
POST /api/auth/logout-all          (auth required)
POST /api/auth/password/forgot     { email }
POST /api/auth/password/reset      { token, newPassword }
POST /api/auth/password/change     { currentPassword, newPassword }  (auth required)
GET  /api/auth/me                  (auth required)
```

Tokens are set as httpOnly cookies (`accessToken`, `refreshToken`) — the frontend never
handles raw tokens in JS, which rules out token theft via XSS.

## Manual test pass (run these yourself once SMTP + DB are configured)

1. `POST /register` with a DOB that makes the user under 18 → expect `403 UNDER_MINIMUM_AGE`.
2. `POST /register` with a valid adult DOB → expect `201`, a verification email arrives.
3. `POST /login` before verifying email → currently allowed (email verification gates
   *discoverability*, not login, per the flow doc — adjust in `auth.service.ts` if you
   want login itself gated on verification).
4. `POST /login` with wrong password 5 times → 6th attempt returns `423 ACCOUNT_LOCKED`.
5. `POST /password/forgot` for a non-existent email → same response as for a real one
   (no enumeration).
6. `POST /refresh` reusing an already-rotated refresh token → `401` (replay detected).
7. `POST /logout-all` then try the old access token → `401`.

## Chunk 2 — Photo upload + storage pipeline

Real multipart upload → validate → moderate → store → record, with no step faked or
skipped:

1. **Upload**: `multer` (memory storage, no local disk dependency) accepts one file per
   request, capped at `MAX_PHOTO_SIZE_MB`.
2. **Content validation**: the file's actual magic bytes are checked (not the declared
   `Content-Type` or filename extension, both spoofable), then `sharp` actually decodes
   it — a corrupt or booby-trapped file fails here, not later.
3. **EXIF/GPS stripping + re-encoding**: every variant is re-encoded through libvips
   without carrying metadata forward, which also neutralizes most malformed-image
   exploits that ride on the original byte stream.
4. **Variants**: `original` (capped 2400px), `large` (1600px), `medium` (800px),
   `thumbnail` (300px) are all generated and uploaded.
5. **Moderation**: every photo is sent to Sightengine (nudity/offensive/gore models)
   before it can be marked `APPROVED`. If the moderation provider isn't configured, the
   upload fails with `503 CONFIGURATION_MISSING` — it is never auto-approved.
6. **Duplicate detection**: a content hash of the processed image is stored. The exact
   same image re-uploaded by the same user is rejected outright; the same image already
   approved under a *different* account routes the new upload to `MANUAL_REVIEW`
   (possible stolen/reused photo) even if moderation itself passed.
7. **Storage**: uploaded to S3 or an S3-compatible bucket (Cloudflare R2 works via
   `S3_ENDPOINT`) at `users/{userId}/photos/{photoId}/{variant}`. Private by default —
   URLs returned to the client are short-lived signed URLs unless you set
   `S3_PUBLIC_BASE_URL` for a public bucket/CDN.
8. **Object-level authorization**: reorder/set-primary/delete all check the photo's
   `userId` against the authenticated session — a caller can't act on another user's
   photo by guessing its id.

### New endpoints

```
POST   /api/photos              multipart/form-data, field "file"   (auth required)
GET    /api/photos                                                   (auth required)
PATCH  /api/photos/reorder      { order: [photoId, photoId, ...] }   (auth required)
PATCH  /api/photos/:id/primary                                       (auth required)
DELETE /api/photos/:id                                                (auth required)
```

### Configuration required for this chunk

| Service | Env vars | Where to get it | What breaks without it |
|---|---|---|---|
| S3 or R2 storage | `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, optionally `S3_ENDPOINT` | AWS S3 console, or Cloudflare R2 dashboard | Upload returns `503 CONFIGURATION_MISSING` before even calling moderation |
| Sightengine moderation | `MODERATION_API_USER`, `MODERATION_API_SECRET` | [sightengine.com](https://sightengine.com) (free tier available) | Upload returns `503 CONFIGURATION_MISSING` |

### Manual test pass

1. Upload a non-image file renamed to `.jpg` → `400 VALIDATION_ERROR` (magic-byte check
   fails).
2. Upload a real JPEG under 200x200px → `400` (too small).
3. Upload a valid photo with S3 vars unset → `503 CONFIGURATION_MISSING`.
4. Upload the same valid photo twice → second call `400` ("already uploaded").
5. Upload a real photo end-to-end with S3 + Sightengine configured → `201`, `GET
   /api/photos` shows it with working thumbnail/medium/large URLs.
6. Try `DELETE /api/photos/:id` with someone else's photo id while authenticated as a
   different user → `404` (ownership check, not a 403 that would confirm the id exists).

## What's intentionally NOT in chunk 2

Profile editing (beyond photos), discovery, matching, chat, calling, payments, identity
verification, and the admin panel are schema-ready but not yet implemented at this
point — see chunk 3 below and the final "what's left" list at the end of this file.

## Chunk 3 — Profile, location, preferences, discovery

Real profile editing plus a working discovery feed with server-side distance and mutual
preference filtering.

### New endpoints

```
GET    /api/profile                                                          (auth required)
PATCH  /api/profile               { displayName?, bio?, education?, occupation?,
                                     languages?, relationshipIntent? }        (auth required)
PATCH  /api/profile/location      { latitude, longitude }                    (auth required)
PATCH  /api/profile/preferences   { minAge, maxAge, maxDistanceKm, genders } (auth required)
PATCH  /api/profile/interests     { interests: string[] }                    (auth required)
GET    /api/discovery?cursor=&limit=                                         (auth required)
```

### How discoverability is decided

`Profile.isDiscoverable` is recomputed (not set directly by any endpoint) whenever a
user's profile, location, or photos change. It becomes `true` only once all of the
following are real: a display name, a stored location, and at least one
moderation-`APPROVED` photo. Nothing can appear in discovery half set up. (The
identity-verification chunk will add a further gate here.)

### How the discovery feed actually filters

- Excludes yourself, anyone you've blocked or been blocked by, and anyone you've
  already swiped on.
- Age and gender filtering is **mutual**: a candidate only appears if your preferences
  match them *and* their preferences match you — a one-sided filter would surface
  people who've explicitly said they don't want to see people like you. This means a
  user must set `PATCH /api/profile/preferences` (with at least one gender) before they
  can appear to anyone else, not just before they can browse themselves.
- Distance is computed server-side with the haversine formula from stored coordinates;
  only a rounded distance in km is ever returned, never raw latitude/longitude.
- Pagination is a plain numeric offset cursor for now. At real scale, replace the
  in-memory bounding-box-then-haversine approach with a PostGIS geography column and a
  GiST index — this implementation fetches up to 300 candidates per bounding box and
  sorts in application code, which is fine for an early-stage user base but won't scale
  to a large, dense city.

### Manual test pass

1. `GET /api/discovery` before setting location/preferences → `400 VALIDATION_ERROR`.
2. Set preferences with an empty `genders` array → next `GET /api/discovery` still
   `400` (explicit, not silently "show everyone").
3. Two test users, mutually within each other's age/gender/distance preferences, both
   with an approved photo and location set → each appears in the other's feed.
4. One of them blocks the other → blocked user disappears from discovery for both
   directions.
5. `PATCH /api/profile/location` with `latitude: 200` → `400` (out of range).

## Chunk 4 — Swipe/match + real-time chat (Socket.io)

No new external provider is required for this chunk — nothing to add to `.env`.

### Swiping & matching

```
POST   /api/swipes              { targetUserId, liked }              (auth required)
GET    /api/matches                                                   (auth required)
DELETE /api/matches/:id                                                (auth required)
```

- A swipe on yourself, a nonexistent/inactive user, or a user you've blocked (or who
  blocked you) all return the same `404` — probing swipe responses can't be used to
  detect a block.
- Re-swiping the same target returns `409 ALREADY_SWIPED` (unique DB constraint backs
  this, not just an application check).
- A mutual like creates the `Match` **and** its `Conversation` + both
  `ConversationMember` rows in one transaction, so a match can never exist without a
  usable conversation. `userAId`/`userBId` are sorted into a canonical order before the
  uniqueness check, so it doesn't matter who liked back second.
- Both users get a `MATCH` notification (persisted row + live socket push if online).
- `DELETE /api/matches/:id` sets the match to `UNMATCHED` (ownership-checked — `404` if
  it's not your match) rather than deleting rows, preserving history for
  safety/moderation.

### Block / report

```
GET    /api/blocks                                                    (auth required)
POST   /api/blocks              { userId }                            (auth required)
DELETE /api/blocks/:userId                                             (auth required)
POST   /api/reports             { reportedId, reason, targetType, targetId? }  (auth required)
```

Blocking someone also flips any `ACTIVE` match between the two of you to `BLOCKED`,
which immediately cuts off `POST /api/conversations/:id/messages` and the
`message:send` socket event for that conversation (`chat.service` re-checks block state
on every send as a second line of defense, not just at block time).

### Real-time chat

```
GET    /api/conversations                                             (auth required)
GET    /api/conversations/:id/messages?cursor=                        (auth required)
POST   /api/conversations/:id/messages   { content, type? }            (auth required, REST fallback)
PATCH  /api/conversations/:id/read                                     (auth required)
```

Socket.io connects to the same port as the REST API. Auth reuses the exact same
accessToken-cookie + session-revocation check as `requireAuth` — a socket connection
from a logged-out session is rejected the same way a REST call would be. On connect, a
socket auto-joins a room per conversation it's actually a member of (checked
server-side against `ConversationMember`, never trusted from the client).

Events:

```
message:send   { conversationId, content, type? }  -> ack { success, data: message } | { success: false, error }
message:new                                         <- broadcast to the conversation room
message:read   { conversationId }                  -> marks all of the other person's messages read
message:read                                        <- broadcast { conversationId, readByUserId }
typing:start / typing:stop   { conversationId }     <- broadcast to the other member only
presence:online / presence:offline   { userId }     <- broadcast on first/last socket for a user
notification:new                                    <- pushed to a user's own room (matches, messages, etc.)
```

The REST `POST /api/conversations/:id/messages` fallback exists for clients without an
open socket (e.g. opening straight to a conversation from a push notification) and goes
through the exact same `chat.service.sendMessage` the socket handler calls, then
broadcasts the result to the room — the two paths can't diverge in behavior.

Presence and Socket.io rooms in this chunk are in-memory on a single Node process. At
real scale running multiple backend instances, replace this with the Socket.io Redis
adapter plus a shared presence set — a single instance's in-memory `Map` can't see
sockets connected to a different instance.

### Manual test pass

1. Two users, no swipes yet: `GET /api/matches` is `[]` for both.
2. A likes B → `POST /api/swipes` returns `{ liked: true, matched: false }`.
3. B likes A back → B's response is `{ liked: true, matched: true, matchId, conversationId }`;
   both users' `GET /api/matches` now shows the match.
4. A swipes on B again → `409 ALREADY_SWIPED`.
5. Connect both users' sockets, send `message:send` from A → B receives `message:new`
   in real time; `GET /api/conversations/:id/messages` for either user shows it.
6. B blocks A → A's next `message:send` in that conversation gets `success: false` in
   its ack; `GET /api/matches` for B no longer lists A (status is no longer `ACTIVE`).
7. C reports A with `targetType: "USER"` → `201`, `reportId` returned; row lands in
   `Report` with `status: "OPEN"` for later admin review (chunk 6).

## Chunk 5 — Identity verification (Stripe Identity)

Real government-ID + selfie verification via Stripe Identity, with the webhook as the
only thing that can ever mark someone `VERIFIED` — never the frontend, never the
`return_url` redirect.

### New endpoints

```
POST /api/verification/start                                          (auth required)
GET  /api/verification/status                                         (auth required)
POST /api/verification/webhook       (Stripe calls this — not session-authenticated)
```

### How it works

1. `POST /api/verification/start` creates a real Stripe Identity `VerificationSession`
   (`document` type, selfie-matching required) and stores a local `VerificationSession`
   row as `PENDING`. If one's already `PENDING`/`PROCESSING`, the existing session is
   returned instead of creating a duplicate.
2. The frontend redirects the user to `verificationUrl` (or uses `clientSecret` with
   Stripe.js, if you prefer the embedded flow over the hosted one).
3. Stripe posts `identity.verification_session.*` events to
   `POST /api/verification/webhook`. This route is mounted with `express.raw()` **ahead
   of** the global JSON body parser in `app.ts`, because Stripe's signature is computed
   over the exact raw bytes — parsing and re-serializing the body first would break
   verification.
4. The signature is verified manually (`utils/stripeSignature.ts`, HMAC-SHA256 per
   Stripe's documented scheme — no Stripe SDK dependency, same raw-fetch style as the
   Sightengine moderation integration) before any event is trusted. Missing/invalid
   signature → `400`, never silently accepted.
5. Each Stripe event id is hashed and checked against `VerificationEvent` before
   processing — a redelivered/duplicate webhook is a no-op, not a double-apply.
6. On a terminal event, `VerificationSession.status`, the cached `User.verificationStatus`,
   and (via `profile.service.recomputeDiscoverability`) `Profile.isDiscoverable` are all
   updated in one transaction.

State machine: `PENDING → PROCESSING → VERIFIED`, or `→ MANUAL_REVIEW` (Stripe asked for
more input — a blurry photo, a mismatch worth a human look — not an automatic
rejection), or `→ REJECTED` (session canceled).

### Where verification is enforced

- `Profile.isDiscoverable` now requires `User.verificationStatus === "VERIFIED"` in
  addition to the existing name/location/approved-photo checks (unless
  `REQUIRE_IDENTITY_VERIFICATION=false`) — so an unverified user never appears to
  anyone else.
- `GET /api/discovery` also requires the *viewer* to be `VERIFIED` before they can
  browse at all — `403 FORBIDDEN` otherwise.
- `POST /api/swipes` re-checks the same thing server-side for the actor, independent of
  the discovery feed, so a client can't reach matching by posting a guessed
  `targetUserId` directly.

### Configuration required for this chunk

| Service | Env vars | Where to get it | What breaks without it |
|---|---|---|---|
| Stripe Identity | `STRIPE_SECRET_KEY`, `STRIPE_IDENTITY_WEBHOOK_SECRET` | [Stripe Dashboard → Identity](https://dashboard.stripe.com/identity) for the key; register a webhook endpoint for `identity.verification_session.*` events to get the signing secret | `POST /api/verification/start` returns `503 CONFIGURATION_MISSING`; the webhook returns `503` too |

`REQUIRE_IDENTITY_VERIFICATION` (default `"true"`) gates discovery/swiping on
verification. Set it to `"false"` only in development while Stripe Identity isn't
configured yet — never in production; there is no other bypass.

### Database change

Adds `User.verificationStatus` (cached copy of the latest `VerificationSession`
outcome, kept in sync by `verification.service`; `VerificationSession`/
`VerificationEvent` remain the audit trail). Run:

```bash
npx prisma migrate dev --name add_user_verification_status
```

### Manual test pass

1. `POST /api/verification/start` with Stripe not configured → `503 CONFIGURATION_MISSING`.
2. With Stripe configured, `POST /api/verification/start` → `201`, a real
   `verificationUrl`; `User.verificationStatus` is now `PENDING`.
3. `POST /api/verification/start` again before finishing → returns the same
   `sessionId` (`reused: true`), no duplicate Stripe session created.
4. `GET /api/discovery` while `PENDING` → `403 FORBIDDEN`.
5. Send a `POST /api/verification/webhook` with a wrong/missing `Stripe-Signature`
   header → `400`, and `User.verificationStatus` is untouched.
6. Send a real `identity.verification_session.verified` event (from Stripe's CLI/test
   mode) → `200 { received: true }`; `GET /api/verification/status` now shows
   `VERIFIED`; `GET /api/discovery` now works (assuming profile/photo requirements are
   also met).
7. Replay the exact same webhook event a second time → still `200`, but no second
   `VerificationEvent` row is created and nothing changes (idempotency).

## Chunk 6 — Voice/video calling (WebRTC signaling + TURN)

Real call signaling over the same Socket.io connection chat already uses, plus
short-lived TURN credentials so calls actually connect from behind real-world NATs —
not just on two browsers on the same LAN.

### Architecture

The backend never touches media. It does three things:

1. Issues short-lived TURN credentials (`GET /api/calls/turn-credentials`) so the
   frontend can build its `RTCPeerConnection` ICE server list.
2. Relays WebRTC's own offer/answer/ICE-candidate payloads between exactly the two
   users in a call — the payloads are opaque to the backend, it only authorizes who
   may send to whom.
3. Owns call *state* (ringing/accepted/rejected/missed/busy/ended/failed) as real
   database rows, independent of whatever either client's local UI thinks happened.

### TURN credentials

```
GET /api/calls/turn-credentials   (auth required)
```

Implements coturn's standard time-limited REST credential scheme: `username =
"<expiryUnixSeconds>:<userId>"`, `credential = base64(HMAC-SHA1(TURN_SECRET,
username))`. The TURN server (coturn, or any hosted provider implementing the same
scheme) validates the HMAC itself — `TURN_SECRET` never reaches the frontend, and a
credential can't be replayed past `TURN_CREDENTIAL_TTL_SECONDS`. Without
`TURN_URLS`/`TURN_SECRET` configured, this returns `503 CONFIGURATION_MISSING` (the
frontend should treat that as "voice/video calling is unavailable", not silently fall
back to STUN-only, which fails for a large fraction of real users in production).

### Call lifecycle — Socket.io events

Call setup/teardown happens over sockets, authenticated the same way as chat (see
chunk 4):

```
call:invite   { calleeId, type: "VOICE" | "VIDEO" }  -> ack { callId, status }
call:invite                                            <- pushed to the callee
call:accept   { callId }                             -> ack { call }
call:accept                                            <- pushed to the caller
call:reject   { callId }                             -> ack { call }
call:reject                                            <- pushed to the caller
call:end      { callId }                             -> ack { call }
call:end                                               <- pushed to the other participant
call:missed                                            <- pushed to both, from a server-side ring timer
webrtc:offer          { callId, offer }                -> relayed to the other participant only
webrtc:answer         { callId, answer }               -> relayed to the other participant only
webrtc:ice-candidate  { callId, candidate }            -> relayed to the other participant only
```

Server-enforced rules, none of them optional client-side conventions:

- `call:invite` re-checks that the caller and callee have an `ACTIVE` match — the
  same check `chat.service` uses — so a client can't ring an arbitrary userId it
  isn't matched with.
- One active call (ringing or accepted) per user at a time. Calling someone who's
  already on a call returns a real `BUSY` call record (visible in both users' call
  history) instead of silently failing or double-ringing.
- If nobody accepts within `CALL_RING_TIMEOUT_SECONDS`, a server-side timer marks the
  call `MISSED` and notifies both sides — this doesn't depend on either client
  staying open or behaving.
- `webrtc:*` signaling messages are only relayed after confirming the sender is
  actually one of the call's two participants (checked against the `Call` row, not
  trusted from the payload) — a forged/guessed `callId` gets nothing relayed.
- If a user's last socket disconnects mid-call (tab closed, network drop), the call is
  marked `MISSED` (if it was still ringing) or `FAILED` (if it was accepted but never
  cleanly ended), and the other participant gets `call:end` immediately rather than
  being left ringing/connected to nothing.

### REST endpoints

```
GET /api/calls/turn-credentials                                   (auth required)
GET /api/calls/history?cursor=                                    (auth required)
GET /api/calls/:id                                                (auth required, must be a participant)
```

`GET /api/calls/history` is what a "recent calls" screen reads — direction
(incoming/outgoing), the other user, status, and duration computed from the real
`startedAt`/`endedAt` timestamps (0 for calls that never connected).

### Database change

Adds `Call` (`CallType`: VOICE/VIDEO; `CallStatus`: RINGING → ACCEPTED/REJECTED/
MISSED/BUSY, and ACCEPTED → ENDED/FAILED). Run:

```bash
npx prisma migrate dev --name add_calls
```

### Configuration required for this chunk

| Service | Env vars | Where to get it | What breaks without it |
|---|---|---|---|
| TURN server | `TURN_URLS`, `TURN_SECRET` | Self-hosted coturn, or a hosted TURN provider implementing the same time-limited REST credential scheme | `GET /api/calls/turn-credentials` returns `503 CONFIGURATION_MISSING`; calls will still connect between two peers with a clear public IP/open NAT (rare in production) but fail for most real users without a TURN relay |

`STUN_URLS` defaults to Google's public STUN server, which is fine to keep even in
production (STUN just discovers a peer's public address; it carries no relayed media
and needs no secret).

### Manual test pass

1. `GET /api/calls/turn-credentials` with `TURN_URLS`/`TURN_SECRET` unset → `503
   CONFIGURATION_MISSING`.
2. With TURN configured, same request → `200`, an `iceServers` array whose TURN entry
   has a `username` starting with a future unix timestamp and a `credential` that
   verifies as `HMAC-SHA1(TURN_SECRET, username)`.
3. A and B are matched; A emits `call:invite` targeting B → B receives `call:invite`;
   A's ack has `status: "RINGING"`.
4. A emits `call:invite` to a user A is *not* matched with → ack `success: false`
   (`FORBIDDEN`), nothing sent to the target.
5. While A↔B call is `RINGING`, A opens a second connection and emits `call:invite` to
   C → ack `success: false` ("You're already on a call.").
6. B emits `call:accept` → A receives `call:accept`; `GET /api/calls/:id` now shows
   `status: "ACCEPTED"` with a real `startedAt`.
7. Neither side answers for `CALL_RING_TIMEOUT_SECONDS` → both receive `call:missed`;
   the call row is `MISSED`.
8. A emits `webrtc:offer` for a call A isn't part of (guessed `callId`) → nothing is
   relayed to anyone.
9. During an `ACCEPTED` call, B's socket disconnects (closes tab) → A immediately
   receives `call:end` with `reason: "peer_disconnected"`; the call row is `FAILED`.
10. A emits `call:end` after a normal call → B receives `call:end`; `GET
    /api/calls/history` for both shows the call with status `ENDED` and a nonzero
    `durationSeconds`.

## Chunk 7 — Push notifications (Web Push / VAPID)

Real browser push, delivered to devices that aren't even looking at the app — on top
of, never instead of, the `Notification` database row and `notification:new` socket
event chunk 4/6 already send.

### How it works

1. Frontend registers for push (browser prompts for permission, then calls
   `pushManager.subscribe()` using the public key from
   `GET /api/devices/vapid-public-key`), then sends the resulting subscription to
   `POST /api/devices/push-subscription`.
2. `notification.service.createNotification` — the single place every feature
   (matches, messages, calls, and later payments/security events) already goes
   through — now also calls `push.service.sendPushToUser` after creating the row and
   emitting the socket event. Push is fire-and-forget: a failed/unconfigured push
   never fails the request that triggered it (a match still gets created even if
   nobody has push enabled).
3. Push payloads are deliberately generic ("New message", "New match!", "Incoming
   call") — no message content, no other-party name lookups — so a locked phone's
   notification shade never shows something more sensitive than "you have activity on
   Matchify" for a dating app.
4. A subscription is upserted by its `endpoint` (globally unique per browser
   subscription), not a client-chosen device id, so re-subscribing after clearing
   site data replaces the stale row instead of piling up duplicates that only fail.
5. If the push service returns `404`/`410` for a given subscription (browser
   uninstalled, permission revoked, endpoint expired), that `Device` row is deleted
   automatically — handling invalid subscriptions instead of retrying them forever.

### New endpoints

```
GET    /api/devices/vapid-public-key                                  (auth required)
POST   /api/devices/push-subscription   { subscription, platform? }   (auth required)
DELETE /api/devices/push-subscription   { endpoint }                  (auth required)
GET    /api/notifications/preferences                                 (auth required)
PATCH  /api/notifications/preferences   { disabledTypes: [...] }      (auth required)
```

`subscription` is exactly what `PushSubscription.toJSON()` returns from the browser:
`{ endpoint, keys: { p256dh, auth } }`.

### Notification preferences

`NotificationPreference.disabledTypes` is an opt-out list, not opt-in — a type absent
from it means push is enabled, so a type added in a later chunk (e.g. `SUBSCRIPTION`
once payments land) reaches existing users by default instead of silently requiring a
data migration to turn it on for everyone. `SECURITY` can never be added to
`disabledTypes` — `PATCH /api/notifications/preferences` silently drops it if sent,
and `push.service` sends security notifications regardless of stored preference, so a
setting can't be used to hide a security event from someone whose account is already
compromised.

Known types: `MATCH`, `MESSAGE`, `CALL`, `SUBSCRIPTION`, `SECURITY`, `SYSTEM` (see
`utils/notificationTypes.ts` — the one place this list is defined, so the validator
and the send-path can't drift apart).

### Database change

Adds `NotificationPreference`, and adds `pushEndpoint`/`pushP256dh`/`pushAuthKey` to
`Device` (existing `pushToken`/`platform` fields are left in place, reserved for a
future native FCM/APNs integration if the app ships as a native mobile client rather
than a PWA). Run:

```bash
npx prisma migrate dev --name add_push_notifications
```

### Configuration required for this chunk

| Service | Env vars | Where to get it | What breaks without it |
|---|---|---|---|
| Web Push (VAPID) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Generate locally: `npx web-push generate-vapid-keys` (no external account needed — VAPID is a self-signed keypair, not a third-party service) | `GET /api/devices/vapid-public-key` and `POST /api/devices/push-subscription` return `503 CONFIGURATION_MISSING`; `sendPushToUser` becomes a silent no-op elsewhere (matches/messages/calls still work, just without a push) |

### Manual test pass

1. `GET /api/devices/vapid-public-key` with VAPID env vars unset → `503
   CONFIGURATION_MISSING`.
2. With VAPID configured, subscribe from a real browser and `POST
   /api/devices/push-subscription` with the resulting subscription → `201`; a `Device`
   row now has `pushEndpoint` set.
3. User B sends a message to user A (who has a registered subscription and the
   browser tab closed) → a real OS-level push notification appears for A saying "New
   message".
4. `PATCH /api/notifications/preferences` with `{ "disabledTypes": ["MESSAGE"] }`,
   then repeat step 3 → no push arrives, but `GET /api/notifications` still shows the
   notification row (in-app history is never gated by push preference).
5. `PATCH /api/notifications/preferences` with `{ "disabledTypes": ["SECURITY"] }` →
   `200`, but `GET /api/notifications/preferences` afterward shows `SECURITY` was not
   added.
6. Uninstall/revoke notification permission in the browser, then trigger another push
   to that user → the send fails with `410`, and the `Device` row for that endpoint is
   gone afterward (`GET /api/devices` — no such listing endpoint exists yet, so verify
   via `POST /api/devices/push-subscription` re-registering succeeding cleanly, or a
   direct DB check).
7. `POST /api/devices/push-subscription` with an already-registered `endpoint` from a
   different logged-in user → the row's `userId` is updated to the new user (handles
   a shared/borrowed device correctly), not duplicated.

## Chunk 8 — Payments & subscriptions (Razorpay)

Real one-time-order payments through Razorpay, with the backend — never the
frontend, never the `return_url`/checkout success callback alone — deciding
whether premium access is actually granted.

### Why "orders", not Razorpay's separate Subscriptions API

Razorpay has two different products: one-time **Orders** (pay once, get an
`order_id`), and a separate recurring-mandate **Subscriptions** API (customer
authorizes a UPI/card mandate, Razorpay auto-debits on a schedule). This
chunk uses Orders — the user buys a fixed-term plan (30 days of Premium/VIP)
and has to actively buy again before it lapses. That's a materially simpler,
equally real integration; wiring up recurring mandates instead is a
straightforward follow-up in `razorpay.provider.ts` if auto-renewal is a
hard requirement, but it changes the checkout UX (mandate authorization) and
webhook event set, so it isn't silently mixed into this chunk.

### New endpoints

```
GET    /api/subscription/plans                                        (public)
GET    /api/subscription                                              (auth required)
POST   /api/subscription/cancel                                        (auth required)
POST   /api/payments/checkout      { plan: "PREMIUM" | "VIP" }         (auth required)
POST   /api/payments/verify        { razorpay_order_id, razorpay_payment_id,
                                       razorpay_signature }             (auth required)
GET    /api/payments/history                                          (auth required)
POST   /api/payments/webhook       (Razorpay calls this — not session-authenticated)
```

### How a purchase actually gets confirmed — two independent paths, same result

1. `POST /api/payments/checkout` creates a real Razorpay order (`orders.create`
   via a plain authenticated `fetch`, no SDK — same style as the Sightengine/
   Stripe-Identity integrations) and a local `Payment` row as `CREATED`. The
   frontend opens Razorpay Checkout with the returned `orderId`/`keyId`.
2. **Path A — checkout signature.** On success, Razorpay Checkout's JS
   callback hands the frontend `razorpay_payment_id` and `razorpay_signature`.
   The frontend posts these to `POST /api/payments/verify`, which recomputes
   `HMAC-SHA256("{order_id}|{payment_id}", key_secret)` and compares it to
   the signature Razorpay produced. This is trustworthy on its own — it's a
   cryptographic proof from Razorpay, not "the frontend reported success" —
   so it activates the subscription immediately (real-time premium access,
   no waiting on a webhook round trip).
3. **Path B — webhook.** `POST /api/payments/webhook` independently receives
   `payment.captured`/`payment.failed`/`refund.processed` events. Its
   `X-Razorpay-Signature` header (HMAC-SHA256 over the exact raw body — this
   route is mounted with `express.raw()` ahead of the global JSON parser in
   `app.ts`, same reason as the Stripe Identity webhook) is verified before
   anything is trusted. This exists as the authoritative backstop for when
   path A never completes (user closes the tab right after paying) and is
   what handles refunds, which have no client-side callback at all.
4. Whichever path runs first activates the subscription; the other is a
   safe no-op (`Payment.status` is checked before re-applying, and every
   webhook delivery is additionally deduped by a hash of its exact raw body
   against `PaymentWebhookEvent`, since a redelivered webhook — normal
   Razorpay retry behavior on anything but a 2xx — must not double-activate
   or double-extend a term).
5. Neither path ever marks a payment `PAID` from a value the client merely
   asserts — verification always means "the signature check passed" or "the
   webhook's signature check passed," never "the client called an endpoint
   claiming success."

### Entitlement

`GET /api/subscription` is the only source of truth a frontend should read
to decide whether to show premium UI — never a value computed client-side.
It lazily derives `active`/`expiresAt` from the current `Subscription` row's
`endDate` rather than trusting a stored status that could go stale, so an
expired term reads as inactive immediately, with no cron needed to "expire"
anything. `POST /api/subscription/cancel` only stops treating the plan as
renewing — since this is a fixed-term order, not a mandate, cancelling
doesn't refund or cut off the days already paid for; access still lasts
until the existing `endDate`.

Buying the same plan again before it lapses extends the existing `endDate`
(so buying early never wastes paid days left); buying a different plan while
one is active ends the old term immediately and starts the new one from now.

### Database change

Adds `PaymentWebhookEvent` (webhook idempotency, same pattern as
`VerificationEvent`), and adds `signature`/`metadata`/`updatedAt` to
`Payment` and `currency`/`updatedAt` to `Subscription`. Run:

```bash
npx prisma migrate dev --name add_payments
```

### Configuration required for this chunk

| Service | Env vars | Where to get it | What breaks without it |
|---|---|---|---|
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | [Razorpay Dashboard → API Keys](https://dashboard.razorpay.com/app/keys) | `POST /api/payments/checkout` returns `503 CONFIGURATION_MISSING` |
| Razorpay webhook | `RAZORPAY_WEBHOOK_SECRET` | Razorpay Dashboard → Webhooks — register `payment.captured`, `payment.failed`, `refund.processed` pointed at `/api/payments/webhook` | The webhook path returns `503`; checkout still works end-to-end via path A above, but refunds and the "tab closed before verify" backstop stop working |

Plan pricing/duration lives in one place, `src/utils/plans.ts` — checkout,
activation, and `GET /api/subscription/plans` all read from it, so a price
change can't drift between what's charged and what's displayed.

### Manual test pass

1. `POST /api/payments/checkout` with `{ "plan": "PREMIUM" }`, Razorpay keys
   unset → `503 CONFIGURATION_MISSING`.
2. With keys configured, same request → `201`, a real Razorpay `orderId`;
   `GET /api/payments/history` shows it as `CREATED`.
3. Complete a real Razorpay test-mode checkout, then `POST
   /api/payments/verify` with the returned ids/signature → `200`;
   `GET /api/subscription` now shows `plan: "PREMIUM"`, `active: true`, a real
   `expiresAt` ~30 days out.
4. Call `POST /api/payments/verify` again with the same (now-stale) payload →
   `200 { alreadyProcessed: true }`, not a duplicate activation or an error.
5. `POST /api/payments/verify` with a tampered `razorpay_signature` →
   `400 PAYMENT_VERIFICATION_FAILED`; `Payment.status` becomes `FAILED`;
   `GET /api/subscription` still shows `FREE`.
6. Send a real Razorpay test-mode `payment.captured` webhook for an order
   that was never confirmed via `/verify` (simulating a closed tab) →
   `200`; `GET /api/subscription` now shows the plan active anyway.
7. Replay the exact same webhook payload a second time → still `200`, but no
   second `PaymentWebhookEvent`/extension happens (idempotency).
8. Send a webhook with a wrong `X-Razorpay-Signature` → `400`, nothing in the
   database changes.
9. Buy `PREMIUM`, then before it lapses buy `VIP` → the `PREMIUM` row ends
   immediately, a new `VIP` row starts from now; `GET /api/subscription`
   shows `VIP`.
10. `POST /api/subscription/cancel` on an active plan → `200`,
    `status: "CANCELLED"`, but `GET /api/subscription` still shows
    `active: true` until the existing `expiresAt`.
11. Trigger a real Razorpay test-mode `refund.processed` webhook for a
    captured payment → `Payment.status` becomes `REFUNDED` and
    `GET /api/subscription` immediately shows `FREE` (access revoked
    early, not left running until the original `expiresAt`).

## Chunk 9 — Admin dashboard

A real, separately-authenticated admin surface for moderation, safety, and
support — not a build of the queues on top of the same login the app's own
users have.

### Why admin auth is fully separate, not a role on `User`

`AdminUser` is its own table, with its own password hash, its own JWT secret
(`ADMIN_JWT_SECRET` — boot fails in production if it's ever set equal to
`JWT_ACCESS_SECRET`), its own revocable session table (`AdminSession`, not
`Session`), and its own cookie (`adminAccessToken`, scoped to the `/api/admin`
path so it's never even sent on ordinary API calls). A leaked or forged
end-user token must never double as an admin token, and an admin account
being compromised must never automatically mean user accounts are too —
two separate blast radii.

There is deliberately no HTTP endpoint that creates an `AdminUser`. The only
way to create or rotate one is the CLI script below, run with direct
server/database access:

```bash
ADMIN_EMAIL=you@matchify.example ADMIN_PASSWORD='a-real-strong-password-1' npm run admin:create
# add ADMIN_ROLE=MODERATOR for the lower-privilege role; defaults to ADMIN
```

### Roles

- **MODERATOR** — review queues: approve/reject photos, approve/reject
  identity verification manual-review cases, triage reports (change status),
  and read-only visibility into users/payments/subscriptions/safety/audit
  logs.
- **ADMIN** — everything MODERATOR can do, plus account-level actions:
  suspend/restore a user, and the one-click "suspend the user this report is
  about" action. `middleware/adminAuth.middleware.ts`'s `requireAdminRole(...)`
  is what draws this line per-route — moderators reviewing content can never
  themselves take action against a real person's account.

### New endpoints

```
POST   /api/admin/auth/login          { email, password }
POST   /api/admin/auth/logout                                          (admin auth required)
GET    /api/admin/auth/me                                              (admin auth required)

GET    /api/admin/users?query=&status=&verificationStatus=&cursor=
GET    /api/admin/users/:id
POST   /api/admin/users/:id/suspend    { reason }                      (ADMIN role)
POST   /api/admin/users/:id/restore                                    (ADMIN role)

GET    /api/admin/photos?status=&cursor=
POST   /api/admin/photos/:id/approve
POST   /api/admin/photos/:id/reject    { reason? }

GET    /api/admin/verifications?status=&cursor=
POST   /api/admin/verifications/:id/approve
POST   /api/admin/verifications/:id/reject   { reason? }

GET    /api/admin/reports?status=&cursor=
PATCH  /api/admin/reports/:id          { status }
POST   /api/admin/reports/:id/suspend-reported   { reason }            (ADMIN role)

GET    /api/admin/payments?status=&cursor=
GET    /api/admin/subscriptions?status=&cursor=

GET    /api/admin/safety/blocks?cursor=
GET    /api/admin/safety/flagged-users?minReports=

GET    /api/admin/audit-logs?cursor=
```

(All routes except `/auth/login` require `requireAdminAuth`; routes marked
"ADMIN role" additionally require `requireAdminRole("ADMIN")`.)

### Photo/verification review is the human side of `MANUAL_REVIEW`, not a bypass

Approving a `MANUAL_REVIEW` photo or verification session here is exactly
what that status exists for — a human looking at the case Sightengine or
Stripe Identity itself flagged as uncertain, not a way to skip real
moderation/verification. A photo or session only ever reaches this queue
after already going through the real automated check (see chunks 2 and 5);
nothing here lets an admin mark something verified/approved that was never
actually checked. Approving either recomputes the affected user's
`Profile.isDiscoverable` immediately (`profile.service.recomputeDiscoverability`,
the same function every other status change already goes through), so
approval takes effect in discovery right away, not on the user's next
unrelated profile edit.

### Suspension is real, not cosmetic

`POST /api/admin/users/:id/suspend` sets `User.status = "SUSPENDED"` **and**
revokes every one of that user's existing `Session` rows in the same
transaction — a suspended account can't keep using an access token/socket
connection that simply hasn't expired yet. `requireAuth` already rejects any
non-`ACTIVE` user regardless of session state, as a second line of defense.

### Every mutating action is audited, automatically

`services/adminAudit.service.ts` exports the one `logAdminAction()` helper
every mutating admin action (login, logout, suspend, restore, photo/
verification approve/reject, report status change, suspend-via-report) calls
after making its change — a new sensitive action can't be added without
also being logged as long as it goes through this helper, the same way
`notification.service.createNotification` is the one chokepoint for
notifications. `GET /api/admin/audit-logs` is what the "Audit" dashboard
screen reads.

### Database change

Adds `AdminSession`, `failedLoginAttempts`/`lockedUntil` on `AdminUser` (same
lockout pattern as the end-user `User` model), and an index on
`AdminAuditLog.createdAt`. Run:

```bash
npx prisma migrate dev --name add_admin_dashboard
```

### Configuration required for this chunk

| Service | Env vars | Where to get it | What breaks without it |
|---|---|---|---|
| Admin auth | `ADMIN_JWT_SECRET` | Generate locally: `openssl rand -hex 32` (no external account — a self-signed secret, like the end-user JWT ones) | `POST /api/admin/auth/login` (and every other `/api/admin/*` route) returns `503 CONFIGURATION_MISSING` |

### Manual test pass

1. `POST /api/admin/auth/login` with `ADMIN_JWT_SECRET` unset → `503
   CONFIGURATION_MISSING`.
2. Run `npm run admin:create` to create an `ADMIN`-role account, then log in
   with the wrong password 5 times → 6th attempt `423 ACCOUNT_LOCKED`.
3. Log in correctly → `200`, `adminAccessToken` cookie set;
   `GET /api/admin/auth/me` returns the admin's own email/role.
4. Create a `MODERATOR`-role account, log in as it, call `POST
   /api/admin/users/:id/suspend` → `403 ADMIN_FORBIDDEN` (role-gated).
5. As `ADMIN`, suspend a real test user → `200`; that user's existing session
   cookie now gets `401` on any authenticated endpoint; `GET
   /api/admin/audit-logs` shows a `SUSPEND_USER` row with the reason.
6. Upload a photo that lands in `MANUAL_REVIEW` (chunk 2's reused-image
   case is an easy way to trigger this), then `POST
   /api/admin/photos/:id/approve` → `200`; the photo's owner now sees it
   `APPROVED` via `GET /api/photos`, and if it was their only photo,
   `GET /api/discovery` for another verified/located user now surfaces them.
7. `POST /api/admin/reports/:id/suspend-reported` on an `OPEN` report → the
   reported user is suspended, the report flips to `RESOLVED`, and both
   actions appear in the audit log tied to the same admin.
8. `GET /api/admin/safety/flagged-users?minReports=2` with a test user who
   has 2+ `OPEN`/any-status reports against them and isn't suspended → that
   user appears, sorted by report count.
9. Log out (`POST /api/admin/auth/logout`), then reuse the old
   `adminAccessToken` cookie value → `401` (session revoked, not just an
   expired-but-still-valid JWT).

## Chunk 10 — Account deletion

Real, immediate account deletion with a cancelable grace period — never a
button that just hides the profile while quietly leaving everything intact.

### The two-phase design, and why

Deletion has to satisfy two things that are in tension: it should take
effect *immediately* (login disabled, sessions dead, profile gone from
discovery, matches closed) so a user isn't left wondering whether it worked,
but real products also need a short window to undo an accidental or
coerced deletion before data is actually destroyed. Rather than solve that
by leaving login open during a grace period (which would make "disable
login" meaningless), cancellation runs entirely through a mailed, one-time
restore link — the same opaque-token-hashed-at-rest pattern as password
reset — so there is no state where the account is simultaneously
"pending deletion" and "usable by logging in."

1. **`DELETE /api/auth/account`** (auth required, body `{ "password"?: string
   }` — required if the account has one, skipped for Google-only accounts)
   takes effect synchronously and immediately:
   - `User.status` → `PENDING_DELETION`, `scheduledDeletionAt` set
     `ACCOUNT_DELETION_GRACE_DAYS` out.
   - Every session and refresh token is revoked (`logoutAllDevices`) — this
     is what actually disables login; `assertLoginable` also rejects a
     fresh login attempt against a `PENDING_DELETION` account regardless.
   - `Profile.isDiscoverable` is forced `false`, and `recomputeDiscoverability`
     now refuses to ever turn it back `true` for a non-`ACTIVE` user — so
     even an unrelated later profile-service call can't accidentally
     re-surface a deleted account.
   - Every `ACTIVE` match involving the user flips to `ACCOUNT_DELETED` —
     the same status field `match.service`'s `listMatches` and
     `chat.service`'s `sendMessage` already gate on, so the match
     disappears from both users' match lists and further messages in that
     conversation are rejected, without deleting the message history.
   - Any active subscription is cancelled the normal way (`cancelSubscription`
     — access still runs out at the already-paid `endDate`, nothing is
     refunded here).
   - A one-time restore token is created and, best-effort, emailed via
     `sendAccountDeletionEmail`. If SMTP isn't configured, deletion still
     succeeds (sessions are already revoked) — the response's
     `restoreEmailSent: false` tells the frontend to warn the user there's
     no self-service way back before the scheduled date.
2. **`POST /api/auth/account/restore`** `{ token }` — deliberately **not**
   `requireAuth` (there's no valid session to require). Verifies the token,
   confirms the account is still `PENDING_DELETION` (not already purged),
   and flips it back to `ACTIVE`. The user logs in fresh afterward; old
   sessions and closed matches are not resurrected.
3. **`npm run account:purge`** (`src/scripts/purgeDeletedAccounts.ts`) — a
   CLI script meant for a daily cron job, the same "no HTTP endpoint, direct
   server access only" pattern as `admin:create`, since there's no
   in-process job queue yet (see "Background jobs" in the top-level
   architecture notes). It finds every `PENDING_DELETION` user whose
   `scheduledDeletionAt` has passed and permanently:
   - Deletes their photos from object storage and their `Photo` rows.
   - Deletes their devices/push subscriptions, sessions, refresh tokens,
     and all the token tables (email verification, password reset, account
     deletion).
   - Anonymizes (never drops) the `User` row: email rewritten to a
     `deleted-{id}@deleted.matchify.invalid` address (freeing the original
     for re-registration), password hash and Google id cleared, status
     `DELETED`.
   - Anonymizes the `Profile` row to a bare "Deleted user" with no bio,
     location, or interests.

   `Payment`/`Subscription` rows are kept as-is (financial/legal records),
   and `Match`/`Message`/`Report`/`Block`/`VerificationSession` rows are
   kept as-is too — deleting the `User` row outright would cascade-delete
   those (see the schema's `onDelete: Cascade` relations) and destroy the
   *other* party's conversation history and any safety/compliance trail
   along with it. Anonymizing in place instead means the other side of an
   old conversation still resolves to a real (if now-anonymous) profile,
   never a broken reference.

### Configuration required for this chunk

No new external provider — this reuses SMTP (chunk 1) and object storage
(chunk 2), both already optional/graceful if unconfigured.

| Env var | Default | What it controls |
|---|---|---|
| `ACCOUNT_DELETION_GRACE_DAYS` | `14` | Days between requesting deletion and the purge script being allowed to run for that account |

### Manual test pass

1. `DELETE /api/auth/account` with no `password` on a password-auth account
   → `400 VALIDATION_ERROR`.
2. `DELETE /api/auth/account` with the wrong password → `401
   INVALID_CREDENTIALS`; account untouched.
3. `DELETE /api/auth/account` with the correct password → `200`,
   `status: "PENDING_DELETION"`, a real `scheduledDeletionAt` ~14 days out;
   the `accessToken`/`refreshToken` cookies are cleared.
4. Immediately try `GET /api/auth/me` with the old (now-revoked) access
   token → `401`.
5. Try `POST /api/auth/login` with the correct credentials → `403
   ACCOUNT_PENDING_DELETION`, not `423`/`401` — login stays disabled.
6. `GET /api/discovery` as a different, verified/located user who was
   matched with the deleted account → the deleted user no longer appears
   anywhere, and `GET /api/matches` for the other user no longer lists that
   match.
7. Attempt `POST /api/conversations/:id/messages` in the now-closed
   conversation, as the *other* user → `403` ("This match is no longer
   active."); old messages are still visible via `GET
   /api/conversations/:id/messages`.
8. `POST /api/auth/account/restore` with an invalid/expired/already-used
   token → `400 INVALID_TOKEN`.
9. `POST /api/auth/account/restore` with the real token from step 3's email
   → `200`, `restored: true`; `POST /api/auth/login` with the original
   credentials now works again.
10. Set a test user's `scheduledDeletionAt` to the past (or wait out a short
    `ACCOUNT_DELETION_GRACE_DAYS` in a dev environment), run `npm run
    account:purge` → the user's `Profile.displayName` reads "Deleted user",
    `User.email` is the `deleted-*@deleted.matchify.invalid` form, their
    photos are gone from both the database and the bucket, and the original
    email address can be used to `POST /api/auth/register` again.
11. Run `npm run account:purge` a second time immediately after → `"nothing
    due"`, no errors, no double-processing.

## Chunk 11 — Automated tests

Real unit tests with `vitest`, run against fully mocked Prisma and
external-provider calls — no live database, no network calls, nothing
faked as "passing" without actually executing. This is unit-level
coverage of business logic, not the end-to-end suite described in the
architecture doc's testing checklist; see "Not covered yet" below for
exactly what that still leaves out.

### Why mocked Prisma, not a real test database

A real integration suite (spin up Postgres, run migrations, hit real
rows) is the more thorough approach and is called out explicitly as
still-needed below. Mocking `../config/prisma` with
`vitest-mock-extended`'s `mockDeep<PrismaClient>()` was chosen for this
chunk because it needs zero infrastructure to run — `npm test` works
identically in this sandbox, in CI, and on a laptop with no `DATABASE_URL`
pointed at anything real — while still exercising the actual business
logic in each service (branching, authorization checks, canonical
id-sorting, idempotency), not just the Prisma calls themselves.

### What's covered

- **`utils/`** (pure functions, no mocking needed): `calculateAge`
  (including the "birthday hasn't happened yet this year" edge case that
  the underage-registration gate depends on), the min/max-age DOB boundary
  helpers, JWT access-token sign/verify (including a forged/tampered
  token), opaque-token generation/hashing (refresh/email-verification/
  password-reset tokens), password hashing + strength rules, the
  Razorpay checkout-signature and webhook-signature verifiers (valid,
  wrong-secret, tampered-body, malformed-header cases), the Stripe
  Identity webhook verifier (including its 5-minute replay-tolerance
  window), and the `PLANS`/`Errors` constants.
- **`auth.service`**: registration's age gate and password-strength gate
  (and that neither one touches the database), duplicate-email
  rejection, the happy path creating a user + verification token +
  email, and that an unconfigured mail provider surfaces as a real
  `503` rather than a silent fake-success; login's lockout logic
  (locked-account short-circuit, failed-attempt increment, the exact
  attempt that flips into a lock, successful login resetting the
  counter), the `ACCOUNT_SUSPENDED` vs `ACCOUNT_PENDING_DELETION`
  distinction; refresh-token rotation and replay/expiry rejection;
  `logout` vs `logoutAllDevices` scoping; account-deletion's
  password-confirmation gate; account-restore's invalid/already-purged
  token handling.
- **`swipe.service`**: self-swipe rejection, the identity-verification
  gate, the identical `404` for "doesn't exist" vs "blocked" (so one
  can't be distinguished from the other by probing), duplicate-swipe
  rejection, a pass never checking for a match, a one-sided like not
  matching, and — the trickiest invariant in this service — that a
  mutual like always sorts `userAId`/`userBId` into canonical order
  regardless of who liked last, with no duplicate match/notification
  when the match already existed.
- **`chat.service`**: message validation (empty, too long, missing
  conversation id), the `404`-not-`403` membership check, rejecting
  sends into a closed (non-`ACTIVE`) match, rejecting sends where either
  side has blocked the other, deleted-message content redaction in
  `getMessages`, and that `markConversationRead` only touches the other
  party's messages.
- **`block.service`**: self-block rejection, blocking closing an active
  match under the same sorted-id scheme swipe/match uses.
- **`payment.service`**: checkout rejecting an unknown plan before
  calling Razorpay at all, checkout order creation; `verifyCheckout`'s
  full state machine (missing payment, already-`PAID` idempotent
  success, already-terminal rejection, invalid signature flipping the
  payment to `FAILED` without activating anything, valid signature
  activating the subscription); webhook idempotency (exact redelivery
  is a no-op), `payment.captured` activation, the case where `/verify`
  already won the race, `refund.processed` revocation, and an
  unrecognized event type being silently ignored rather than erroring.

### Not covered yet

This chunk is unit tests for the services above only. Still needed,
per the architecture doc's own testing checklist:

- **Integration tests against a real (test) Postgres database** —
  migrations, actual foreign-key/unique-constraint behavior (e.g. the
  `@@unique([userAId, userBId])` race the sorted-id logic exists to
  avoid), cascades on account purge.
- **Route/controller-level tests** (supertest against the real
  `src/app.ts`) — the auth/admin-auth middleware itself is now covered
  directly (chunk 12), but still needs proving wired into real routes:
  rate limiting actually triggering, admin-auth separation end-to-end,
  and request validation (zod) at the HTTP boundary rather than the
  service boundary.
- **Every other service**: `profile`, `discovery` (age/gender/distance
  filtering, pagination, exclusion of blocked/swiped/deleted users),
  `photo`/`image` (this one specifically needs real `sharp`
  decode/re-encode and a real or emulated S3 bucket — not meaningfully
  unit-testable against a mock), `moderation`, `verification`
  (Stripe Identity session lifecycle + webhook), `call`
  (WebRTC/TURN-credential signing), `push`, `notification`'s socket
  emission, all `admin*` services, `device`.
- **Socket.io tests** — a real client/server pair for chat delivery,
  typing indicators, presence, and call signaling; none of that is
  exercised by unit-testing `chat.service` in isolation.
- **The full end-to-end journey** from the architecture doc (register →
  verify → photo → discovery → match → chat → call → pay → delete) —
  by definition requires the real stack running together, not mocks.
- **Failure-injection tests**: webhook signature replay beyond what
  `stripeSignature`/`razorpaySignature` already cover in isolation,
  concurrent double-submit races, DB-connection-loss handling.

### Running the tests

```bash
npm install
npm test              # single run
npm run test:watch    # watch mode
npm run test:coverage # with a coverage report
```

No environment variables need to be set for these to run — `tests/setup.ts`
fills in the minimum `src/config/env.ts` requires (fake secrets, a
`DATABASE_URL`-shaped string that's never actually connected to) before
any test file's imports execute, and every provider integration
(SMTP, Google, S3, Stripe, Razorpay, TURN, push) stays in its default
"unconfigured" state unless a specific test stubs it, which is what
makes the `CONFIGURATION_MISSING` assertions in the auth suite
meaningful.

## Chunk 12 — Middleware & error-handling tests

Continuing straight down the "not covered yet" list from chunk 11: the
authorization middleware every protected route depends on, plus the shared
error pipeline every route relies on to never leak internals. Same
approach as chunk 11 — real tests, no live infrastructure — but two
different techniques depending on what's being tested:

- **`requireAuth` / `requireAdminAuth` / `requireAdminRole`**
  (`tests/unit/middleware/`): called directly with fake `req`/`res`/`next`
  objects and mocked Prisma, the same pattern as the chunk-11 service
  tests. Covers: missing cookie, forged/garbage token, revoked session,
  expired session, a session whose user is no longer `ACTIVE`, and the
  success path attaching `req.userId`/`req.sessionId`. For the admin
  side specifically: that the end-user `accessToken` cookie is never
  read as a substitute for `adminAccessToken` (a normal login must never
  grant admin access), that an unconfigured `ADMIN_JWT_SECRET` collapses
  into a plain `401 ADMIN_UNAUTHORIZED` rather than crashing or leaking a
  `503`, and `requireAdminRole`'s allow/deny logic (`MODERATOR` is not
  implicitly granted `ADMIN`-only actions).
- **`adminTokens` sign/verify round-trip** (`tests/unit/utils/adminTokens.test.ts`):
  the one case that actually needs a real `ADMIN_JWT_SECRET` value, which
  the shared test env deliberately leaves unconfigured (see chunk 11's
  reasoning on why `CONFIGURATION_MISSING` assertions matter). Solved with
  `vi.doMock("../config/env", ...)` + a dynamic `import()` scoped to just
  those two tests, rather than changing the shared test defaults — proves
  the sign→verify round-trip works, and that a token signed under one
  secret does not verify under another, without weakening every other
  test's "nothing is configured by default" guarantee.
- **`errorHandler` / `asyncHandler`** (`tests/unit/middleware/errorHandler.middleware.test.ts`):
  real HTTP-level tests via `supertest`, but against a small purpose-built
  Express app defined in the test file — not the real `src/app.ts`.
  Importing `app.ts` for this would pull in every controller and their
  heavy dependencies (multer, sharp, the Razorpay/Stripe clients,
  Socket.io) just to test "does a thrown error produce the right JSON",
  which is a poor trade for what chunk 13's real route tests already need
  to solve properly (see below). Covers: an `ApiError` rendering with its
  own status code and `{ code, message }`, a `ZodError` rendering as `400
  VALIDATION_ERROR`, an arbitrary thrown `Error` rendering as a generic
  `500 INTERNAL_ERROR` that never echoes the original message (asserted
  against a deliberately sensitive fake error message, e.g. a connection
  string, to prove it really doesn't leak), and `asyncHandler` correctly
  forwarding a rejected promise into the same pipeline.

### Not attempted here (this is what chunk 13 should be)

Full route-level tests against the real `src/app.ts` with `supertest` —
registration/login/refresh flows end-to-end through Express (not just
the service function), rate limiting actually triggering across repeated
requests, the raw-body Stripe/Razorpay webhook routes specifically
(they're registered before `express.json()` on purpose — a test should
prove that ordering still holds), and the `/api/*` 404 fallback. This
needs either mocking every controller's service-layer dependency (a lot
of setup) or accepting real Prisma calls against a test database — worth
deciding deliberately rather than folding into this chunk.

## Chunk 13 — Route-level tests against the real `src/app.ts`

Picking up exactly where chunk 12 left off: real HTTP tests via `supertest`
against the actual, fully-wired `src/app.ts` — every middleware, every
router, the real Express middleware ordering — with only `../config/prisma`
(deep-mocked, same pattern as every earlier chunk) and a handful of
external-provider *service* modules (email, Google, push, subscription)
stubbed so a successful registration/login doesn't need real SMTP/Google
credentials. Two files, because one of them needs a materially different
setup:

- **`tests/integration/app.test.ts`** — runs against the shared "nothing
  configured by default" test env (same `tests/setup.ts` every other suite
  uses). Covers:
  - `GET /health` and the `/api/*` 404 fallback (`NOT_FOUND`, for both a
    known-shape unmatched path and an unmatched method).
  - Zod validation actually rejecting a bad `POST /api/auth/register` body
    before the database is ever touched, `409 EMAIL_IN_USE`, and a genuine
    `201` registration.
  - Rate limiting **actually triggering** over repeated real HTTP calls, not
    just unit-tested in isolation: the 6th `/api/auth/register` in a window
    (limit 5) and the 11th `/api/auth/login` (limit 10) both come back `429
    RATE_LIMITED`, with the requests before the limit explicitly asserted as
    *not* `429`. Each of these two tests gets its own freshly-imported `app`
    (`vi.resetModules()` + dynamic `import()`) so `express-rate-limit`'s
    per-process in-memory store starts clean and the exact-count assertions
    aren't sensitive to what other tests in the file already sent.
  - The full cookie-based session lifecycle through the real routes in one
    pass, using `supertest.agent()` so cookies persist like a real browser:
    unauthenticated `/me` → login → `/me` succeeding → `/refresh` rotating
    the refresh token → `/logout` clearing cookies. Plus account lockout
    (`423 ACCOUNT_LOCKED`) short-circuiting before password comparison.
  - **The raw-body webhook ordering chunk 12 flagged as unattempted**: both
    `/api/verification/webhook` and `/api/payments/webhook` are proven to
    still be mounted with `express.raw()` *ahead of* the global
    `express.json()` — a deliberately non-JSON body sent to either comes
    back as that webhook's own `503 CONFIGURATION_MISSING` (no secret
    configured), never a body-parser `SyntaxError`. A control-case test on
    an ordinary JSON route (`/api/auth/login`) confirms the *contrast*: a
    malformed body there really does hit `express.json()` and surfaces as a
    generic `500 INTERNAL_ERROR` that leaks nothing, without ever reaching
    the database.

- **`tests/integration/adminAuth.route.test.ts`** — admin-auth separation
  and role gating, proven end-to-end through the real routes rather than by
  calling the middleware functions directly (that's chunk 12). This needs
  `ADMIN_JWT_SECRET` actually set before `src/config/env.ts` is parsed, which
  the shared test env deliberately leaves unset — so this file uses
  `vi.stubEnv` + `vi.resetModules()` + a dynamic `import("../../src/app")`
  per test (the same technique chunk 12's `adminTokens.test.ts` uses, scoped
  to the whole app instead of one utils module). Covers:
  - A full admin login → `/auth/me` pass with a configured secret, including
    that the `adminAccessToken` cookie is scoped to `Path=/api/admin`.
  - The end-user `accessToken` cookie is never accepted as a substitute for
    `adminAccessToken` (a real end-user-shaped JWT, signed under a different
    secret, sent under the end-user cookie name still gets `401
    ADMIN_UNAUTHORIZED`), and a token that verifies under the *wrong* secret
    is rejected even when sent under the right cookie name.
  - `requireAdminRole` end-to-end: a `MODERATOR`-role token is `403
    ADMIN_FORBIDDEN` on `POST /api/admin/users/:id/suspend`; an `ADMIN`-role
    token is let through and actually calls `suspendUser` (`$transaction`
    fires, an audit-log row is written with the right `action`/`targetId`).
  - `adminLoginRateLimiter` actually triggering (limit 5, tighter than the
    end-user login limiter) over real repeated requests.
  - With `ADMIN_JWT_SECRET` left unconfigured: every `/api/admin/*` route
    behind `requireAdminAuth` collapses to a clean `401 ADMIN_UNAUTHORIZED`
    (chunk 12's assertion, now proven through the real route) — but
    `POST /api/admin/auth/login` itself, which isn't behind
    `requireAdminAuth`, correctly surfaces the *different* documented
    behavior from chunk 9: a real `503 CONFIGURATION_MISSING`, since
    `signAdminAccessToken`'s error there propagates straight to the shared
    `errorHandler` unconverted rather than through `requireAdminAuth`'s
    try/catch.

### Why prisma is deep-mocked rather than pointed at a real test database

Same reasoning as chunk 11: zero infrastructure to run these, identical
behavior in this sandbox, in CI, and on a laptop with no `DATABASE_URL`
pointed at anything real. The trade-off is also the same one chunk 11 and
12 already called out and still holds here — this proves routing,
middleware ordering, validation-at-the-boundary, rate limiting, and cookie
behavior, but not real foreign-key/unique-constraint enforcement (e.g. the
`@@unique([userAId, userBId])` race `swipe.service`'s canonical id-sorting
exists to avoid). That still needs a real (test) Postgres instance — see
"What's left overall" below, which is unchanged by this chunk except for
removing the two items it addresses.

### Running the tests

Unchanged from chunk 11 — `npm test` / `npm run test:watch` / `npm run
test:coverage`. No new environment variables are required; both new test
files manage their own `ADMIN_JWT_SECRET` stubbing internally where needed
and restore the shared "unconfigured" defaults afterward
(`vi.unstubAllEnvs()` in `afterEach`).

### Not attempted here

Per chunk 12's own list, still outstanding: integration tests against a
real (test) Postgres database, full route-level coverage for every other
controller (photos, discovery, matches, chat REST fallback, calls,
subscriptions/payments beyond the webhook-ordering check above, the rest of
the admin moderation/reports/safety/audit endpoints), Socket.io tests, and
the full end-to-end journey — see "What's left overall" below.

## What's left overall

Not started yet: route-level tests against the real app (see chunk 12's
note above), integration tests against a real database, Socket.io tests,
the full end-to-end journey, deployment config, and the Next.js frontend
itself (everything so far is backend-only).


---

## Random Chat

See [RANDOM_CHAT.md](./RANDOM_CHAT.md) for setup, matching rules, privacy model, API and scaling notes.

## Zero-config fallbacks (added)

So sign-up, photo upload and matching work without third-party accounts:

| Missing config | Behaviour now |
|---|---|
| SMTP | Sign-up succeeds and the email is marked verified. Set `SMTP_*` to send real verification emails. |
| S3/R2 | Photos are stored on local disk (`UPLOAD_DIR`, default `uploads/`) and served from `/uploads/users/...`. Render's disk is ephemeral; use S3/R2 (or a Render persistent disk) for real data. |
| Sightengine | Photos are auto-approved (`ALLOW_UNMODERATED_PHOTOS`, default `true`). Set it to `false` in production once `MODERATION_API_*` is configured. |
| Stripe Identity | `REQUIRE_IDENTITY_VERIFICATION` defaults to on only if Stripe is configured; otherwise users can discover and swipe. |
| Google | Only `GOOGLE_CLIENT_ID` is needed (the secret is not used to verify ID tokens). Defaults to the Matchify client ID. |
