/** Deployment-owned commerce fields are preserved in their existing role only.
 * They are never editable through the Hub operator-input schema or copied into
 * its masked snapshot/state. Keep this allowlist explicit. */
export const MARKETPLACE_DEPLOYMENT_FIELDS = {
  common: ["STRIPE_COMMERCE_SECRET_KEY", "STRIPE_COMMERCE_WEBHOOK_SECRET", "STRIPE_COMMERCE_CURRENCY", "STRIPE_COMMERCE_SUCCESS_URL", "STRIPE_COMMERCE_CANCEL_URL"],
  api: ["STRIPE_COMMERCE_WEBHOOK_SECRET"],
} as const;

export function preservedDeploymentEnv(role: keyof typeof MARKETPLACE_DEPLOYMENT_FIELDS, existing: ReadonlyMap<string, string>): Buffer {
  const lines: string[] = [];
  for (const name of MARKETPLACE_DEPLOYMENT_FIELDS[role]) {
    const value = existing.get(name);
    if (value === undefined) continue;
    if (/[\0\r\n]/.test(value)) throw new Error("Invalid deployment-managed field");
    lines.push(`${name}=${JSON.stringify(value)}\n`);
  }
  return Buffer.from(lines.join(""));
}
