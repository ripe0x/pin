/**
 * Playwright globalSetup for the PND Collections e2e harness.
 *
 * Brings up, once, the whole local stack the specs drive:
 *   1. Anvil mainnet fork on a free port, chain id 31339 (the id wagmi's
 *      forkChain registers), with --auto-impersonate so the dev wallet's
 *      txs are signed server-side by Anvil — no private key in the browser.
 *      Forking mainnet means Multicall3 is present, which the collections
 *      server reads (getCollection et al) rely on.
 *   2. Deploys the Surface implementations + factory to the fork, reusing
 *      the mainnet Catalog already present in forked state, plus one
 *      bring-your-own renderer (contracts/script/mocks/MockRenderer.sol) for
 *      the wizard's Renderer step. The shared RenderAssets/DefaultRenderer
 *      modules were deleted in #353; DeploySurfaceSystem never deployed them.
 *   3. Deploys the primitive Surface v2 contracts (contracts/src/surface/v2:
 *      Surface and FixedPriceSale implementations, AllowlistGate, the token
 *      and sale CloneFactories, the Launcher), unpaused, so the create
 *      wizard launches v2 collections through Launcher.launch.
 *      DeploySurfaceV2.s.sol only runs on chain 31337, so each contract is a
 *      `forge create` here.
 *   4. Optionally (E2E_DATABASE_URL set) prepares a Postgres database for the
 *      allowlist store (the collection_allowlists table, migration 026) and
 *      hands it to the app as DATABASE_URL, with INDEXER_DISABLED=1 so no
 *      indexer query runs against it. The v2 lifecycle spec's allowlist
 *      step needs it; without it that spec is skipped.
 *   5. Next dev server on a fixed port (E2E_APP_PORT, default 3100) with the
 *      fork env + NEXT_PUBLIC_DEV_IMPERSONATE set, so the wagmi mock
 *      connector auto-connects as the impersonated account (no modal). This
 *      is PND's intended local-test wallet path (see apps/web/src/lib/wagmi.ts).
 *
 * Process handles + addresses are written to a state file that the fixture
 * and teardown read.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import postgres from "postgres"

export const STATE_FILE = resolve(__dirname, "../.e2e-state.json")

export type SurfaceV2Deployment = {
  surfaceImpl: `0x${string}`
  saleImpl: `0x${string}`
  allowlistGate: `0x${string}`
  tokenFactory: `0x${string}`
  saleFactory: `0x${string}`
  launcher: `0x${string}`
}

export type GlobalState = {
  rpcUrl: string
  factory: `0x${string}`
  renderer: `0x${string}`
  v2: SurfaceV2Deployment
  /** True when the app has a Postgres store (E2E_DATABASE_URL). */
  database: boolean
  appPort: number
  impersonate: `0x${string}`
  anvilPid: number
  appPid: number
}

const REPO_ROOT = resolve(__dirname, "../../../../..")
const APP_DIR = resolve(REPO_ROOT, "apps/web")
const CONTRACTS_DIR = resolve(REPO_ROOT, "contracts")

const CHAIN_ID = 31339
const FORK_RPC = process.env.E2E_FORK_RPC ?? "https://ethereum-rpc.publicnode.com"
const IMPERSONATE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const // Anvil acct 0
// Well-known Anvil account-0 private key (derives to IMPERSONATE above).
// Passed explicitly to Forge's --private-key flag; the script itself uses
// vm.startBroadcast() and does not read a secret from its environment.
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const APP_PORT = Number(process.env.E2E_APP_PORT ?? "3100")
const COMMAND_TIMEOUT_MS = 120_000

// FOUNDRY_BIN overrides the default install location (e.g. a pinned
// toolchain outside ~/.foundry).
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? resolve(process.env.HOME ?? "", ".foundry/bin")
const ENV_WITH_FOUNDRY = { ...process.env, PATH: `${FOUNDRY_BIN}:${process.env.PATH ?? ""}` }

function freePort(start: number): Promise<number> {
  return new Promise((resolveP, reject) => {
    const tryPort = (p: number) => {
      if (p > start + 200) return reject(new Error("no free port"))
      const s = createServer()
      s.once("error", () => tryPort(p + 1))
      s.once("listening", () => s.close(() => resolveP(p)))
      s.listen(p, "127.0.0.1")
    }
    tryPort(start)
  })
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  return body.result
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`e2e: timed out waiting for ${label}`)
}

function deployedAddress(output: string, label: string): `0x${string}` {
  const match = output.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)
  if (!match) throw new Error(`e2e: could not parse ${label} address`)
  return match[1] as `0x${string}`
}

function forgeCreate(rpcUrl: string, contract: string, args: string[] = []): `0x${string}` {
  const out = execFileSync(
    "forge",
    [
      "create",
      contract,
      "--rpc-url",
      rpcUrl,
      "--private-key",
      DEPLOYER_PK,
      "--broadcast",
      ...(args.length > 0 ? ["--constructor-args", ...args] : []),
    ],
    { cwd: CONTRACTS_DIR, env: ENV_WITH_FOUNDRY, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS },
  )
  return deployedAddress(out, contract)
}

function castSig(signature: string): string {
  return execFileSync("cast", ["sig", signature], { env: ENV_WITH_FOUNDRY, encoding: "utf8" }).trim()
}

/** The Surface v2 primitives in DeploySurfaceV2.s.sol's order, unpaused
 *  (CloneFactory lands open; the script pauses only when asked), with the
 *  impersonated wallet as launcher owner and no default referrer. */
function deploySurfaceV2(rpcUrl: string): SurfaceV2Deployment {
  const surfaceImpl = forgeCreate(rpcUrl, "src/surface/v2/Surface.sol:Surface")
  const saleImpl = forgeCreate(rpcUrl, "src/surface/v2/FixedPriceSale.sol:FixedPriceSale")
  const allowlistGate = forgeCreate(rpcUrl, "src/surface/v2/AllowlistGate.sol:AllowlistGate")
  const tokenFactory = forgeCreate(rpcUrl, "src/surface/v2/CloneFactory.sol:CloneFactory", [
    surfaceImpl,
    castSig("initialize(string,string,address,address,uint256,uint16,address,address)"),
  ])
  const saleFactory = forgeCreate(rpcUrl, "src/surface/v2/CloneFactory.sol:CloneFactory", [
    saleImpl,
    castSig("initialize(address,uint256,uint64,uint64,uint256,uint256,address,address,address)"),
  ])
  const launcher = forgeCreate(rpcUrl, "src/surface/v2/Launcher.sol:Launcher", [
    tokenFactory,
    saleFactory,
    "0x0000000000000000000000000000000000000000",
    IMPERSONATE,
  ])
  return { surfaceImpl, saleImpl, allowlistGate, tokenFactory, saleFactory, launcher }
}

/** The allowlist store the app's publish/proof routes use: migration 026
 *  only (the app reads nothing else from Postgres with INDEXER_DISABLED=1
 *  and the fork-mode cache bypass). */
async function prepareDatabase(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 2, connect_timeout: 10, onnotice: () => {} })
  try {
    await sql.unsafe(readFileSync(resolve(REPO_ROOT, "db/migrations/026_collection_allowlists.sql"), "utf8"))
    await sql`DELETE FROM collection_allowlists`
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function killGroup(pid: number | undefined) {
  if (!pid) return
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
}

/**
 * The block to fork at: E2E_FORK_BLOCK, else a few blocks behind the
 * upstream head. A load-balanced public RPC answers "block not found" from
 * whichever backend has not caught up with the newest block yet; pinning a
 * slightly older block (well inside the non-archive state window) keeps
 * every backend able to serve it.
 */
async function forkBlock(): Promise<number> {
  const pinned = Number(process.env.E2E_FORK_BLOCK ?? "")
  if (Number.isInteger(pinned) && pinned > 0) return pinned
  const head = Number(await rpc(FORK_RPC, "eth_blockNumber"))
  return head - 8
}

export default async function globalSetup() {
  // 1) Anvil fork.
  const anvilPort = await freePort(8546)
  const rpcUrl = `http://127.0.0.1:${anvilPort}`
  const block = await forkBlock()
  console.log(`[e2e] starting Anvil fork on ${rpcUrl} (chain ${CHAIN_ID}, block ${block})`)
  const anvil: ChildProcess = spawn(
    "anvil",
    [
      "--fork-url", FORK_RPC,
      "--fork-block-number", String(block),
      "--chain-id", String(CHAIN_ID),
      "--port", String(anvilPort),
      "--host", "127.0.0.1",
      "--auto-impersonate",
      "--silent",
    ],
    { cwd: REPO_ROOT, env: ENV_WITH_FOUNDRY, detached: true, stdio: "ignore" },
  )
  anvil.unref()
  let app: ChildProcess | undefined
  try {
  await waitFor("anvil", async () => {
    await rpc(rpcUrl, "eth_blockNumber")
    return true
  }, 120_000)

  // 2) Fund the impersonated wallet + deploy the Surface system.
  await rpc(rpcUrl, "anvil_setBalance", [IMPERSONATE, "0x21e19e0c9bab2400000"])
  // Anvil account 0's key is public, so on mainnet someone has pointed it at
  // an EIP-7702 delegate (its code is `0xef0100…`). Forked, that makes the
  // dev wallet look like a contract: the Renderer step's bytecode check
  // accepts it, and ETH sent to it runs the delegate. Clear it so the
  // impersonated wallet is a plain EOA on the fork.
  await rpc(rpcUrl, "anvil_setCode", [IMPERSONATE, "0x"])
  console.log("[e2e] deploying collection contracts…")
  const out = execFileSync(
    "forge",
    [
      "script",
      "script/DeploySurfaceSystem.s.sol",
      "--rpc-url",
      rpcUrl,
      "--broadcast",
      "--private-key",
      DEPLOYER_PK,
    ],
    {
      cwd: CONTRACTS_DIR,
      env: ENV_WITH_FOUNDRY,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
    },
  )
  const m = out.match(/SurfaceFactory:\s*(0x[0-9a-fA-F]{40})/)
  if (!m) {
    console.error(out)
    throw new Error("e2e: could not parse factory address from deploy output")
  }
  const factory = m[1] as `0x${string}`
  console.log(`[e2e] factory: ${factory}`)

  // The factory has no default renderer (matching mainnet): every collection
  // brings its own via cfg.renderer. Deploy one minimal IRenderer for the
  // wizard's Renderer step to point at.
  const renderer = deployedAddress(
    execFileSync(
      "forge",
      [
        "create",
        "script/mocks/MockRenderer.sol:MockRenderer",
        "--rpc-url",
        rpcUrl,
        "--private-key",
        DEPLOYER_PK,
        "--broadcast",
        "--constructor-args",
        "E2E Renderer",
        "#444444",
      ],
      {
        cwd: CONTRACTS_DIR,
        env: ENV_WITH_FOUNDRY,
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
      },
    ),
    "MockRenderer",
  )
  execFileSync(
    "cast",
    [
      "send",
      factory,
      "setPaused(bool)",
      "false",
      "--rpc-url",
      rpcUrl,
      "--private-key",
      DEPLOYER_PK,
    ],
    {
      cwd: CONTRACTS_DIR,
      env: ENV_WITH_FOUNDRY,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
    },
  )
  console.log(`[e2e] renderer: ${renderer}`)

  console.log("[e2e] deploying Surface v2 primitives…")
  const v2 = deploySurfaceV2(rpcUrl)
  console.log(`[e2e] v2 launcher: ${v2.launcher}, allowlist gate: ${v2.allowlistGate}`)

  const databaseUrl = process.env.E2E_DATABASE_URL?.trim() || ""
  if (databaseUrl) {
    await prepareDatabase(databaseUrl)
    console.log("[e2e] allowlist store ready")
  }

  // 3) Next dev server with the fork env + mock-connector impersonation.
  console.log(`[e2e] starting Next dev server on :${APP_PORT}`)
  app = spawn(
    "pnpm",
    ["exec", "next", "dev", "--turbopack", "--port", String(APP_PORT)],
    {
      cwd: APP_DIR,
      env: {
        ...ENV_WITH_FOUNDRY,
        NODE_ENV: "development",
        NEXT_PUBLIC_USE_LOCAL_RPC: "1",
        NEXT_PUBLIC_ANVIL_RPC_URL: rpcUrl,
        NEXT_PUBLIC_SURFACE_FACTORY: factory,
        // The fork-local Surface v2 primitives: the wizard launches through
        // the Launcher; the studio's v2 panels and the collection page read
        // through the token factory, sale factory and AllowlistGate.
        NEXT_PUBLIC_LAUNCHER_V2: v2.launcher,
        NEXT_PUBLIC_SURFACE_TOKEN_FACTORY_V2: v2.tokenFactory,
        NEXT_PUBLIC_SALE_FACTORY_V2: v2.saleFactory,
        NEXT_PUBLIC_ALLOWLIST_GATE: v2.allowlistGate,
        // The allowlist store when one is provided; never the developer's
        // .env.local database (process env wins over dotenv).
        DATABASE_URL: databaseUrl,
        INDEXER_DISABLED: "1",
        // Pin the stack to the fork-local factories: blank out overrides a
        // developer's .env.local may carry (process env wins over dotenv).
        NEXT_PUBLIC_SURFACE_FACTORY_V2: "",
        NEXT_PUBLIC_RENDER_ASSETS: "",
        NEXT_PUBLIC_DEFAULT_RENDERER: "",
        NEXT_PUBLIC_DEV_IMPERSONATE: IMPERSONATE,
      },
      detached: true,
      stdio: "ignore",
    },
  )
  app.unref()
  await waitFor(
    "next dev",
    async () => {
      const res = await fetch(`http://127.0.0.1:${APP_PORT}/collections`)
      return res.ok
    },
    120_000,
  )

  const state: GlobalState = {
    rpcUrl,
    factory,
    renderer,
    v2,
    database: databaseUrl !== "",
    appPort: APP_PORT,
    impersonate: IMPERSONATE,
    anvilPid: anvil.pid ?? 0,
    appPid: app.pid ?? 0,
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log("[e2e] stack ready")
  } catch (error) {
    // Playwright does not run globalTeardown when globalSetup fails before the
    // state file is written, so clean up both detached process groups here.
    killGroup(app?.pid)
    killGroup(anvil.pid)
    throw error
  }
}
