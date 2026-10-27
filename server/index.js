import { randomBytes } from "node:crypto";
import app from "./app.js";
import { stopCopilotClient } from "./copilot.js";

const port = Number(process.env.PORT || 3000);
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Set JWT_SECRET to a long, random value before starting in production.");
  }
  process.env.DEV_JWT_SECRET = randomBytes(48).toString("base64url");
  console.warn("JWT_SECRET is unset. Using a temporary development-only secret; sessions expire when the server restarts.");
}
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`HCM Lite API listening at http://localhost:${port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    try {
      await stopCopilotClient();
      process.exit(0);
    } catch (error) {
      console.error("Could not stop the Copilot runtime cleanly:", error.message);
      process.exit(1);
    }
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
