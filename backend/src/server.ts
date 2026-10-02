import http from "node:http";
import { app } from "./app";
import { env } from "./config/env";
import { initSocket } from "./websocket/socket";
import { startRandomChatWorkers } from "./services/randomChat/workers";
import { seedDemo } from "./scripts/seedDemo";

// A plain http.Server wraps the Express app so Socket.io can attach to the
// same port instead of needing a second listener/process.
const httpServer = http.createServer(app);
initSocket(httpServer);
startRandomChatWorkers();

httpServer.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Matchify backend (HTTP + Socket.io) listening on port ${env.PORT} (${env.NODE_ENV})`);
});

// Creates the demo user/admin (and a few demo profiles) if they don't exist.
// Never blocks or crashes the server; disable with SEED_DEMO=false.
seedDemo().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Demo seed failed:", err);
});
