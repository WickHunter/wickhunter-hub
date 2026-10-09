# Linux qualification — Hub 0.4.91 at `6c01ff4` (2026-10-09)

Final source-specific Linux qualification of the billing-only correction, run on a clean worktree at
`6c01ff4504464c2b22e3bead753c3828f518e253` (branch `claude/hub-billing-review`, base = deployed 0.4.90 `b24234c7`).
Under `src/` this commit is byte-identical to the reviewed correction `8ac142d3` (PR #82 head); the two commits
on top add only tests, scripts and docs.

| Step | Result |
|---|---|
| `npm ci` | ok |
| `npm run build` (tsc) | exit 0 |
| `npm test` (tests/run-all.mjs, auto-discovered) | **all 110 suites passed**, exit 0 |
| `python3 scripts/deploy-hub-0491.py --self-test` | **13 passed, 0 failed** |
| Started / finished (UTC) | 17:29:05 / 17:31:57 |
| Runner | Linux 6.18.44 x86_64, Node v22.22.0, npm 10.9.4, Python 3.13.16, 4 CPU, 16 GiB |

Evidence: `linux-qualification-6c01ff4.json` (the `--qualification` file for the operator; sha256 of the logs inside),
`evidence/linux-qualification-final-6c01ff4.log` (full output), `evidence/linux-qualification-baseline-8ac142d.log`.

## Preserved baseline failure (8ac142d3, before any change here)

`2/109 suites FAILED` — both qualification-only, neither a product defect:

1. `server.test.mjs` — "the newest changelog entry must name this version: '0.4.90' !== '0.4.91'". The test parses the
   `## Changelog` bullet list, not the prose heading OpenAI added at the top of README.md. This is the same failure the
   OpenAI R2 run (109/110) recorded. Fixed by adding the `- v0.4.91 —` bullet.
2. `installer-rerun-safety.test.mjs` — "NODE_OPTIONS preloads are not allowed for verified installation". The fixture
   spread `process.env` into the installer under test; this runner carries `NODE_OPTIONS=--max-old-space-size=8192`
   and `templates/install.sh` refuses any preload by design. Fixed by omitting the harness variable from the fixture's
   base env; the suite's own explicit preload cases are unchanged.

An interim run on the reviewed working tree (8ac142d3 + review tests, before the operator was added) also passed
all 110 suites.

## What this does and does not claim

* Claims: the final source compiles and every suite passes on Linux; the operator's decision functions and file
  handling pass their self-test against a fake install and fake systemd.
* Does not claim: any live preflight, stop, deploy or health on the hub box; customer-size capacity; that the
  billing correction has seen live Stripe traffic.
