// src/main.ts
// Process entrypoint: config from env, one hub, clean SIGTERM. That's all —
// the systemd unit owns restarts, nginx owns the public side.
import { configFromEnv } from "./config.js";
import { createHub } from "./server.js";
import { HUB_VERSION } from "./version.js";

const cfg = configFromEnv();
const hub = createHub(cfg);

const port = await hub.listen();
console.log(`[hub] wickhunter-hub v${HUB_VERSION} listening on ${cfg.host}:${port}`);
if (!cfg.adminToken) {
  console.warn("[hub] HUB_ADMIN_TOKEN is not set — the admin surface will answer 503");
}
if (!hub.store.hasKey()) {
  console.warn("[hub] no signing key yet — run `npm run keygen`; keyed endpoints will reject everything");
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[hub] ${sig} — shutting down`);
    hub.close().then(() => process.exit(0), () => process.exit(1));
  });
}
