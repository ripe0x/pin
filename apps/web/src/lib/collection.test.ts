/**
 * surfaceFactory/surfaceFactoryV2 (the addresses helper, per-chain): env
 * override wins when set; otherwise falls back to the packages/addresses
 * constant, or null when the chain has no configured address at all.
 * BASE_CHAIN_ID carries no Surface addresses either version, so it stands
 * in for "unconfigured" without disturbing the real mainnet constants.
 */
import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import assert from "node:assert/strict"
import { BASE_CHAIN_ID, MAINNET_CHAIN_ID } from "@pin/addresses"
import { surfaceFactory, surfaceFactoryV2 } from "./collection.ts"

const ENV_V1 = "NEXT_PUBLIC_SURFACE_FACTORY"
const ENV_V2 = "NEXT_PUBLIC_SURFACE_FACTORY_V2"
const DEV_ADDR = "0x1111111111111111111111111111111111111111"

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) prev[k] = process.env[k]
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test("mainnet resolves the real deployed v1 factory with no override", () => {
  withEnv({ [ENV_V1]: undefined, [ENV_V2]: undefined }, () => {
    assert.equal(surfaceFactory(MAINNET_CHAIN_ID), "0xdB81d3F33EF3D84685486916E0d372E247558094")
  })
})

test("v2 factory is unset on mainnet until deployed (neither state on the v2 side)", () => {
  withEnv({ [ENV_V1]: undefined, [ENV_V2]: undefined }, () => {
    assert.equal(surfaceFactoryV2(MAINNET_CHAIN_ID), null)
  })
})

test("neither: an unconfigured chain with no override resolves neither factory", () => {
  withEnv({ [ENV_V1]: undefined, [ENV_V2]: undefined }, () => {
    assert.equal(surfaceFactory(BASE_CHAIN_ID), null)
    assert.equal(surfaceFactoryV2(BASE_CHAIN_ID), null)
  })
})

test("v1 only: the v1 override resolves v1 without lighting up v2", () => {
  withEnv({ [ENV_V1]: DEV_ADDR, [ENV_V2]: undefined }, () => {
    assert.equal(surfaceFactory(BASE_CHAIN_ID), DEV_ADDR)
    assert.equal(surfaceFactoryV2(BASE_CHAIN_ID), null)
  })
})

test("v2 only: the v2 override resolves v2 without lighting up v1", () => {
  withEnv({ [ENV_V1]: undefined, [ENV_V2]: DEV_ADDR }, () => {
    assert.equal(surfaceFactory(BASE_CHAIN_ID), null)
    assert.equal(surfaceFactoryV2(BASE_CHAIN_ID), DEV_ADDR)
  })
})

test("both: v1 and v2 overrides resolve independently", () => {
  const v1Addr = "0x2222222222222222222222222222222222222222"
  withEnv({ [ENV_V1]: v1Addr, [ENV_V2]: DEV_ADDR }, () => {
    assert.equal(surfaceFactory(BASE_CHAIN_ID), v1Addr)
    assert.equal(surfaceFactoryV2(BASE_CHAIN_ID), DEV_ADDR)
  })
})

// PND_CHAIN_ID must honor the same NEXT_PUBLIC_FORK_CHAIN_ID override as
// wagmi.ts's forkChain. Regression: FORK_CHAIN_ID was hardcoded 31339, so a
// developer forking anvil at 31337 got a chain-id mismatch (getAddressOrNull
// looked up the wrong chain and returned null). Module-level constants bind at
// load and the runner already imported this module with env unset, so a
// same-process re-import returns the cached instance — evaluate in a child tsx
// process with the env set. (An eval/`-e` entry collapses the TS namespace to
// its default export, so probe through a real file importing by absolute path.)
test("PND_CHAIN_ID honors NEXT_PUBLIC_FORK_CHAIN_ID under fork mode", () => {
  const modUrl = new URL("./collection.ts", import.meta.url)
  const probe = join(tmpdir(), `collection-fork-probe-${process.pid}.ts`)
  writeFileSync(
    probe,
    `import { PND_CHAIN_ID } from ${JSON.stringify(fileURLToPath(modUrl))}\n` +
      "process.stdout.write(String(PND_CHAIN_ID))\n",
  )
  try {
    const out = execFileSync("npx", ["tsx", probe], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), // apps/web
      env: {
        ...process.env,
        NEXT_PUBLIC_USE_LOCAL_RPC: "1",
        NEXT_PUBLIC_FORK_CHAIN_ID: "31337",
      },
      encoding: "utf8",
    })
    assert.equal(out.trim(), "31337")
  } finally {
    rmSync(probe, { force: true })
  }
})
