/**
 * Env + CLI flag parsing for the Surface thumbnail capture tool
 * (apps/worker/src/cli/capture-thumbnails.ts). All input is read from
 * process.env and argv only; nothing here touches the network.
 */
import type { Address } from "viem"

export type CaptureChain = "sepolia" | "mainnet"
export type IrysNetwork = "devnet" | "mainnet"

export interface CaptureEnv {
  chain: CaptureChain
  rpcUrl: string
  collection: Address
  renderAssets: Address
  frameBaseUrl: string
  coverPath: string
  /** Which Irys network to sign and upload against. Independent of `chain`:
   *  a sepolia collection can use storageNetwork "mainnet" for real Arweave
   *  storage, or "devnet" for a cheaper rehearsal. Both are verified the
   *  same way, against the Irys gateway (see capture/verify.ts); the Irys
   *  gateway serves a devnet upload immediately, it just never reaches
   *  Arweave L1, so only the informational arweave.net probe differs. */
  storageNetwork: IrysNetwork
  outDir: string
  /** Required outside --dry-run; a dry run signs with an in-memory
   *  throwaway key instead. */
  capturerPk: `0x${string}` | undefined
}

export interface TokenRange {
  from: number
  to: number
}

export interface CaptureFlags {
  dryRun: boolean
  force: boolean
  tokenRange: TokenRange | undefined
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/
const DEFAULT_OUT_DIR = "capture-out"

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing required env var ${name}`)
  return v
}

function isAddress(v: string): v is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(v)
}

function requireAddress(name: string): Address {
  const v = requireEnv(name)
  if (!isAddress(v)) throw new Error(`${name} is not a 20-byte hex address: ${v}`)
  return v
}

function requireChain(): CaptureChain {
  const v = requireEnv("CAPTURE_CHAIN")
  if (v !== "sepolia" && v !== "mainnet") {
    throw new Error(`CAPTURE_CHAIN must be "sepolia" or "mainnet", got "${v}"`)
  }
  return v
}

function requireIrysNetwork(): IrysNetwork {
  const v = requireEnv("CAPTURE_IRYS_NETWORK")
  if (v !== "devnet" && v !== "mainnet") {
    throw new Error(`CAPTURE_IRYS_NETWORK must be "devnet" or "mainnet", got "${v}"`)
  }
  return v
}

function requireCapturerPk(): `0x${string}` {
  const v = requireEnv("CAPTURER_PK")
  if (!PRIVATE_KEY_RE.test(v)) throw new Error("CAPTURER_PK is not a 32-byte hex private key")
  return v as `0x${string}`
}

export function loadCaptureEnv(): CaptureEnv {
  const chain = requireChain()
  const storageNetwork = requireIrysNetwork()
  const capturerPkRaw = process.env.CAPTURER_PK
  if (capturerPkRaw && !PRIVATE_KEY_RE.test(capturerPkRaw)) {
    throw new Error("CAPTURER_PK is set but is not a 32-byte hex private key")
  }
  return {
    chain,
    rpcUrl: requireEnv("CAPTURE_RPC_URL"),
    collection: requireAddress("CAPTURE_COLLECTION"),
    renderAssets: requireAddress("CAPTURE_RENDER_ASSETS"),
    frameBaseUrl: requireEnv("CAPTURE_FRAME_BASE_URL").replace(/\/$/, ""),
    coverPath: requireEnv("CAPTURE_COVER_PATH"),
    storageNetwork,
    outDir: process.env.CAPTURE_OUT_DIR || DEFAULT_OUT_DIR,
    capturerPk: capturerPkRaw as `0x${string}` | undefined,
  }
}

export interface FundEnv {
  rpcUrl: string
  storageNetwork: IrysNetwork
  capturerPk: `0x${string}`
}

/** Env contract for the `fund` subcommand: just enough to build an Irys
 *  uploader and send funds, no collection/render/render-frame config needed. */
export function loadFundEnv(): FundEnv {
  return {
    rpcUrl: requireEnv("CAPTURE_RPC_URL"),
    storageNetwork: requireIrysNetwork(),
    capturerPk: requireCapturerPk(),
  }
}

export interface RefreshEnv {
  chain: CaptureChain
  rpcUrl: string
  collection: Address
  renderAssets: Address
  capturerPk: `0x${string}`
}

/** Env contract for the `refresh` subcommand: just enough to read the
 *  onchain coverage bound and broadcast notifyMetadataUpdate, no Irys or
 *  render-frame config needed. */
export function loadRefreshEnv(): RefreshEnv {
  return {
    chain: requireChain(),
    rpcUrl: requireEnv("CAPTURE_RPC_URL"),
    collection: requireAddress("CAPTURE_COLLECTION"),
    renderAssets: requireAddress("CAPTURE_RENDER_ASSETS"),
    capturerPk: requireCapturerPk(),
  }
}

export function parseCaptureFlags(argv: string[]): CaptureFlags {
  const dryRun = argv.includes("--dry-run")
  const force = argv.includes("--force")
  const tokensIdx = argv.indexOf("--tokens")
  let tokenRange: TokenRange | undefined
  if (tokensIdx >= 0) {
    const raw = argv[tokensIdx + 1]
    if (!raw) throw new Error("--tokens requires a value, e.g. --tokens 1-5")
    const m = /^(\d+)-(\d+)$/.exec(raw)
    if (!m) throw new Error(`--tokens value must look like "1-5", got "${raw}"`)
    const from = Number(m[1])
    const to = Number(m[2])
    if (from > to) throw new Error(`--tokens range is backwards: ${raw}`)
    tokenRange = { from, to }
  }
  return { dryRun, force, tokenRange }
}

export interface RefreshFlags {
  from: number | undefined
  to: number | undefined
}

function parsePositiveIntFlag(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag)
  if (idx < 0) return undefined
  const raw = argv[idx + 1]
  const n = raw ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got "${raw}"`)
  return n
}

export function parseRefreshFlags(argv: string[]): RefreshFlags {
  return {
    from: parsePositiveIntFlag(argv, "--from"),
    to: parsePositiveIntFlag(argv, "--to"),
  }
}
