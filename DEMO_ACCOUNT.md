# Demo accounts

User:  demo@matchify.app / Demo@12345
Admin: demoadmin@matchify.app / DemoAdmin@12345

Created by backend/src/scripts/seedDemo.ts (safe to run repeatedly).

Render Start Command:
  npx prisma db push --skip-generate && npm run demo:seed:prod && npm start

Disable with env var SEED_DEMO=false.

## Login / hosting notes
- The login screen has a "Use demo account" link that fills in the demo credentials.
- The demo user only exists after the backend has started once against your database
  (the server seeds it on startup; first request after a Render cold start can take ~50s).
- If the frontend is hosted on a different domain than the API, set on the backend:
    APP_ORIGIN=https://your-frontend.example.com   (and EXTRA_ORIGINS=a,b for more)
  Cookies are SameSite=None;Secure in production so cross-site login sticks.
- Google sign-in: add your site's URL under "Authorized JavaScript origins" for the OAuth client in Google Cloud Console.
- Apple sign-in needs APPLE_CLIENT_ID (a Services ID) on the server; until then the button shows a friendly message.
