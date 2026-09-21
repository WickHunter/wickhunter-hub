# Go lease after a server move — 2026-09-21

The affected Beta 0.90.127 installation was initially using a licence whose
Go activation belonged to a different install. Releasing the legacy check-in
seat let the intended install clear its local revoked marker, but did not
release the separate signed Go activation. Repeated activate challenges
continued without a successful activation for the intended install.

The owner issued a replacement licence. Hub audit confirms a new signed Go
activation for the intended install at 2026-09-21T19:38:31.194Z. The displayed
Activity screenshot showed entries from before the replacement. Hub check-in
success and lease issuance do not prove that the customer worker accepted
the lease. Fresh customer runtime evidence is still needed if errors recur;
no customer VPS access was performed.

Hub 0.4.46 renames the action to Release check-in seat and explains its scope
before confirmation. The result reports bound install IDs, recovery lock,
unbound state, or unavailable audit state. It preserves machine-bound proof,
seat limits and recovery locks. Unknown licence IDs are rejected. Failed
requests retain their error rather than immediately clearing it on refresh.

The real HTTP regression reproduces the wrong-server activation, refused
second install, legacy seat release, continued Go refusal, and successful
replacement licence activation. Further cases cover admin recovery locks,
unknown IDs, and a corrupt committed audit record. All 63 Hub suites passed
with Bash 5 on PATH and LIQHUNTER_BOT_MODULE pointing at the compiled app.

No customer release artifact or channel manifest is changed by this fix.
