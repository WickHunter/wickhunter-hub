# Subscription deadlines and licence check-in — code-level recheck (2026-10-09)

Scope: a read-only verification of (a) how a paid period becomes a licence
expiry on the Hub, (b) how a running App installs a Hub-side expiry change,
(c) whether hub commit `8ac142d` (package 0.4.91, **not deployed** — the live
Hub is 0.4.90 at `b24234c7`) closes the recurrence path behind the nine
hand-repaired deadlines, and (d) any remaining way a paid customer could
still end up with a shorter-than-paid deadline. Section 6 is the exact
read-only recheck procedure for the operator on the Hub box.

Evidence anchors are `file:line` in **wickhunter-hub @ 8ac142d** (hub) and
**liqhunter-private @ 66bc57d2 / published Beta 0.90.180** (app). The customer
fleet is on App 0.90.135 (commit `9e595bd3`); every app claim below was
re-checked against that commit as well as HEAD.

Nothing on the live Hub box or its admin API was reachable from this
session; everything here is from source, the two repos' own tests, and one
hermetic reproduction run against a scratch build of 8ac142d (section 4.9).

---

## 1. How a paid period becomes `exp` (hub)

The licence registry (`data/licenses.json`, `src/license.ts`) holds one
signed payload per licence; `exp` is **inside the signed LHK1 token**, so a
registry change is inert on a customer's box until a re-minted token reaches
it (section 2). Everything below writes the registry only through
`LicenseStore.setExpiry` (`src/license.ts:292`) or `issueUntil`.

| Stripe event | Handler | What `exp` becomes | Anchor |
| --- | --- | --- | --- |
| `checkout.session.completed` (subscription) | `onSubscriptionCheckout` | **bootstrap grant**: `max(now + policy.bootstrapDays·day, launchIntent.firstPaymentAtMs ?? 0)`; the customer record is created with `periodEndMs: null` | `src/billing/service.ts:1237-1243`, `:1493-1548` |
| `invoice.paid` / `invoice.payment_succeeded` | `onInvoicePaid` | `paidThrough = latest line period.end + policy.graceDays·day` → `extendLicense` (forward only); `rec.periodEndMs = period.end`; status `active` | `:1293-1329`, `:1299` |
| `customer.subscription.updated` (active/trialing) | `onSubscriptionUpdated` | `current_period_end + graceDays·day` → `extendLicense`; `periodEndMs` moved forward | `:1342-1359` |
| `invoice.payment_failed` | `onInvoiceFailed` | status `past_due` only; **exp untouched** | `:1331-1340` |
| `customer.subscription.deleted` | `onSubscriptionDeleted` | status `canceled` only; licence runs to paid-through + grace, then exit-only | `:1361-1370` |
| `charge.refunded` (full) / `charge.dispute.created` | `onRefund` / `onDispute` | **revoked** when `revokeOnRefund` / `revokeOnDispute` (default true); partial refund untouched | `:1383-1414` |
| one-time (`mode: payment`) incl. Lifetime | `onPaymentCheckout` | `now + oneOffDays` (plan `licenseDays`, Lifetime 3650); `lifetimeAccess = true` on a paid live Lifetime | `:1061-1183`, `:1169` |

Forward-only is structural: `extendLicense` (`:1555-1562`) refuses any target
`<= current.exp`, and caps at `policy.testMaxDays` for **test-mode** licences
only (`capExp`, `:1437-1439`) and at `iat + 3650 d` (the LHK1 format bound).
A revoked licence is never extended.

**The three-day grace.** `policy.graceDays` is an operator setting in
`data/billing-config.v1.json` (`src/billing/config.ts:116`, default **7** at
`:152-160`, README "Policy" also says 7). The handoff and the incident note
both say the live box runs **3**. The recheck must read the box's value
(section 6.2) — do not assume either number.

**The stale-event guard** exists only on the hosted-bundle path.
`applyBundleEvent` (`:613`) keeps a per-subscription watermark
`latestEventCreatedMs` (`:692`) and refuses any ordering-relevant event whose
Stripe `created` is older (`stale`, `:635-636`). Software-only subscriptions
(payment-link and launch-without-VPS) never pass through it; for them
`onInvoicePaid` is order-independent by construction, which is why the
incident was hosted-bundle only.

**The manual repair endpoint.** `POST /admin/api/licenses/expiry {id, exp}`
(`src/server.ts:3040-3058`) → `LicenseStore.setExpiry` (`src/license.ts:292`):
rewrites `exp` in the pinned key order, keeps `iat`, refuses a revoked id,
bounds at `iat + 3650 d`, and answers the re-minted install command. It does
**not** touch `billing-customers.v1.json` — so the nine repaired customers
still carry `periodEndMs: null` and `lastEventType: checkout.session.*`
(consequences in sections 3 and 6). `POST /admin/api/licenses/extend {exp}` /
`npm run extend -- --to YYYY-MM-DD` is the fleet-wide variant (`extendAll`,
`src/license.ts:350`), never shortening.

---

## 2. The ordinary check-in path — verdict: **confirmed, no new App beta needed**

### Hub side (`src/server.ts:1129-1256`)

1. `POST /api/license/checkin` body `{licenseId, installId, version, ts, token}`.
2. The presented token is decoded with `store.decodeGenuine` (signature +
   shape, **expiry deliberately ignored**, `src/license.ts:233`); a missing
   or non-matching token is a 401 (`:1158-1164`). So a lapsed install still
   authenticates and can be renewed.
3. `recordCheckin` writes `data/checkins.jsonl` and `data/roster.json`
   (`src/checkins.ts:29-57`).
4. Seat admission (`src/seats.ts`): a second live install of the same licence
   is answered `revoked:true` (exit-only on **that** install only).
5. `billing.refreshLifetimeLicense(id)` rolls a live Lifetime token forward
   when within 365 days of its technical expiry (`service.ts:2100-2106`,
   `license.ts:315`).
6. **Renewal decision** (`server.ts:1236-1242`): if not revoked and
   `store.get(id).exp > presented.exp` (strictly later), the reply carries
   `{token: store.tokenFor(id), exp}`. `store.get` re-reads `licenses.json`
   on every call, so an admin `setExpiry` or a webhook extension is visible
   to the very next check-in.

### App side (`src/license.ts`)

- `runLicenseCheckin` (`:643-725`) sends `token: readLicenseToken()`
  (`:667`) — present since v0.90.3. **Verified at the fleet build**:
  `git show 9e595bd3:src/license.ts` line 628 carries the same body, and
  line 20254 of its `src/server/index.ts` carries the same cadence line as
  HEAD. 0.90.136 (`8e69e9e2`) likewise.
- `acceptRenewedLicense` (`:454-465`): installs only a token that verifies
  against the **same pinned public key**, names the **same id**, and expires
  **strictly later**; otherwise refused by name and nothing changes. On
  install it goes through the same `setLicenseToken` the paste route uses
  (`:709`), the status cache is invalidated, and the Activity log / notifier
  get "Licence extended — now valid until …" (`:713-715`;
  `src/server/index.ts:20962-20966`).
- An **expired** token still carries `id` and `expiresAt`
  (`licenseStatus`, `:304-343`, `expired = !(exp > now)` at `:321`), so a
  lapsed install keeps checking in and recovers on the first reply that
  carries a later key. A revocation marker (seat refusal) is cleared the same
  way (`:700`).

### Cadence and worst-case delay (`src/server/index.ts:20968-20998`)

| Build | Boot | Interval | Worst case for a registry change to be installed |
| --- | --- | --- | --- |
| Beta / customer (`USER_BUILD` flipped to `true` by `scripts/build-user.mjs:383`, so `selfUpdateActive()` is true, `src/self-update.ts:120`) | 60 s after start | **5 min** (`:20987`) | ≈ 5 min + the 10 s request timeout; one extra interval if that attempt fails (network, 5xx, malformed) |
| Alpha / operator | 60 s | **24 h** | up to 24 h (the v0.90.81 lesson) |

The hub's per-licence check-in limiter (12/min) is irrelevant at this
cadence. A check-in failure of any kind changes nothing on the box (fail-open
for the licence, by contract at `:643-657`).

### The lease (WHL1) follows the token, bounded

The wh-core lease is capped at `min(presented LHK1 exp, registry exp)` when
the lease is issued/renewed (`src/license-leases.ts:1270-1276`) and
`expiresAtMs = min(license.exp, now + 6 h)`, `refreshAfterMs = min(expiresAtMs,
now + 3 h)`, `cachedGraceUntilMs = min(license.exp, expiresAtMs + 72 h)`
(`:1385-1407`). The app renews on its own 5-minute timer
(`LEASE_REFRESH_TIMER_MS`, `src/license-lease.ts:704`, wired at
`index.ts:20998`) once `now >= refreshAfterMs` (`planLeaseAction`, `:448-458`),
and `runLicenseCheckinAndLease` runs the check-in first so the renewal
presents the new token (`:898-903`). Consequences:

- Ordinary renewal (registry extended while the old token still has > 6 h
  left): the lease is never short — it renews within 3 h carrying the new
  entitlement, and the old entitlement had not lapsed.
- Late renewal (registry extended **after** the old token lapsed): the token
  is replaced within ≤ 5 min and the lease on the next ≤ 5 min tick, so
  wh-core refuses new exposure for at most ~10 min after the hub-side change.
  On the Beta artifact native-core authority is forced on, so this is the
  effective window.

---

## 3. The recurrence path and 8ac142d — verdict: **closed for new customers after deployment; cannot re-touch the nine**

### The defect (as it still exists on the deployed 0.4.90)

`git show b24234c7:src/billing/service.ts:640-641`: with the bundle watermark
advanced by the newer `checkout.session.completed`, the older
`subscription_create` `invoice.paid` is `stale` and the only exceptions were
`activatingBehindFailure` and `lifetimeInitialPaid` → `"older bundle
lifecycle event ignored"`. The customer kept the bootstrap grant
(`now + bootstrapDays`, or exactly `firstPaymentAtMs` for a launch customer —
see 4.7) and `periodEndMs: null`. Stripe's `created` for a checkout session
is routinely a few seconds later than its initial invoice, so delivery order
decided the outcome.

### The fix, two commits

- `41c012a` — `initialPaidAfterCheckout` (`service.ts:645-654`): admits a
  stale `invoice.paid`/`invoice.payment_succeeded` only when it is `paid`,
  `billing_reason === "subscription_create"`, carries a period end, the
  bundle is not a Lifetime bundle, no `past_due` is pending, and **both** the
  software record and the hosting record are `active`, checkout-only
  (`lastEventType` starts with `checkout.session.`), have `periodEndMs ===
  null`, and are neither refunded nor disputed.
- `8ac142d` — durability: the admission is persisted as
  `BundleSubscriptionRecord.initialPaidPending {eventSha256,
  checkoutWatermarkMs}` **before** either role changes (`:673-675`,
  `store.ts:158-159`); `resumingInitialPaid` (`:660-671`) lets a retry after a
  crash/500 finish **only the identical event** (sha of the whole event) and
  only while no newer failure/terminal/refund/dispute fence has landed and
  each record is still checkout-only or already stamped with this exact
  event (`lastEventId`, new on both record types). Completion clears the
  pending marker with the final ledger write (`:766`); the watermark never
  moves backwards (`:692`).

Tests at 8ac142d: `tests/hosting-bundle.test.mjs` "checkout delivered before
its older initial paid invoice fills the bootstrap term exactly once" (asserts
`periodEndMs`, hosting `periodEndMs`, `exp = min(end + grace, testMax cap)`,
watermark unchanged, duplicate/alias inert, an old `subscription_cycle`
renewal cannot borrow the exception) and five restart variants that recreate
the whole service from its durable files after injected failures at the
hosting write, the hosting hook and the completion write, with and without a
newer failure/cancellation fence.

### Customers whose event arrived before deployment (the nine)

Nothing in the diff re-derives or rewrites their expiry:

1. Their discarded invoice's event id was marked seen when it was answered
   `200 ignored` (`handleWebhook`: `markSeen` at `service.ts:421` runs for
   every non-throwing outcome). A Stripe retry or dashboard resend of that
   id is answered `duplicate` (`:399-409`) and never reaches `applyEvent`.
2. The admission only fires on a **stale** `subscription_create` invoice. No
   code path synthesises one; the Hub has no "replay" route.
3. Their next real events are renewal `invoice.paid` (`subscription_cycle`)
   and `customer.subscription.updated`, created **after** the checkout
   watermark → not stale → ordinary `onInvoicePaid` / `onSubscriptionUpdated`
   → `extendLicense` forward-only. The hand-set `exp` (reporting
   `currentPeriodEndMs` + 3 d) is strictly earlier than the renewal's
   `period.end + grace`, so it is extended, never lowered; `periodEndMs` is
   populated at that point.
4. `initialPaidPending` is written only at the moment a new stale initial
   invoice is admitted (`:673`), so none of the nine ever acquire it;
   `lastEventId` is additive and written only on a future touch.
5. `setExpiry` left `iat` alone, so `tokenFor` re-mints a token the App
   accepts (same id, later exp); the check-in delivered it (section 2).

Residual facts about the nine (not defects): `periodEndMs` stays `null`
until their first renewal, so `subscriptionInfoFor` (`:2078-2097`) reports
`currentPeriodEndMs: null` on their check-in reply (the App's card reads
the token's own `exp`, not this field), and the admin customers view shows
`periodEndMs: null`. **The recheck in section 6 must therefore compare `exp`
against the Stripe reporting fact, not against `periodEndMs`, for them.**

---

## 4. Remaining ways a paid customer could get a shorter-than-paid deadline

| # | Scenario | Verdict | Evidence |
| --- | --- | --- | --- |
| 4.1 | Renewal `invoice.paid` (`billing_reason: subscription_cycle`) | **Covered.** `onInvoicePaid` extends to `period.end + grace`; bundle path: created after the checkout watermark → never stale. A late-delivered older `invoice.payment_failed` / `subscription.updated` is stale → ignored (bundle) or status-only (software-only). | `service.ts:1293-1329`, `:635-636`; `tests/hosting-bundle.test.mjs` "renew/cancel … together" |
| 4.2 | Lifetime | **Covered.** One-time: `oneOffDays` (plan 3650) and `lifetimeAccess`; technical re-issue at check-in when < 365 d remain. Mixed Lifetime+VPS bundle: `lifetimeInitialPaid` bypasses the stale guard, `skipLifetimeSoftware` keeps VPS renewals/cancellation off the software licence. | `:1061-1183`, `:1169`, `:2100-2106`, `license.ts:315`; `:624`, `:717`; `tests/billing-legacy-lifetime.test.mjs`, `billing-six-plan.test.mjs` |
| 4.3 | Plan change on the same subscription (portal) | **Covered for software-only** (`customer.subscription.updated` extends forward; a proration invoice's `period.end` is the current period end, so nothing shortens). **Hosted bundle: not covered by the bundle ledger** — a price change makes `bundleIdentity` return `null` (`:577`, `observedPriceIds` must include the bound price) and the event falls to the generic role dispatcher; with the hosting allowlist configured it classifies by `roles.software` ids or the `metadata.plan` binding aid, else `unclassified` (recorded, applied to neither role: no extension, no shortening). Watch for `unclassified` in `billing-events` (6.5). Not reproduced; depends on the live roles config. | `:1342-1359`; `:560-582`; `roles.ts:85-94` |
| 4.4 | `past_due` then recovered | **Covered.** Failure records status only; the successful retry's `invoice.paid` is created later → extends; bundle `pendingStatus` clears on a confirmed event; a failed renewal arriving before an older initial invoice is handled by `activatingBehindFailure`. | `:1331-1340`, `:640`, `:693` |
| 4.5 | Refund / dispute | **By policy, not a gap.** Full refund or dispute revokes (`revokeOnRefund`/`revokeOnDispute`, default true); partial refund untouched. A bundle is one charge, so a full refund of it revokes the software licence too (`:746-752`). | `:1383-1414` |
| 4.6 | Grace vs Stripe retries | **Policy observation.** `exp = period.end + graceDays` and the App has **no grace of its own** (`licenseStatus`, app `license.ts:321`), so with `graceDays: 3` a renewal that only succeeds on Stripe's day-4+ retry is exit-only from day 3 until that `invoice.paid` lands plus ≤ 5 min. The default of 7 was chosen to "cover Stripe's payment retries" (`config.ts:114-116`). Operator decision; no code change implied. | `config.ts:114-116`, app `license.ts:321`, `:370-379` |
| 4.7 | Launch cohort (`firstPaymentAtMs` = 2026-10-15 00:00 ET, `billing_cycle_anchor` + `proration_behavior: none`) | **Covered for software-only launch customers** (generic path, order-independent). **Hosted-bundle launch customers were the exact defect population**: the $0 `subscription_create` invoice (period end = anchor) is what carries the grace; if it was discarded, `exp` is **exactly the anchor with no grace** (`onSubscriptionCheckout` extends to `firstPaymentAtMs` bare, `:1241-1243`), and the first real charge is attempted ~1 h after the anchor → exit-only on Oct 15 from 00:00 ET until that `invoice.paid` + ≤ 5 min. The hand audit's "31 eligible" should have caught any such row (`exp < currentPeriodEndMs + grace`); section 6.3 re-checks it explicitly, **including scheduled (future first payment) subscriptions** in case "eligible" excluded them. | `launch.ts:392`, `:1241-1243`, `reporting.ts:209-210` |
| 4.8 | WHL1 lease vs LHK1 token | **Covered, bounded** (section 2): lease entitlement = `min(token exp, registry exp)`; follows a renewed token within ≤ 3 h normally, ≤ 5 min when the old token has lapsed. No offline grace beyond the licence `exp`. | `license-leases.ts:1276`, `:1386`, `:1401-1406` |
| 4.9 | A `charge.succeeded` delivered **between** the newer checkout and the older initial invoice (it is on the README's registered event list, is created at the same instant as the invoice, and is not ordering-relevant, so it can never be `stale`) | **Investigated and refuted.** With a hosting allowlist configured (required to sell any bundle: `hosting/service.ts:215-217` refuses checkout with "managed hosting requires a classified Stripe price"), the charge names nothing the bundle ledger or role index has seen, so `classifyRole` answers `unknown` → `unclassified` → **touches neither record** and the admission still fires. Reproduced against a scratch build of 8ac142d (control, interleaved, and empty-allowlist cases) and pinned as **`tests/claude-deadline-charge-interleave.test.mjs`** (new file; green 3/3). | `service.ts:1372-1381`, `:866-871` (classify) and `:493-496` (unclassified return), `roles.ts:85-94` |
| 4.10 | A `customer.subscription.updated` created **after** the checkout that applies with status `active` but **no period end** would stamp `lastEventType` without setting `periodEndMs` and defeat the admission | **Theoretical only.** An active subscription always carries `current_period_end` (top-level pre-basil, per item on basil), and `subscriptionFacts` reads both (`stripe.ts:232-245`). Noted for completeness; not reproduced, not pinned. | `:1342-1359`, `stripe.ts:232-245` |
| 4.11 | Seat refusal | Not a deadline issue, but the other cause of a paid customer in exit-only: a second live install is answered `revoked:true`; lifts after 30 min of silence from the holder or an admin release. Visible as `[seat] … refused` in the Hub journal and `seat.refused` on `/admin/api/licenses`. | `seats.ts`, `server.ts:1184-1194` |
| 4.12 | Exit-only on lapse (app) | **As designed.** `valid = !revoked && exp > now`; the gate refuses only additive order kinds (`en`, `dca`, `hg`/`hedge`, explicit `additive:true`); closes/TP/SL/protection always pass; USER build only. | app `license.ts:304-343`, `:345-379` |

**No real gap was found.** The one scenario that looked like one (4.9) was
disproved by reproduction. 4.3 (hosted-bundle plan change) and 4.6/4.7 are
the items worth the operator's attention, and 4.7 is directly checkable in
section 6.3.

---

## 5. What 8ac142d does NOT change (so the recheck is not misled)

- No webhook event is re-applied; no expiry is rewritten on deploy.
- `periodEndMs` is not backfilled for anyone.
- Check-in, lease, seat and admin routes are byte-identical to 0.4.90
  (`git diff b24234c7..8ac142d` touches only `src/billing/service.ts`,
  `src/billing/store.ts`, `src/billing/reporting.ts` (a removed Earn
  forecast), `src/server.ts` (that forecast's route field), Earn files and
  tests).

---

## 6. Read-only recheck procedure (operator, on the Hub box)

Credentials you need (not available to this session): shell on the Hub box
with read access to the data directory (default `/opt/wickhunter-hub/data`,
or `HUB_DATA_DIR` from `/etc/wickhunter-hub/env`; owned by `wickhunter-hub`,
so run as that user or root), and `HUB_ADMIN_TOKEN` from the same env file
for the admin-API form. The Hub listens on `HUB_PORT` (default `8091`,
`src/config.ts:187`), normally bound to 127.0.0.1 behind nginx.

Nothing below changes any state except 6.2's optional report refresh, which
rewrites only `data/launch-billing-report.v1.json` (Stripe is read-only).

### 6.1 Confirm which Hub is running

```
grep '"version"' /opt/wickhunter-hub/package.json          # 0.4.90 = fix NOT deployed; 0.4.91 = deployed
systemctl show wickhunter-hub -p ExecMainStartTimestamp -p NRestarts
```

### 6.2 Collect the three inputs

```
ENV=/etc/wickhunter-hub/env; TOKEN=$(sed -n 's/^HUB_ADMIN_TOKEN=//p' $ENV); H=http://127.0.0.1:8091
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/billing/config   | jq '{mode, policy: .policy, rolesLiveHosting: .roles.live.hosting}'
# → policy.graceDays is THE grace (expected 3 on this box; default 7). roles.live.hosting must be non-empty (4.9).
curl -sS -H "x-hub-admin: $TOKEN" -X POST $H/admin/api/billing/report/refresh   # optional: refresh Stripe facts (read-only against Stripe)
sleep 20
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/billing/report     > /tmp/report.json
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/billing/customers  > /tmp/customers.json
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/licenses           > /tmp/licenses.json
```

Healthy shapes:

- `report.json`: `byMode.live.refreshError == null`,
  `unrefreshedSubscriptionCount == 0`, `subscriptions[]` each with
  `status`, `currentPeriodEndMs` (non-null), `cancelAtPeriodEnd`,
  `firstPaymentAtMs`, `updatedAtMs` within the last day. The handoff's
  "34 known live subscriptions" is `knownRecurringSubscriptions`.
- `customers.json`: one row per Stripe customer with `exp` (the registry
  expiry), `periodEndMs`, `subscriptionStatus`, `lastEventType`, `revoked`,
  `refunded`, `disputed`, `livemode`, `lastSeen`.
- `licenses.json`: `licenses[].exp`, `.revoked`, `.lastSeen {version,
  lastSeen, checkins}`, `.seat.refused`.

### 6.3 The short-deadline condition, computed read-only from the data files

Same arithmetic without the admin token — run as root or `wickhunter-hub`
from `/opt/wickhunter-hub`. Reads only; writes nothing.

```
HUB_DATA_DIR=${HUB_DATA_DIR:-/opt/wickhunter-hub/data} node --input-type=module -e '
import fs from "node:fs"; import path from "node:path";
const d = process.env.HUB_DATA_DIR, J = f => JSON.parse(fs.readFileSync(path.join(d,f),"utf8")), DAY = 86400000, now = Date.now();
const lic = J("licenses.json"), rev = J("revoked.json").revoked, cust = J("billing-customers.v1.json"), roster = J("roster.json");
const grace = J("billing-config.v1.json").policy.graceDays * DAY;
const facts = J("launch-billing-report.v1.json").facts.filter(f => f.mode === "live");
let known = 0, eligible = 0, flagged = 0; const rows = [];
for (const c of Object.values(cust)) {
  if (!c.livemode || !c.subscriptionId) continue; known++;
  const l = lic[c.licenseId], revoked = !l || Object.hasOwn(rev, c.licenseId);
  const f = facts.find(x => x.subscriptionId === c.subscriptionId && x.customerId === c.stripeCustomerId);
  const flags = [];
  if (revoked) flags.push("REVOKED"); if (c.refunded) flags.push("REFUNDED"); if (c.disputed) flags.push("DISPUTED"); if (c.lifetimeAccess) flags.push("LIFETIME");
  if (!f) flags.push("NO_FACT"); else if (f.currentPeriodEndMs == null) flags.push("UNKNOWN_PERIOD"); else if (now - f.updatedAtMs > DAY) flags.push("STALE_FACT");
  const active = f && ["active","trialing"].includes(f.status);
  const scheduled = active && f.firstPaymentAtMs && f.firstPaymentAtMs > now;
  const isEligible = !revoked && !c.refunded && !c.disputed && !c.lifetimeAccess && active && f.currentPeriodEndMs != null;
  if (isEligible) {
    eligible++;
    const expected = f.currentPeriodEndMs + grace;
    if (l.exp <= f.currentPeriodEndMs) flags.push("STRICT_SHORT");          // lapses at or before paid-through: fix
    else if (l.exp < expected) flags.push("GRACE_SHORT");                     // lapses inside the grace window: fix to policy
    if (scheduled) flags.push("SCHEDULED_START");
    if (c.periodEndMs === null && String(c.lastEventType).startsWith("checkout.session.")) flags.push("BOOTSTRAP_ONLY(periodEndMs null; expect the hand-repaired nine)");
    if (flags.some(x => x.endsWith("SHORT"))) flagged++;
  }
  const seen = roster[c.licenseId];
  rows.push({ email: c.email, licenseId: c.licenseId, status: f?.status ?? c.subscriptionStatus, paidThrough: f?.currentPeriodEndMs ? new Date(f.currentPeriodEndMs).toISOString() : null,
    exp: l ? new Date(l.exp).toISOString() : null, shortfallDays: isEligible ? +(((f.currentPeriodEndMs + grace) - l.exp) / DAY).toFixed(2) : null,
    lastSeen: seen ? new Date(seen.lastSeen).toISOString() : null, version: seen?.version ?? null, flags: flags.join(",") });
}
console.table(rows.sort((a,b) => (b.shortfallDays ?? -1e9) - (a.shortfallDays ?? -1e9)));
console.log({ knownLive: known, eligible, flaggedShort: flagged, graceDays: grace / DAY, generatedAt: new Date(now).toISOString() });'
```

**Healthy output**: `flaggedShort: 0`; every eligible row has
`shortfallDays <= 0` (negative = the licence runs past paid-through +
grace); no `UNKNOWN_PERIOD`/`NO_FACT` rows (the handoff reported "no unknown
periods"); counts matching the handoff (known 34, eligible 31) unless a
customer joined/left since. `BOOTSTRAP_ONLY` on exactly the nine repaired
rows is expected until their first renewal; `BOOTSTRAP_ONLY` on any **other**
row with `STRICT_SHORT`/`GRACE_SHORT` is a new instance of the defect (a
checkout after the audit whose initial invoice was discarded — the fix is not
deployed) and is the only situation in which the hand repair should be
repeated, via `POST /admin/api/licenses/expiry {id, exp: paidThrough + grace}`.

The condition that constitutes **"a short deadline"**, precisely:
`registry exp < Stripe currentPeriodEndMs + graceDays·day` for a live,
non-revoked, non-refunded, non-disputed, non-Lifetime customer whose Stripe
subscription is `active` or `trialing` (including a scheduled first payment).
`exp <= currentPeriodEndMs` is the severe form (exit-only before the paid term
ends).

### 6.4 Confirm check-ins are landing normally

Hub side (per licence; the ledger is the truth, the roster a cache):

```
npm run list                                  # columns: id name state expires lastSeen version ip  (dist must be built)
tail -n 200 /opt/wickhunter-hub/data/checkins.jsonl | tail -3
# {"licenseId":"<uuid>","installId":"<uuid>","version":"0.90.135","ts":<client ms>,"ip":"<ip>","at":<hub ms>}
LIC=<uuid>; grep "\"licenseId\":\"$LIC\"" /opt/wickhunter-hub/data/checkins.jsonl | tail -13 | node -e '
let p=null;for(const l of require("fs").readFileSync(0,"utf8").trim().split("\n")){const r=JSON.parse(l);console.log(new Date(r.at).toISOString(),r.version,r.installId.slice(0,8),p?((r.at-p)/60000).toFixed(1)+" min":"");p=r.at}'
journalctl -u wickhunter-hub --since -1d | grep '\[seat\]'   # "bound to install" once per install; any "refused" = a second live install, exit-only THERE
```

Healthy: for a Beta install, `lastSeen` (hub clock) within the last ~10 min
and one ledger line roughly every **5.0 min** (±a few seconds; a 1-minute
line right after `ExecMainStartTimestamp` on the customer box is the boot
check-in); `version` = the build the customer runs (0.90.135 fleet, 0.90.180
published); exactly one `installId` per licence in the last 48 h
(`/admin/api/licenses` → `sharing.installs == 1`, `seat.refused == 0`). An
operator/Alpha build checks in once a day — do not read that as a fault.
The Hub writes no per-check-in journal line; absence of `[seat]` lines is
normal.

App side (a customer's box, `journalctl -u wickhunter`; the Beta unit is
`wickhunter`):

- `[license] licence extended by the hub — now valid until YYYY-MM-DD (was YYYY-MM-DD); nothing to install`
  — one line per installed renewal; this is what a repaired or renewed
  deadline looks like landing.
- `[license] the hub offered a replacement key that was REFUSED (…)` —
  **should never appear** (would mean a key signed by another authority or
  naming another id).
- `[lease] observe: lease=allow lhk1=allow …` on change; `lhk1=deny` means
  the token on disk is lapsed/revoked.
- `GET /api/license` (signed-in session) → `expiresAt`, `valid`, `daysLeft`,
  `exitOnly`; `expiresAt` must equal the registry `exp` once a check-in has
  run since the change. Without a session:
  `node -e 'const t=require("fs").readFileSync("/opt/liqhunter/data/license.key","utf8").trim().split(".")[1];console.log(JSON.parse(Buffer.from(t,"base64url")))'`
  prints the token's own `exp` (`data/license.key`, app `license.ts:137`).

### 6.5 Webhook ledger sanity (optional, read-only)

```
curl -sS -H "x-hub-admin: $TOKEN" "$H/admin/api/billing/events?limit=500" | jq -r '.events[] | select(.livemode) | [ (.receivedAtMs|todate), .type, .outcome, (.note // "") ] | @tsv' | head -100
```

Look for: `invoice.paid … ignored — older bundle lifecycle event ignored` on
a `subscription_create` invoice **after** the audit time (a new defect
instance while 0.4.90 is deployed → 6.3 will show it); any `unclassified`
outcome (4.3); `error` outcomes (Stripe retrying); and that renewal
`invoice.paid` rows read `applied … licence extended to YYYY-MM-DD`.

---

## 7. Files touched by this review

- This document.
- `tests/claude-deadline-charge-interleave.test.mjs` (new; pins 4.9; imports
  `./helpers.mjs` and `../dist/…` like every other suite and is picked up by
  `tests/run-all.mjs`'s `*.test.mjs` glob). Proved green against a scratch
  `tsc` build of 8ac142d outside the repo; no existing file in `src/billing/`
  or `tests/` was modified.
