#!/usr/bin/env node
// Gate test: extract the REAL cleanup functions from mac-ops.mjs and run
// cleanupOne("derived_data") with $HOME as a symlink (home-link -> home-real).
// This reproduces the exact macOS /var -> /private/var bug: the allowed root
// is only known by its symlink name, so the old gate (unresolved prefix)
// refuses, and the patched gate (realpath'd root) accepts and deletes.
import { readFileSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

const TC = join(tmpdir(), "gate-test-" + process.pid);
rmSync(TC, { recursive: true, force: true });
const HOME_LINK = join(TC, "home-link");
const HOME_REAL = join(TC, "home-real");
mkdirSync(join(HOME_REAL, "Library/Developer/Xcode/DerivedData/Driver-abc"), { recursive: true });
writeFileSync(join(HOME_REAL, "Library/Developer/Xcode/DerivedData/Driver-abc/blob.bin"), "x".repeat(1024));
symlinkSync(HOME_REAL, HOME_LINK);

// extract the real function bodies from the source file
const src = readFileSync(new URL("../mac-ops.mjs", import.meta.url), "utf8");
const start = src.indexOf("function derivedDataPath");
const end = src.indexOf("function toolXcodeCleanup");
if (start < 0 || end < 0) throw new Error("slice anchors not found");
const body = src.slice(start, end);

const logStderr = (m) => console.error("[stderr-stub]", m);
const audit = () => {};

const gate = new Function(
  "spawnSync", "isAbsolute", "join", "existsSync", "realpathSync",
  "lstatSync", "homedir", "logStderr", "audit", "HOME",
  body + "\nreturn { resolveTarget, cleanupOne };"
)(spawnSync, isAbsolute, join, existsSync, realpathSync, lstatSync, () => HOME_LINK, logStderr, audit, HOME_LINK);

const target = gate.resolveTarget("derived_data");
console.log("resolveTarget     ->", JSON.stringify(target));

const real = realpathSync(target.path);
const oldCheck = real.startsWith(target.allowedRoot + "/") || real === target.allowedRoot;
console.log("real path         ->", real);
console.log("OLD gate (unresolved root) would accept:", oldCheck, "(bug reproduced if false)");

const result = gate.cleanupOne("derived_data");
console.log("NEW cleanupOne    ->", JSON.stringify(result, null, 1));
if (!oldCheck) {
  console.log("note: old gate would have REFUSED this target — bug reproduced");
}
if (result.state !== "deleted") {
  console.error("GATE TEST FAILED: expected deleted");
  process.exit(1);
}
console.log("GATE TEST PASSED: patched gate accepts symlinked root, dir deleted:",
  !existsSync(target.path));
