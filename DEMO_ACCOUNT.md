# Demo accounts

User:  demo@matchify.app / Demo@12345
Admin: demoadmin@matchify.app / DemoAdmin@12345   (local/dev only — see "Demo admin" below)

Created by backend/src/scripts/seedDemo.ts (safe to run repeatedly). Fake swipe profiles are off by default (SEED_DEMO_PROFILES=true to enable).

Render Start Command:
  npx prisma db push --skip-generate && npm run demo:seed:prod && npm start

Disable everything with env var SEED_DEMO=false (do this for a real launch).

## Demo admin (important)
Admin login needs TWO things on the server:
1. `ADMIN_JWT_SECRET` — a random secret, different from the user JWT secrets. Generate with `openssl rand -hex 32`.
   Without it, admin login answers 503 "not configured" no matter what password you type.
2. An admin account. The seed creates one for you:
   - **Local / development:** `demoadmin@matchify.app` / `DemoAdmin@12345`, role ADMIN.
   - **Production (NODE_ENV=production):** the published password above is NOT used — an admin account with a public
     password on a live site would expose every user's data. Instead set these env vars on the server, then redeploy:
       DEMO_ADMIN_PASSWORD=<your own 12+ character password with letters and numbers>
       DEMO_ADMIN_ROLE=ADMIN        (optional; default is MODERATOR, which can review but not suspend/ban)
     Log in with `demoadmin@matchify.app` and that password.
   - Without `DEMO_ADMIN_PASSWORD` in production the demo admin is disabled, and any demo admin left over from an
     older deploy (with the old public password) is locked and its sessions revoked.
   - For a real admin account use `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run admin:create` instead.

Open the admin panel at `/admin.html` on the same address as your backend.

## Login / hosting notes
- The login screen has a "Use demo account" link that fills in the demo credentials.
- The demo user only exists after the backend has started once against your database
  (the server seeds it on startup; first request after a Render cold start can take ~50s).
- If the frontend is hosted on a different domain than the API, set on the backend:
    APP_ORIGIN=https://your-frontend.example.com   (and EXTRA_ORIGINS=a,b for more)
  Cookies are SameSite=None;Secure in production so cross-site login sticks. State-changing API calls from any
  origin not in APP_ORIGIN/EXTRA_ORIGINS (or the server's own host) are rejected as CSRF.
- The admin page uses the same address as the page itself on localhost / *.onrender.com. On any other domain
  that does not serve the backend, set `window.MATCHIFY_API_BASE` before the script runs.
- Google sign-in: add your site's URL under "Authorized JavaScript origins" for the OAuth client in Google Cloud Console.
- Apple sign-in needs APPLE_CLIENT_ID (a Services ID) on the server; until then the button shows a friendly message.
