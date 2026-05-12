#!/usr/bin/env node
/**
 * Extract the ArtistRecordRegistry ABI from forge build artifacts and write
 * it as a TypeScript module under packages/abi/src.
 *
 * Run after any change to ArtistRecordRegistry.sol:
 *   cd contracts && forge build
 *   node scripts/emit-record-registry-abi.mjs
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const artifactPath = resolve(
  repoRoot,
  "contracts/out/ArtistRecordRegistry.sol/ArtistRecordRegistry.json",
)
const json = JSON.parse(readFileSync(artifactPath, "utf8"))
const abi = json.abi

const outPath = resolve(repoRoot, "packages/abi/src/artistRecordRegistry.ts")
const body = `// Auto-extracted from contracts/out/ArtistRecordRegistry.sol/ArtistRecordRegistry.json.
// Re-run: node scripts/emit-record-registry-abi.mjs
export const artistRecordRegistryAbi = ${JSON.stringify(abi, null, 2)} as const
`
writeFileSync(outPath, body)
console.log(`Wrote ${outPath} (${abi.length} items)`)
