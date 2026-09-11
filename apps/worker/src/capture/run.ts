/**
 * Orchestrates one capture-thumbnails batch run: discover tokens, render +
 * sign PNGs, build and sign the Arweave path manifest, verify it against
 * the Irys gateway, write RenderAssets.setCaptureTemplate onchain, record.
 * See apps/worker/src/cli/capture-thumbnails.ts for the CLI entry point and
 * the env/flag contract, and capture/README.md for the coverage-bound and
 * verification model.
 *
 * The manifest record (CAPTURE_OUT_DIR/manifest.<chain>.json) is saved after
 * every durable step below, not just at the end: after the cover upload,
 * after each token's upload, after the manifest upload, and after the chain
 * write. A crash between steps leaves a record a retry can resume from,
 * reusing every item id and the manifest id already on Irys instead of
 * re-uploading.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseEther, type PublicClient } from "viem"
import { generatePrivateKey } from "viem/accounts"
import type { CaptureEnv, CaptureFlags, IrysNetwork, RefreshEnv, RefreshFlags } from "./config.ts"
import {
  discoverTokens,
  makePublicClient,
  makeWalletClient,
  readCaptureState,
  readTemplateMaxTokenId,
  tryNotifyMetadataUpdate,
  writeCaptureTemplate,
} from "./chain.ts"
import { launchCaptureBrowser, captureTokenDeterministic } from "./render.ts"
import {
  buildIrysUploader,
  sha256Hex,
  signItem,
  uploadSignedItem,
  type IrysUploader,
  type SignedItem,
  type Tag,
} from "./irys.ts"
import {
  MANIFEST_VERSION,
  assertManifestStructure,
  buildArweavePathManifest,
  captureTemplate,
  computeCoverageBound,
  loadManifestRecord,
  manifestRecordPath,
  mergeTokenRecords,
  planCapture,
  resumeStage,
  saveManifestRecord,
  type CapturedTokenRecord,
  type CaptureManifestRecord,
} from "./manifest.ts"
import { probeArweaveServing, verify404At, verifyBytesAt } from "./verify.ts"

const DEFAULT_PNG_BYTES = 800_000
const MANIFEST_BYTES = 2_048

function gatewayFor(network: IrysNetwork): string {
  return network === "mainnet" ? "https://gateway.irys.xyz" : "https://devnet.irys.xyz"
}

const commonTags = (env: CaptureEnv): Tag[] => [
  { name: "App-Name", value: "pnd-surface-capture" },
  { name: "Collection", value: env.collection },
  { name: "Chain", value: env.chain },
]

/**
 * Bytes this run will upload, for the balance precheck. New PNG sizes
 * aren't known before rendering, so this uses the average of prior tokens'
 * recorded sizes, or a fixed default when there's no prior data.
 */
function estimateUploadBytes(
  toCaptureCount: number,
  priorTokens: CapturedTokenRecord[],
  coverBytes: number,
  coverAlreadyUploaded: boolean,
): number {
  const sizes = priorTokens.map((t) => t.pngBytes).filter((n): n is number => typeof n === "number")
  const avgPngBytes = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : DEFAULT_PNG_BYTES
  let bytes = toCaptureCount * avgPngBytes + MANIFEST_BYTES
  if (!coverAlreadyUploaded) bytes += coverBytes
  return bytes
}

/**
 * Fails fast if the loaded Irys balance can't cover the estimated upload,
 * before any rendering or uploading happens. Skipped in --dry-run, which
 * prints the estimate only since nothing will actually be uploaded.
 */
async function checkIrysBalance(irys: IrysUploader, bytes: number, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[capture-thumbnails] dry-run estimate: ~${bytes} bytes to upload this run (no balance check)`)
    return
  }
  const price = await irys.getPrice(bytes)
  const balance = await irys.getLoadedBalance()
  if (balance.isLessThan(price)) {
    const required = irys.utils.fromAtomic(price).toString()
    const available = irys.utils.fromAtomic(balance).toString()
    throw new Error(
      `insufficient Irys balance for ~${bytes} bytes: need ${required} ${irys.token}, have ${available} ` +
        `${irys.token}. Fund with: pnpm --filter @pin/worker capture:thumbnails fund <amount-in-eth>`,
    )
  }
  console.log(
    `[capture-thumbnails] Irys balance check passed: need ~${irys.utils.fromAtomic(price)} ${irys.token}, ` +
      `have ${irys.utils.fromAtomic(balance)} ${irys.token}`,
  )
}

export async function runCapture(env: CaptureEnv, flags: CaptureFlags): Promise<void> {
  const pngDir = join(env.outDir, "png")
  mkdirSync(pngDir, { recursive: true })
  const recordPath = manifestRecordPath(env.outDir, env.chain)
  const prior = loadManifestRecord(recordPath)
  const gateway = gatewayFor(env.storageNetwork)

  console.log(
    `[capture-thumbnails] chain=${env.chain} storageNetwork=${env.storageNetwork} collection=${env.collection} ` +
      `dryRun=${flags.dryRun}`,
  )

  // 1. Discover tokens.
  const publicClient = makePublicClient(env)
  const { minted, tokens: discovered } = await discoverTokens(publicClient, env.collection)
  console.log(`[capture-thumbnails] minted=${minted}, ${discovered.length} token(s) readable`)

  let candidates = discovered
  if (flags.tokenRange) {
    const { from, to } = flags.tokenRange
    candidates = candidates.filter((t) => t.tokenId >= from && t.tokenId <= to)
  }
  const toCapture = planCapture(candidates, prior, flags.force)
  console.log(
    `[capture-thumbnails] ${toCapture.length} token(s) need capture (of ${candidates.length} in scope, ` +
      `force=${flags.force})`,
  )

  const stage = resumeStage(prior, toCapture.length)

  // No-op: nothing new to capture and a template already covers this token
  // set. Skip manifest rebuild, upload, and chain writes entirely.
  if (stage === "done") {
    console.log(
      `[capture-thumbnails] no new tokens to capture; the existing template already covers all ` +
        `${candidates.length} token(s) in scope. Skipping manifest rebuild, upload, and chain writes.`,
    )
    return
  }

  // Record state, saved after every durable step below so a crash leaves a
  // record a retry can resume from.
  let record: CaptureManifestRecord = {
    chain: env.chain,
    collection: env.collection,
    renderAssets: env.renderAssets,
    storageNetwork: env.storageNetwork,
    gateway,
    coverItemId: prior?.coverItemId,
    manifestId: prior?.manifestId,
    manifestVersion: prior?.manifestVersion,
    template: prior?.template,
    templateMaxTokenId: prior?.templateMaxTokenId,
    templateTxHash: prior?.templateTxHash,
    dryRun: flags.dryRun || undefined,
    updatedAt: new Date().toISOString(),
    tokens: prior?.tokens ?? [],
  }
  function persist(patch: Partial<CaptureManifestRecord>): void {
    record = { ...record, ...patch, updatedAt: new Date().toISOString() }
    saveManifestRecord(recordPath, record)
  }

  const coverBytes = readFileSync(env.coverPath)
  const coverSha256 = sha256Hex(coverBytes)

  // Resume path: the manifest was really uploaded in a prior run (no new
  // tokens since, and that run wasn't --dry-run) but verification and/or
  // the chain write never landed. Skip straight to manifest verification
  // instead of re-rendering and re-uploading everything.
  if (stage === "verify-manifest") {
    console.log(
      `[capture-thumbnails] resuming at manifest verification: manifestId=${record.manifestId} is already ` +
        "uploaded and no new tokens need capture. Skipping render and re-upload.",
    )
    const manifest = buildArweavePathManifest(record.tokens.map((t) => ({ tokenId: t.tokenId, itemId: t.itemId })))
    assertManifestStructure(manifest, record.tokens)
    await finalizeManifest(env, flags, publicClient, record, persist, record.manifestId!, record.tokens)
    return
  }

  // --dry-run signs with a throwaway in-memory key; never touches funds or
  // the network beyond CAPTURE_RPC_URL (see capture/irys.ts).
  const uploaderKey = flags.dryRun ? generatePrivateKey() : env.capturerPk
  if (!uploaderKey) throw new Error("CAPTURER_PK is required outside --dry-run")
  const irys = await buildIrysUploader(env, uploaderKey)

  // 2. Balance precheck, before any render or upload.
  const estimatedBytes = estimateUploadBytes(toCapture.length, record.tokens, coverBytes.length, !!record.coverItemId)
  await checkIrysBalance(irys, estimatedBytes, flags.dryRun)

  // Cover image: signed once, id reused across runs via the record.
  let coverItemId = record.coverItemId
  let coverUploadedThisRun = false
  if (!coverItemId) {
    const signedCover = await signItem(irys, coverBytes, [
      { name: "Content-Type", value: "image/png" },
      { name: "Sha256", value: coverSha256 },
      ...commonTags(env),
    ])
    if (!flags.dryRun) await uploadSignedItem(irys, signedCover)
    coverItemId = signedCover.itemId
    coverUploadedThisRun = true
    persist({ coverItemId })
    console.log(`[capture-thumbnails] cover itemId=${coverItemId}`)
  }

  // 3. Render (determinism-checked) and sign each token's PNG. A
  // non-deterministic render skips that token and continues the batch; it
  // isn't written to the record, so the next run retries it.
  const { browser, args: launchArgs } = await launchCaptureBrowser()
  console.log(`[capture-thumbnails] chromium launch args: ${launchArgs.join(" ")}`)
  const skipped: { tokenId: number; error: string }[] = []
  try {
    for (const token of toCapture) {
      let png: Buffer
      let sha256: string
      try {
        ;({ png, sha256 } = await captureTokenDeterministic(browser, {
          frameBaseUrl: env.frameBaseUrl,
          seed: token.seed,
          owner: token.owner,
        }))
      } catch (err) {
        console.warn(`[capture-thumbnails] token ${token.tokenId} skipped: ${(err as Error).message}`)
        skipped.push({ tokenId: token.tokenId, error: (err as Error).message })
        continue
      }
      writeFileSync(join(pngDir, `${token.tokenId}.png`), png)
      const signed: SignedItem = await signItem(irys, png, [
        { name: "Content-Type", value: "image/png" },
        { name: "Token-Id", value: String(token.tokenId) },
        { name: "Seed", value: token.seed },
        { name: "Sha256", value: sha256 },
        ...commonTags(env),
      ])
      if (!flags.dryRun) await uploadSignedItem(irys, signed)
      const tokenRecord: CapturedTokenRecord = {
        tokenId: token.tokenId,
        seed: token.seed,
        owner: token.owner,
        sha256,
        itemId: signed.itemId,
        pngBytes: png.length,
        capturedAt: new Date().toISOString(),
      }
      persist({ tokens: mergeTokenRecords(record.tokens, [tokenRecord]) })
      console.log(
        `[capture-thumbnails] token ${token.tokenId}: sha256=${sha256.slice(0, 12)} itemId=${signed.itemId}`,
      )
    }
  } finally {
    await browser.close()
  }

  if (skipped.length > 0) {
    console.warn(
      `[capture-thumbnails] ${skipped.length} token(s) skipped this run (non-deterministic render): ` +
        skipped.map((s) => s.tokenId).join(", "),
    )
    process.exitCode = 1
  }

  const allTokens = record.tokens
  const capturedThisRun = new Set(toCapture.map((t) => t.tokenId).filter((id) => !skipped.some((s) => s.tokenId === id)))

  // 4. Per-item verification against the Irys gateway: proves the byte
  // upload actually landed. Only this run's fresh uploads are checked; a
  // prior run already verified its own. Skipped in --dry-run: nothing was
  // uploaded, so there's nothing on the gateway to check yet.
  if (!flags.dryRun) {
    if (coverUploadedThisRun) {
      await verifyBytesAt(fetch, `${gateway}/${coverItemId}`, join(env.outDir, "verify", "cover.png"), coverSha256, "cover")
    }
    for (const t of allTokens) {
      if (!capturedThisRun.has(t.tokenId)) continue
      await verifyBytesAt(fetch, `${gateway}/${t.itemId}`, join(env.outDir, "verify", `${t.tokenId}.png`), t.sha256, `token ${t.tokenId}`)
    }
    console.log("[capture-thumbnails] per-item gateway verification passed")
  }

  // Manifest: one path per captured token, this run plus all prior ones.
  // Structural check runs before signing, so a broken manifest never
  // reaches Irys.
  const manifest = buildArweavePathManifest(allTokens.map((t) => ({ tokenId: t.tokenId, itemId: t.itemId })))
  assertManifestStructure(manifest, allTokens)
  const manifestBuf = Buffer.from(JSON.stringify(manifest))
  const signedManifest = await signItem(irys, manifestBuf, [
    { name: "Content-Type", value: "application/x.arweave-manifest+json" },
    ...commonTags(env),
  ])
  if (!flags.dryRun) await uploadSignedItem(irys, signedManifest)
  const manifestId = signedManifest.itemId

  console.log(`[capture-thumbnails] manifest id=${manifestId}`)
  console.log(JSON.stringify(manifest, null, 2))
  // Persisted before verification starts: if the process crashes below, a
  // retry resumes at verification instead of re-uploading this manifest.
  persist({ manifestId, manifestVersion: MANIFEST_VERSION })

  await finalizeManifest(env, flags, publicClient, record, persist, manifestId, allTokens)
  console.log(`[capture-thumbnails] record up to date at ${recordPath}`)
}

/**
 * From an uploaded manifest id to a chain write: computes the coverage
 * bound, verifies the manifest against the Irys gateway, writes
 * RenderAssets.setCaptureTemplate with that bound, reads the result back,
 * and attempts notifyMetadataUpdate. Shared by the fresh-upload path and
 * the resume-at-verification path in runCapture so both leave the record
 * in the same shape.
 *
 * `template` is persisted only once the chain write actually succeeds, so
 * a record with `template` set always names a template that is live
 * onchain (the one exception is --dry-run, which persists a preview
 * template with no templateTxHash).
 */
async function finalizeManifest(
  env: CaptureEnv,
  flags: CaptureFlags,
  publicClient: PublicClient,
  record: CaptureManifestRecord,
  persist: (patch: Partial<CaptureManifestRecord>) => void,
  manifestId: string,
  allTokens: CapturedTokenRecord[],
): Promise<void> {
  const bound = computeCoverageBound(allTokens.map((t) => t.tokenId))
  const template = captureTemplate(manifestId)
  console.log(`[capture-thumbnails] coverage bound=${bound} (highest contiguous token id from 1)`)
  console.log(`[capture-thumbnails] template=${template}`)
  if (bound < Math.max(0, ...allTokens.map((t) => t.tokenId))) {
    console.log(
      `[capture-thumbnails] a gap below the highest captured token id is holding the bound back; ` +
        "ids above the bound resolve to the cover until the gap is filled and a new bound is written",
    )
  }

  if (flags.dryRun) {
    persist({ manifestId, template, templateMaxTokenId: bound })
    console.log(`[capture-thumbnails] dry-run: would write template=${template} maxTokenId=${bound} onchain`)
    return
  }
  if (!env.capturerPk) throw new Error("CAPTURER_PK is required outside --dry-run")

  // 5. Verify the manifest itself against the Irys gateway: every id in the
  // coverage range resolves through <manifestId>/<id>.png to that token's
  // bytes, and the id one past the bound is genuinely unlisted. Gates the
  // chain write below.
  const byTokenId = new Map(allTokens.map((t) => [t.tokenId, t]))
  for (let id = 1; id <= bound; id++) {
    const t = byTokenId.get(id)
    if (!t) throw new Error(`coverage bound ${bound} claims token ${id} but no record exists for it`)
    await verifyBytesAt(
      fetch,
      `${record.gateway}/${manifestId}/${id}.png`,
      join(env.outDir, "verify", `manifest-${id}.png`),
      t.sha256,
      `manifest path token ${id}`,
    )
  }
  await verify404At(fetch, `${record.gateway}/${manifestId}/${bound + 1}.png`, `manifest path beyond bound (token ${bound + 1})`)
  console.log(`[capture-thumbnails] manifest gateway verification passed for tokens 1..${bound} and 404 at ${bound + 1}`)

  // 6. Write onchain, then record right away: manifestId/template/bound/tx
  // hash land together so a retry never picks up a template without
  // knowing which tx set it.
  const wallet = makeWalletClient(env, env.capturerPk)
  const { txHash } = await writeCaptureTemplate(wallet, publicClient, env, template, bound)
  persist({ manifestId, template, templateMaxTokenId: bound, templateTxHash: txHash, manifestVersion: MANIFEST_VERSION })

  const readback = await readCaptureState(publicClient, env, bound)
  console.log(`[capture-thumbnails] templateOf=${readback.template}`)
  console.log(`[capture-thumbnails] templateMaxTokenIdOf=${readback.maxTokenId}`)
  console.log(`[capture-thumbnails] imageFor(${bound})=${readback.imageForBound}`)
  console.log(`[capture-thumbnails] imageFor(${bound + 1})=${readback.imageForBeyondBound}`)

  await tryNotifyMetadataUpdate(wallet, publicClient, env.collection, 1, bound)

  // 7. Informational only, never gates anything above: whether Arweave L1
  // already serves the manifest. Mainnet storage only; devnet uploads are
  // never seeded to Arweave.
  if (env.storageNetwork === "mainnet" && bound >= 1) {
    await probeArweaveServing(manifestId, bound)
  } else if (env.storageNetwork === "devnet") {
    console.log("[capture-thumbnails] skipping arweave.net probe: devnet storage is never seeded to Arweave")
  }
}

/** Funds the Irys balance for CAPTURER_PK from its onchain ETH. Amount is in
 *  ETH (e.g. "0.01"), converted to the token's atomic unit with viem. */
export async function runFund(
  rpcUrl: string,
  storageNetwork: IrysNetwork,
  capturerPk: `0x${string}`,
  amountEth: string,
): Promise<void> {
  const amountAtomic = parseEther(amountEth)
  const irys = await buildIrysUploader({ rpcUrl, storageNetwork }, capturerPk)
  const before = await irys.getLoadedBalance()
  console.log(`[capture-thumbnails fund] balance before: ${irys.utils.fromAtomic(before)} ${irys.token}`)
  await irys.fund(amountAtomic.toString())
  const after = await irys.getLoadedBalance()
  console.log(`[capture-thumbnails fund] balance after: ${irys.utils.fromAtomic(after)} ${irys.token}`)
}

/**
 * Reruns the collection's ERC-4906 refresh over [from, to] (default 1..the
 * current onchain coverage bound) so marketplaces re-fetch metadata after
 * captures land. Auth is the collection's renderer, owner, or admin
 * (SurfaceCore.sol notifyMetadataUpdate); the capturer key used to write
 * captures is normally none of those, so this is meant to be run by
 * whichever of those three keys the operator controls.
 */
export async function runRefresh(env: RefreshEnv, flags: RefreshFlags): Promise<void> {
  const publicClient = makePublicClient(env)
  const currentBound = await readTemplateMaxTokenId(publicClient, env)
  const from = flags.from ?? 1
  const to = flags.to ?? Number(currentBound)
  console.log(`[capture-thumbnails refresh] notifyMetadataUpdate(${from}, ${to}) on ${env.collection}`)

  const wallet = makeWalletClient(env, env.capturerPk)
  const { sent, txHash } = await tryNotifyMetadataUpdate(wallet, publicClient, env.collection, from, to)
  if (!sent) {
    console.error(
      "[capture-thumbnails refresh] not sent: run this from the collection's renderer, owner, or admin key.",
    )
    process.exitCode = 1
    return
  }
  console.log(`[capture-thumbnails refresh] tx=${txHash}`)
}
