import { processProtectionBlock } from "../../frontend/src/server/automation";
// A persistent process, run from frontend/ so it shares that app's SQLite path and .env.local.
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
async function main() {
  while (!stopped) {
    try { await processProtectionBlock(); }
    catch { console.error("Protection worker unavailable: check local credentials, policies, database and RPC."); }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
void main();
