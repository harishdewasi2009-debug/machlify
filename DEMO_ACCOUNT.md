# Demo accounts

User:  demo@matchify.app / Demo@12345
Admin: demoadmin@matchify.app / DemoAdmin@12345

Created by backend/src/scripts/seedDemo.ts (safe to run repeatedly).

Render Start Command:
  npx prisma db push --skip-generate && npm run demo:seed:prod && npm start

Disable with env var SEED_DEMO=false.
