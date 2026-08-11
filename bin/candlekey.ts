// bin/candlekey.ts
// Print the candle-seed signing key's PUBLIC half — the string to paste into
// the bot's OLB_SEED_KEYS.
//
//   npm run candlekey
//
// Generates the key on first run (data/candle-signing.key, mode 600) and prints
// the same value on every run after that: it is generated once and never
// rotated by this command. The PRIVATE half is written to disk and NEVER
// printed, exactly as in keygen.ts.
//
// The hub prints this at startup and shows it on the admin Exchanges panel too;
// this is for when you are on the box with a shell and do not want either.
import { CANDLE_KEY_ID, CandleKeyStore, candleKeyBanner } from "../src/candles/key.js";
import { configFromEnv } from "../src/config.js";

const cfg = configFromEnv();
const ks = new CandleKeyStore(cfg.dataDir);
const existed = ks.hasKey();
const pub = ks.publicKeyRawB64u();

if (!existed) console.log(`Generated ${ks.keyFile} (mode 600). Back it up; never share it.`);
console.log(candleKeyBanner(pub, cfg.candleSigner, cfg.candleKeyId).replace(/^\[hub\] ?/gm, ""));
console.log("");
console.log(`Bot map entry:  ${CANDLE_KEY_ID} -> ${pub}`);
