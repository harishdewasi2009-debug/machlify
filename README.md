# Matchify — backend + frontend + admin

```
backend/          Node/Express/Prisma API
frontend/index.html   The user-facing app (single file)
frontend/admin.html   The moderator/admin dashboard (single file)
frontend/sw.js        Service worker — Web Push only, no offline caching
```

## What's connected, end to end

Auth: register, login, logout, Google sign-up/login, delete account, change
password, forgot/reset password, email-verification links.

Profile: real load/save (bio, job, school, interests, discovery
preferences, location), a real photo manager (upload, delete, reorder,
drag-and-drop, set main photo), all backed by `/api/profile` and
`/api/photos`.

Discovery, swipe, matches: `GET /api/discovery` (now includes a real
`verified` flag, added since it was missing), `POST /api/swipes` (a match
only shows when the backend reports one), matches list, unmatch.

Chat: real-time over Socket.io — the backend's socket layer was already
built, the frontend now actually connects to it — with typing indicators,
online/offline presence, and a REST fallback if the socket briefly drops.

Calling: real WebRTC voice/video, signaled over the same socket connection,
with TURN credentials fetched from the backend per call.

Verification: selfie upload → private storage → human moderator review
→ real `VERIFIED`/`REJECTED`. Never auto-approves.

Payments: real plans from `/api/subscription/plans`, real Razorpay
checkout, server-side signature verification before anything is granted,
cancel subscription.

Safety: block, unblock, report (with real reasons), notifications list
with real types and read state, notification preferences that actually
turn specific alert types off, Web Push (subscribe/unsubscribe via the
service worker).

Admin (`admin.html`, separate login, separate cookie from the user app):
verification review (with the selfie image, previously not visible to
anyone — the API didn't return it), photo moderation queue (same fix —
photos had no viewable URL either), reports triage, user search &
suspend/restore, payments & subscriptions (read-only), safety overview
(blocks, flagged users), full audit log.

## Two real backend fixes made along the way (not just frontend wiring)

- `GET /api/discovery` never returned a `verified` field — the "Show only
  verified" filter in Discover existed in the UI but could never work.
  Added it.
- Neither the photo-moderation queue nor the verification queue gave
  admins/moderators an actual URL to view the image they were supposed to
  be reviewing. Both now return a short-lived signed URL, never a public
  one.
- A brand-new match's conversation didn't exist yet when each user's
  socket connected, so its first messages would only have arrived after a
  reconnect. Sockets are now explicitly joined to a new conversation's room
  the moment the match is created.

## Explicitly still fake, unbuilt, or unverified

- **Never run against a live server.** All 222 backend tests use a mocked
  database. I have not been able to start the real backend in my sandbox
  (Prisma's engine download is network-blocked there), so nothing in this
  zip has been clicked through end-to-end on a real deployment.
- **Nothing is configured.** `.env` is still placeholders for Postgres, S3,
  Razorpay, Stripe Identity, email, SMS, Google OAuth, VAPID (push), and
  TURN. Each feature above will fail with a clear "not configured" error
  until its specific credential is set — that's expected, not a bug.
- **No SMS/phone OTP.** Not built — email/Google are the only login paths.
- **No legal pages.** Privacy Policy / Terms / Community Guidelines are
  still outline drafts (see `matchify-legal-policy-drafts.md` if you have
  it from earlier), not lawyer-reviewed text.
- **Deep-link routes need server config.** The links in verification/reset
  emails point at `/verify-email`, `/reset-password`, `/restore-account`.
  Your static host must serve `index.html` for all of these paths (a
  single-page-app rewrite rule) or they'll 404.
- **Admin dashboard has no self-registration** — the first `AdminUser` row
  has to be created directly in the database; there's no signup flow for
  admins (correctly so — that shouldn't be self-serve).

## Before you can run this for real

1. `cd backend && npm install`
2. Real Postgres in `DATABASE_URL`, plus every other `.env.example` value
   you want working (S3/R2 or Supabase Storage, Razorpay, Stripe Identity,
   an email provider, Google OAuth, VAPID keys for push, TURN).
3. `npx prisma generate && npx prisma migrate deploy`
4. `npm run build && npm start` (or `npm run dev`)
5. Serve `frontend/index.html` and `frontend/admin.html` statically (with
   the SPA rewrite rule mentioned above). Set the backend URL before the
   scripts run:
   ```html
   <script>
     window.MATCHIFY_API_BASE = "https://your-backend.example.com";
     window.MATCHIFY_GOOGLE_CLIENT_ID = "...apps.googleusercontent.com"; // optional
   </script>
   ```
6. Create your first admin: insert a row into `admin_users` with a bcrypt
   password hash (the backend's own `hashPassword` util does this) and
   role `ADMIN`, then log into `admin.html`.
7. Walk through the real flow yourself: register → verify email → upload
   photos → submit selfie verification → approve it in `admin.html` →
   swipe with a second test account → match → chat live → call → subscribe.
   Send me whatever breaks.

## Still declined

Populating this with hundreds of fake profiles — especially skewed fake
"women" vs "men" counts — was asked for earlier and declined, and that
hasn't changed. Showing real users profiles of people who don't exist so
they swipe, match, and pay to talk to them is deceptive by design, not a
demo, and it's exactly what your own uploaded spec (rule 45) said to
remove, not add.
