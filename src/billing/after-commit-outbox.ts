/** Durable handoff between a committed billing event and the idempotent Earn
 * hook. The event is staged BEFORE billing applies it; only a committed
 * billing seen marker promotes it. A crash on either side of that marker can
 * therefore be recovered without treating an unapplied event as paid. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { StripeEvent } from "./stripe.js";

type Pending = { version: 1; event: StripeEvent; committed: boolean; stagedAtMs: number };
const MAX_PENDING = 2_048;
const MAX_BYTES = 64 * 1024 * 1024;

export class AfterCommitOutbox {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "billing-earn-outbox.v1");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  private file(id: string): string {
    return path.join(this.dir, createHash("sha256").update(id).digest("hex") + ".json");
  }
  private syncDir(): void {
    const fd = fs.openSync(this.dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  private write(file: string, row: Pending): void {
    const tmp = `${file}.tmp.${process.pid}`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(row) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    this.syncDir();
  }
  private read(file: string): Pending {
    const row = JSON.parse(fs.readFileSync(file, "utf8")) as Pending;
    if (!row || row.version !== 1 || !row.event || typeof row.event.id !== "string"
      || !/^evt_[A-Za-z0-9_-]{1,200}$/.test(row.event.id)
      || this.file(row.event.id) !== file || typeof row.committed !== "boolean"
      || typeof row.stagedAtMs !== "number") throw new Error("invalid Earn outbox row");
    return row;
  }
  stage(event: StripeEvent, now: number): void {
    if (!/^evt_[A-Za-z0-9_-]{1,200}$/.test(event.id)) throw new Error("invalid Stripe event id for Earn outbox");
    const file = this.file(event.id);
    if (fs.existsSync(file)) {
      const prior = this.read(file);
      if (JSON.stringify(prior.event) !== JSON.stringify(event)) throw new Error("Stripe event id changed its Earn outbox payload");
      return;
    }
    const names = fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    if (names.length >= MAX_PENDING) throw new Error("Earn outbox is full; retry webhook after operator repair");
    let bytes = 0;
    for (const name of names) bytes += fs.statSync(path.join(this.dir, name)).size;
    if (bytes + Buffer.byteLength(JSON.stringify(event)) > MAX_BYTES) throw new Error("Earn outbox byte limit reached; retry webhook after operator repair");
    this.write(file, { version: 1, event, committed: false, stagedAtMs: now });
  }
  commit(id: string): void {
    const file = this.file(id);
    const row = this.read(file);
    if (!row.committed) this.write(file, { ...row, committed: true });
  }
  pending(): Pending[] {
    return fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"))
      .map((name) => this.read(path.join(this.dir, name)))
      .sort((a, b) => a.stagedAtMs - b.stagedAtMs || a.event.id.localeCompare(b.event.id));
  }
  complete(id: string): void {
    const file = this.file(id);
    fs.unlinkSync(file);
    this.syncDir();
  }
}
