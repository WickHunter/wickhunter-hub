// src/version.ts
// Single source of truth for the hub's version string.
//
// v0.2.7 — "keep in lockstep with package.json" was a COMMENT, and comments do
// not fail builds. It drifted for five releases (0.2.2 through 0.2.6 shipped
// while this said 0.2.1), so the admin page and GET /api/health both reported a
// hub that had not run for hours. `install-hub.sh` compares the served version
// against package.json and DID refuse — but the Upgrade button runs it detached
// into data/upgrade.log, so the refusal was written where nobody looks while
// the restart had already succeeded. The suite now pins the two together; a
// comment is no longer what holds this.
export const HUB_VERSION = "0.4.8";
