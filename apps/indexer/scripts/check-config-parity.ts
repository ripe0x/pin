/**
 * Run with: npx tsx scripts/check-config-parity.ts (from apps/indexer).
 *
 * Proves that adding sepolia-only mode (PONDER_CHAIN_ID=11155111, see
 * ponder.config.ts) did not change the config apps/indexer/
 * ponder.config.ts itself produces in production mode (PONDER_CHAIN_ID
 * unset). Compares the current apps/indexer/ponder.config.ts against
 * the pre-change version of that same file fetched from origin/main via
 * `git show`, both imported under the same (unset) env, so any
 * accidental production-mode behavior change in ponder.config.ts
 * surfaces as a diff.
 *
 * Only ponder.config.ts's own content is swapped: the baseline copy is
 * written next to the real file (apps/indexer/ponder.config.baseline.
 * gen.ts), so its relative imports (`./abis/...`,
 * `./src/surfaceV2Deployment`) resolve to the CURRENT worktree's abis/
 * and src/ files on both sides, not to origin/main's versions of those
 * files. This check does not cover changes to the abi modules or
 * surfaceV2Deployment.ts themselves.
 *
 * Uses tsx, not the plain node loader: ponder.config.ts's imports
 * (`./abis/...`, `./src/surfaceV2Deployment`) are extensionless, which
 * only tsx's/ponder's own bundler-style resolution handles; node's
 * native --experimental-strip-types requires explicit extensions.
 *
 * `rpc` fields hold a viem Transport function, dropped by JSON.stringify
 * on both sides (functions serialize to `undefined`), so the comparison
 * is over `chains`/`contracts` data only, exactly what Ponder's build
 * step actually reads (ABI, address, startBlock, chain).
 */
import { execFileSync } from "node:child_process"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const indexerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const baselinePath = resolve(indexerDir, "ponder.config.baseline.gen.ts")

async function main() {
  process.env.PONDER_RPC_URL_1 ??= "http://localhost:1"
  delete process.env.PONDER_CHAIN_ID

  const baselineSource = execFileSync(
    "git",
    ["show", "origin/main:apps/indexer/ponder.config.ts"],
    { cwd: indexerDir, encoding: "utf8" },
  )
  writeFileSync(baselinePath, baselineSource)

  try {
    const [current, baseline] = await Promise.all([
      import(resolve(indexerDir, "ponder.config.ts")),
      import(baselinePath),
    ])

    const strip = (config: { chains: unknown; contracts: unknown }) =>
      JSON.parse(JSON.stringify({ chains: config.chains, contracts: config.contracts }))

    const currentData = strip(current.default)
    const baselineData = strip(baseline.default)

    assert.deepStrictEqual(
      currentData,
      baselineData,
      "mainnet-mode ponder.config.ts output changed from origin/main",
    )

    console.log(
      "OK: apps/indexer/ponder.config.ts in mainnet mode (PONDER_CHAIN_ID unset) " +
        "is deep-equal to origin/main's ponder.config.ts, both resolving " +
        "./abis and ./src/surfaceV2Deployment from the current worktree.",
    )
  } finally {
    if (existsSync(baselinePath)) rmSync(baselinePath)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
