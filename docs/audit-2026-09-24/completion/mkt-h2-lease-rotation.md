# MKT-H2 — Hub lease audit ledger ceiling

Disposition: **fixed in Hub source; not deployed**.

The original lease writer refused every new mutation once its single JSONL file reached 128 MiB. The writer now rotates the active file at 64 MiB, or earlier when its next signed event would hit the 128 MiB active-file ceiling. Archived files are immutable, consecutively numbered v1 JSONL segments. Replay verifies one continuous signed hash chain across every segment and compares the total count and final hash with the existing independently signed head. It retains all activation, spent nonce, seat override, and recovery-lock events; there is no lossy state checkpoint or re-created ledger origin.

Rotation holds the existing writer lock. It durably renames the complete active segment, syncs its directory, and creates an empty active file. If the process stops after the rename, startup first verifies the archived chain against the signed head, then recreates the empty active file. Missing, edited, or out-of-sequence archives still fail closed. No pre-existing single-file ledger migration is required: the first rotation simply gives it segment 00000001.

Evidence: `src/license-leases.ts` segment discovery, `readLines`, `replay`, and `appendEvent`; `tests/license-leases.test.mjs` multiple rotations/restart, retained sequence/nonce/seat/recovery policy, injected crash after archive rename, and archive deletion/edit refusal. Build and lease/seat/HTTP focused tests pass.

Residual limitation: all signed history is intentionally retained and replayed. Total disk and cold-start replay work therefore grow with history; the change removes the single active-file outage without claiming bounded lifetime storage. Operators must back up the signed head, keyring, active file, and every numbered segment together. A future compact snapshot format would need its own signed continuity proof and crash-safe migration.
