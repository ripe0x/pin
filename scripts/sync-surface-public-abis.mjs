#!/usr/bin/env node
/**
 * Sync the Surface-related ABI JSON snapshots under apps/web/public/abis/
 * from the checked-in @pin/abi exports (packages/abi/src), independent of
 * the full docs generator (scripts/generate-docs.ts).
 *
 * These files are served at pnd.ripe.wtf/abis/<Name>.json for integrators
 * and agents (see apps/web/public/llms.txt). Normally scripts/generate-docs.ts
 * writes this directory as a side effect of building the full reference
 * site, but that generator's strict ABI/prose cross-check fails post-
 * thin-token-rearchitecture until docs/reference/_prose/{Surface,
 * SurfaceFactory}.md are rewritten and FixedPriceMinter gets its own prose
 * (see the note in generate-docs.ts's ABI_BY_NAME). This script covers just
 * the ABI-copy half of that job for the contracts this rearchitecture
 * touched, so the public snapshots don't go stale in the interim.
 *
 * Run after `cd contracts && forge build && node scripts/emit-surface-abi.mjs`.
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const publicAbiDir = resolve(repoRoot, "apps/web/public/abis");

function readAbiExport(relPath, exportName) {
  const src = readFileSync(resolve(repoRoot, relPath), "utf8");
  // Strip the "export const <name> = " prefix and trailing " as const;" so
  // the remaining text is a bare JSON array, matching the format these
  // public snapshots have always used (see generate-docs.ts's own
  // `JSON.stringify(abi, null, 2)` writer).
  const marker = `export const ${exportName} = `;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${exportName} not found in ${relPath}`);
  let body = src.slice(start + marker.length).trim();
  if (body.endsWith(";")) body = body.slice(0, -1);
  if (body.endsWith("as const")) body = body.slice(0, -"as const".length).trim();
  const abi = JSON.parse(body);
  return JSON.stringify(abi, null, 2) + "\n";
}

function write(name, relPath, exportName) {
  const out = resolve(publicAbiDir, `${name}.json`);
  writeFileSync(out, readAbiExport(relPath, exportName));
  console.log(`Wrote ${out}`);
}

write("Surface", "packages/abi/src/surface.ts", "surfaceAbi");
write("SurfaceFactory", "packages/abi/src/surfaceFactory.ts", "surfaceFactoryAbi");
write("ISurfaceView", "packages/abi/src/iSurfaceView.ts", "iSurfaceViewAbi");
write("FixedPriceMinter", "packages/abi/src/fixedPriceMinter.ts", "fixedPriceMinterAbi");

// Hooks + the mint-hook interface are deleted contracts (thin-token
// rearchitecture): the mint-hook slot no longer exists on the token, and
// allowlist + per-wallet-cap gating moved into FixedPriceMinter's own
// config. Remove their stale public snapshots rather than serve ABIs for
// contracts that no longer exist.
for (const stale of ["AllowlistHook", "PerWalletCapHook", "HoldsSurfaceHook", "GateHook", "IMintHook"]) {
  const p = resolve(publicAbiDir, `${stale}.json`);
  if (existsSync(p)) {
    rmSync(p);
    console.log(`Removed ${p}`);
  }
}
