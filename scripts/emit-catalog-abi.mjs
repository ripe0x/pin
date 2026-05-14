#!/usr/bin/env node
/**
 * Extract the Catalog ABI from forge build artifacts and write
 * it as a TypeScript module under packages/abi/src.
 *
 * Run after any change to Catalog.sol:
 *   cd contracts && forge build
 *   node scripts/emit-catalog-abi.mjs
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const artifactPath = resolve(
  repoRoot,
  "contracts/out/Catalog.sol/Catalog.json",
)
const json = JSON.parse(readFileSync(artifactPath, "utf8"))
const abi = json.abi

const outPath = resolve(repoRoot, "packages/abi/src/catalog.ts")
const body = `// Auto-extracted from contracts/out/Catalog.sol/Catalog.json.
// Re-run: node scripts/emit-catalog-abi.mjs
export const catalogAbi = ${JSON.stringify(abi, null, 2)} as const
`
writeFileSync(outPath, body)
console.log(`Wrote ${outPath} (${abi.length} items)`)
