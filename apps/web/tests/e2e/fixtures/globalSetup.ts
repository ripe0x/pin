/**
 * Playwright globalSetup for the PND Collections e2e harness.
 *
 * Brings up, once, the whole local stack the specs drive:
 *   1. Anvil mainnet fork on a free port, chain id 31339 (the id wagmi's
 *      forkChain registers), with --auto-impersonate so the dev wallet's
 *      txs are signed server-side by Anvil — no private key in the browser.
 *      Forking mainnet means Multicall3 is present, which the collections
 *      server reads (getCollection et al) rely on.
 *   2. Deploys the SovereignCollection system (Attribution + renderers +
 *      impl + factory) to the fork.
 *   3. Next dev server on a fixed port (E2E_APP_PORT, default 3100) with the
 *      fork env + NEXT_PUBLIC_DEV_IMPERSONATE set, so the wagmi mock
 *      connector auto-connects as the impersonated account (no modal). This
 *      is PND's intended local-test wallet path (see apps/web/src/lib/wagmi.ts).
 *
 * Process handles + addresses are written to a state file that the fixture
 * and teardown read.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

export const STATE_FILE = resolve(__dirname, "../.e2e-state.json")

export type GlobalState = {
  rpcUrl: string
  factory: `0x${string}`
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
// DeployCollectionSystem.s.sol reads PRIVATE_KEY via vm.envUint and signs
// locally with vm.startBroadcast(deployerPk) — unlike the retired
// DeployEditions.s.sol, it does NOT rely on --unlocked eth_sendTransaction
// impersonation. See scripts/dev-collections.sh for the same pattern.
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const APP_PORT = Number(process.env.E2E_APP_PORT ?? "3100")

const FOUNDRY_BIN = resolve(process.env.HOME ?? "", ".foundry/bin")
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

export default async function globalSetup() {
  // 1) Anvil fork.
  const anvilPort = await freePort(8546)
  const rpcUrl = `http://127.0.0.1:${anvilPort}`
  console.log(`[e2e] starting Anvil fork on ${rpcUrl} (chain ${CHAIN_ID})`)
  const anvil: ChildProcess = spawn(
    "anvil",
    [
      "--fork-url", FORK_RPC,
      "--chain-id", String(CHAIN_ID),
      "--port", String(anvilPort),
      "--host", "127.0.0.1",
      "--auto-impersonate",
      "--silent",
    ],
    { cwd: REPO_ROOT, env: ENV_WITH_FOUNDRY, detached: true, stdio: "ignore" },
  )
  anvil.unref()
  await waitFor("anvil", async () => {
    await rpc(rpcUrl, "eth_blockNumber")
    return true
  }, 60_000)

  // 2) Fund the impersonated wallet + deploy the SovereignCollection system.
  await rpc(rpcUrl, "anvil_setBalance", [IMPERSONATE, "0x21e19e0c9bab2400000"])
  console.log("[e2e] deploying collection contracts…")
  const out = execSync(
    `forge script script/DeployCollectionSystem.s.sol --rpc-url ${rpcUrl} --broadcast --sender ${IMPERSONATE}`,
    { cwd: CONTRACTS_DIR, env: { ...ENV_WITH_FOUNDRY, PRIVATE_KEY: DEPLOYER_PK }, encoding: "utf8" },
  )
  const m = out.match(/SovereignCollectionFactory:\s*(0x[0-9a-fA-F]{40})/)
  if (!m) {
    console.error(out)
    throw new Error("e2e: could not parse factory address from deploy output")
  }
  const factory = m[1] as `0x${string}`
  console.log(`[e2e] factory: ${factory}`)

  // 3) Next dev server with the fork env + mock-connector impersonation.
  console.log(`[e2e] starting Next dev server on :${APP_PORT}`)
  const app: ChildProcess = spawn(
    "pnpm",
    ["exec", "next", "dev", "--turbopack", "--port", String(APP_PORT)],
    {
      cwd: APP_DIR,
      env: {
        ...ENV_WITH_FOUNDRY,
        NODE_ENV: "development",
        NEXT_PUBLIC_USE_LOCAL_RPC: "1",
        NEXT_PUBLIC_ANVIL_RPC_URL: rpcUrl,
        NEXT_PUBLIC_SOVEREIGN_COLLECTION_FACTORY: factory,
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
    appPort: APP_PORT,
    impersonate: IMPERSONATE,
    anvilPid: anvil.pid ?? 0,
    appPid: app.pid ?? 0,
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log("[e2e] stack ready")
}
