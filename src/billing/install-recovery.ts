import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "../jsonfile.js";
import type { LicensePayload } from "../license.js";
import type { CustomerRecord } from "./store.js";

export interface InstallRecoveryRecord {
  v: 1; operationId: string; customerKey: string; newLicenseId: string; oldCustomer: CustomerRecord; oldLicense: LicensePayload;
  atMs: number; activationId: string; activationRevision: number; auditRevision: number; cachedGraceUntilMs: number;
  featureOverrides: Record<string, boolean>; installExpiresAtMs?: number; providerMessageId?: string | null; emailSentAtMs?: number;
  phase: "prepared" | "issued" | "retiring" | "retired" | "committed" | "email-prepared" | "sent" | "email-failed";
}
export const recoveryPath = (dir: string, operationId: string): string => path.join(dir,"billing-install-recovery.v1",createHash("sha256").update(operationId).digest("hex")+".json");
export function recoveryRecords(dir: string): InstallRecoveryRecord[] {
  const folder=path.join(dir,"billing-install-recovery.v1");
  if (!fs.existsSync(folder)) return [];
  if(!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink())throw new Error("Unsafe install recovery directory");
  return fs.readdirSync(folder).map(n=>{
    if(!/^[a-f0-9]{64}\.json$/.test(n))throw new Error("Unexpected install recovery journal entry");
    if(!fs.lstatSync(path.join(folder,n)).isFile() || fs.lstatSync(path.join(folder,n)).isSymbolicLink())throw new Error("Unsafe install recovery journal entry");
    const row=readJson<InstallRecoveryRecord|null>(path.join(folder,n),null);
    if (!row || row.v!==1 || typeof row.operationId!=="string" || recoveryPath(dir,row.operationId)!==path.join(folder,n)
      || row.oldCustomer?.key!==row.customerKey || row.oldCustomer.licenseId!==row.oldLicense?.id
      || !/^[A-Za-z0-9_-]{16,128}$/.test(row.operationId) || !/^[a-f0-9-]{36}$/.test(row.newLicenseId) || row.newLicenseId===row.oldLicense.id
      || !Number.isSafeInteger(row.atMs) || !Number.isSafeInteger(row.activationRevision) || row.activationRevision<1 || !Number.isSafeInteger(row.auditRevision)
      || !Number.isSafeInteger(row.cachedGraceUntilMs) || typeof row.activationId!=="string" || !row.activationId
      || !row.featureOverrides || typeof row.featureOverrides!=="object" || Array.isArray(row.featureOverrides) || Object.values(row.featureOverrides).some(v=>typeof v!=="boolean")
      || (row.phase==="sent" && (!Number.isSafeInteger(row.installExpiresAtMs) || !Number.isSafeInteger(row.emailSentAtMs))) || !["prepared","issued","retiring","retired","committed","email-prepared","sent","email-failed"].includes(row.phase))
      throw new Error("Install recovery journal needs support review");
    return row;
  });
}
export function committedRecoveryLicenses(dir: string, rec: CustomerRecord): string[] {
  // Walk backwards from this customer's CURRENT identity. Uncommitted or
  // foreign recovery rows never authorize historical financial receipt IDs.
  const result: string[]=[], rows=recoveryRecords(dir);let current=rec.licenseId;
  for(let i=0;i<=rows.length;i++){
    const matches=rows.filter(r=>r.customerKey===rec.key && r.newLicenseId===current && ["committed","email-prepared","sent","email-failed"].includes(r.phase));
    if(matches.length>1)throw new Error("Ambiguous install recovery lineage");
    if(!matches.length)break;
    const old=matches[0].oldLicense.id;if(result.includes(old)||old===rec.licenseId)throw new Error("Cyclic install recovery lineage");
    result.push(old);current=old;
  }
  return result;
}
