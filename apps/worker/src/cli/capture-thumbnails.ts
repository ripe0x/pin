/**
 * CLI entry for the Surface thumbnail capture tool. One batch run: discover
 * minted tokens on CAPTURE_COLLECTION, render each token's opening frame
 * headlessly, sign + upload to Irys, verify the manifest against the Irys
 * gateway, point RenderAssets at the resulting manifest with its coverage
 * bound, and record provenance to CAPTURE_OUT_DIR. See
 * apps/worker/src/capture/README.md for the full model and
 * apps/worker/src/capture/ for the implementation.
 *
 * Usage: pnpm --filter @pin/worker capture:thumbnails -- [run] [--dry-run]
 *          [--force] [--tokens 1-5]
 *        pnpm --filter @pin/worker capture:thumbnails -- fund <amount-in-eth>
 *        pnpm --filter @pin/worker capture:thumbnails -- refresh [--from a] [--to b]
 *
 * Required env for `run` (see apps/worker/src/capture/config.ts):
 *   CAPTURE_CHAIN, CAPTURE_RPC_URL, CAPTURE_COLLECTION, CAPTURE_RENDER_ASSETS,
 *   CAPTURE_FRAME_BASE_URL, CAPTURE_COVER_PATH, CAPTURE_IRYS_NETWORK,
 *   CAPTURE_OUT_DIR. CAPTURER_PK is required unless --dry-run.
 *
 * CAPTURE_IRYS_NETWORK ("devnet" or "mainnet") is independent of CAPTURE_CHAIN:
 * a sepolia collection can use a real mainnet Arweave upload for cents.
 *
 * `fund` funds the Irys balance for CAPTURER_PK instead of running a batch.
 * Required env: CAPTURE_RPC_URL, CAPTURE_IRYS_NETWORK, CAPTURER_PK.
 *
 * `refresh` re-emits ERC-4906 notifyMetadataUpdate over [from, to] (default
 * 1..the current onchain coverage bound). Run this from the collection's
 * renderer, owner, or admin key after captures are confirmed; the capturer
 * key used for `run` is normally none of those. Required env:
 * CAPTURE_CHAIN, CAPTURE_RPC_URL, CAPTURE_COLLECTION, CAPTURE_RENDER_ASSETS,
 * CAPTURER_PK.
 */
import { loadCaptureEnv, loadFundEnv, loadRefreshEnv, parseCaptureFlags, parseRefreshFlags } from "../capture/config.ts"
import { runCapture, runFund, runRefresh } from "../capture/run.ts"

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2)
  if (sub === "fund") {
    const amount = rest[0]
    if (!amount) throw new Error("usage: capture-thumbnails fund <amount-in-eth>, e.g. fund 0.01")
    const { rpcUrl, storageNetwork, capturerPk } = loadFundEnv()
    await runFund(rpcUrl, storageNetwork, capturerPk, amount)
    return
  }
  if (sub === "refresh") {
    const env = loadRefreshEnv()
    const flags = parseRefreshFlags(rest)
    await runRefresh(env, flags)
    return
  }
  const env = loadCaptureEnv()
  const argv = sub === "run" ? rest : process.argv.slice(2)
  const flags = parseCaptureFlags(argv)
  await runCapture(env, flags)
}

main().catch((err) => {
  console.error("[capture-thumbnails] failed:", err)
  process.exitCode = 1
})
