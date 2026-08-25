// src/main.ts
// Process entrypoint: config from env, one hub, clean SIGTERM. That's all —
// the systemd unit owns restarts, nginx owns the public side.
import { candleKeyBanner } from "./candles/key.js";
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
if (hub.licenseLeases) {
  const keys = hub.licenseLeases.keyStore.publicKeyring();
  console.log(`[hub] machine-lease signing key "${hub.licenseLeases.keyStore.activeKeyId}" — PUBLIC key, pin before client rollout:`);
  console.log(`[hub]   ${keys.keys[hub.licenseLeases.keyStore.activeKeyId]?.publicKey ?? "(missing)"}`);
} else {
  console.warn("[hub] machine-bound lease issuance is disabled; legacy LHK1/check-in remains available");
}
// The dedicated candle key, printed ONCE per start. Reading its public half is
// what generates the key on a hub that has never had one, so the operator can
// complete rollout step (b) without running anything. PUBLIC material only —
// the private half is never printed, here or anywhere.
try {
  console.log(candleKeyBanner(hub.candleKey.publicKeyRawB64u(), cfg.candleSigner, cfg.candleKeyId));
} catch (err) {
  console.warn(`[hub] could not read the candle signing key: ${(err as Error).message}`);
}

// The market-cap snapshot's signing key, PUBLIC half, printed once per start —
// for the same reason the candle key is: a client has to pin it BY keyId, and a
// snapshot signed by a key nobody wrote down verifies nowhere while looking
// perfectly healthy from this side. Public material only.
if (hub.marketCaps) {
  const pub = hub.marketCaps.publicKey();
  console.log(`[hub] market-cap snapshot signing key "${cfg.marketCap?.signingKeyId}" — PUBLIC key, safe to copy:`);
  console.log(`[hub]   ${pub ?? "(unreadable — the producer will not start)"}`);
} else if (cfg.marketCap?.venues.length) {
  console.warn("[hub] the market-cap producer is configured but not running — see the refusal above");
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[hub] ${sig} — shutting down`);
    hub.close().then(() => process.exit(0), () => process.exit(1));
  });
}
