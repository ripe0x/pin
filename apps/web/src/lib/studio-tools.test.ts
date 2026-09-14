/**
 * anySurfaceFactoryLive (the create/mint-gate/sale tool gate): true once
 * either Surface factory resolves for the given chain, in all four
 * combinations. BASE_CHAIN_ID has no Surface addresses on either version,
 * so it exercises "neither" without disturbing the real mainnet constant
 * (v1 is already deployed there — see collection.test.ts).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { BASE_CHAIN_ID, MAINNET_CHAIN_ID } from "@pin/addresses"
import { anySurfaceFactoryLive, STUDIO_TOOLS, studioTools } from "./studio-tools.ts"

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

test("neither factory configured -> not live", () => {
  withEnv({ [ENV_V1]: undefined, [ENV_V2]: undefined }, () => {
    assert.equal(anySurfaceFactoryLive(BASE_CHAIN_ID), false)
  })
})

test("v1 only -> live", () => {
  withEnv({ [ENV_V1]: DEV_ADDR, [ENV_V2]: undefined }, () => {
    assert.equal(anySurfaceFactoryLive(BASE_CHAIN_ID), true)
  })
})

test("v2 only -> live", () => {
  withEnv({ [ENV_V1]: undefined, [ENV_V2]: DEV_ADDR }, () => {
    assert.equal(anySurfaceFactoryLive(BASE_CHAIN_ID), true)
  })
})

test("both -> live", () => {
  withEnv({ [ENV_V1]: DEV_ADDR, [ENV_V2]: DEV_ADDR }, () => {
    assert.equal(anySurfaceFactoryLive(BASE_CHAIN_ID), true)
  })
})

test("mainnet default (v1 already deployed) keeps create/mint-gate/sale visible", () => {
  withEnv({ [ENV_V1]: undefined, [ENV_V2]: undefined }, () => {
    assert.equal(anySurfaceFactoryLive(MAINNET_CHAIN_ID), true)
    const ids = studioTools().map((t) => t.id)
    for (const id of ["create", "mint-gate", "sale"]) {
      assert.ok(ids.includes(id), `${id} should be visible`)
    }
  })
})

test("STUDIO_TOOLS still lists every always-on tool untouched", () => {
  const ids = STUDIO_TOOLS.map((t) => t.id)
  assert.deepEqual(ids, ["create", "listings", "auctions", "catalog", "site", "mint-gate", "sale"])
})
