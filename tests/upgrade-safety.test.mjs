import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import { upgradeRefusal } from "../dist/src/upgrade-safety.js";

const installedCommit = "a".repeat(40);
const targetCommit = "b".repeat(40);

await test("automatic Hub upgrades refuse a lower origin/main version", () => {
  assert.match(upgradeRefusal("0.4.75", "0.4.75", "0.4.41", installedCommit, targetCommit, true), /older than running.*downgrade refused/);
});

await test("same-version and newer upgrades require proven ancestry from the running build", () => {
  assert.match(upgradeRefusal("0.4.75", "0.4.75", "0.4.75", installedCommit, targetCommit, false), /not verifiably based/);
  assert.equal(upgradeRefusal("0.4.75", "0.4.75", "0.4.75", installedCommit, installedCommit, true), null);
  assert.equal(upgradeRefusal("0.4.75", "0.4.75", "0.4.76", installedCommit, targetCommit, true), null);
});

await test("unrecorded runtime commits and invalid package versions fail closed", () => {
  assert.match(upgradeRefusal("0.4.75", "0.4.75", "0.4.76", null, targetCommit, true), /not verifiably based/);
  assert.match(upgradeRefusal("0.4.75", "0.4.74", "0.4.76", installedCommit, targetCommit, true), /record does not match/);
  assert.match(upgradeRefusal("0.4.75", "0.4.75", "dev", installedCommit, targetCommit, true), /could not be verified/);
  assert.match(upgradeRefusal("0.4.75", "0.4.75", "0.4.75-rc.01", installedCommit, targetCommit, true), /could not be verified/);
});

await test("Hub version ordering follows prerelease precedence", () => {
  assert.match(upgradeRefusal("0.4.75", "0.4.75", "0.4.75-rc.1", installedCommit, targetCommit, true), /older than running/);
  assert.equal(upgradeRefusal("0.4.75-rc.1", "0.4.75-rc.1", "0.4.75", installedCommit, targetCommit, true), null);
  assert.match(upgradeRefusal("0.4.75", "0.4.75", "0.4.75-rc.999999999999999999999999999999", installedCommit, targetCommit, true), /older than running/);
});

summary("upgrade-safety");
