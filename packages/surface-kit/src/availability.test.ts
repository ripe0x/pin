import assert from "node:assert/strict"
import test from "node:test"
import { SurfaceStatus, releaseAvailability, type ReleaseState } from "./index.ts"

const zeroRoot = `0x${"0".repeat(64)}` as const
const gatedRoot = `0x${"1".repeat(64)}` as const

function state(overrides: Partial<ReleaseState> = {}): Pick<ReleaseState,
  "supplyCap" | "saleSupplyCap" | "saleMinted" | "minted" | "mintStart" | "mintEnd" |
  "allowlistRoot" | "walletCap" | "mintedByAccount"> {
  return {
    supplyCap: 10n,
    saleSupplyCap: 0n,
    saleMinted: 0n,
    minted: 2n,
    mintStart: 100n,
    mintEnd: 200n,
    allowlistRoot: zeroRoot,
    walletCap: 0n,
    mintedByAccount: 0n,
    ...overrides,
  }
}

test("token cap, minter cap, and both caps produce one effective remaining amount", () => {
  const token = releaseAvailability(state({ supplyCap: 5n, minted: 5n }), 150)
  assert.equal(token.effectiveCap, 5n)
  assert.equal(token.collectionRemaining, 0n)
  assert.equal(token.remaining, 0n)
  assert.equal(token.soldOut, true)
  assert.equal(token.lifecycle, SurfaceStatus.Closed)
  assert.equal(token.mintable, false)

  const minter = releaseAvailability(state({ supplyCap: 0n, saleSupplyCap: 4n, saleMinted: 4n }), 150)
  assert.equal(minter.effectiveCap, 4n)
  assert.equal(minter.saleRemaining, 0n)
  assert.equal(minter.soldOut, true)

  const both = releaseAvailability(state({ supplyCap: 10n, minted: 7n, saleSupplyCap: 5n, saleMinted: 3n }), 150, { quantity: 2n })
  assert.equal(both.effectiveCap, 5n)
  assert.equal(both.collectionRemaining, 3n)
  assert.equal(both.saleRemaining, 2n)
  assert.equal(both.remaining, 2n)
  assert.equal(both.mintable, true)
})

test("zero caps are open-ended, while quantity cannot exceed a finite remaining cap", () => {
  const open = releaseAvailability(state({ supplyCap: 0n, minted: 999n, mintStart: 0n, mintEnd: 0n }), 150, { quantity: 100n })
  assert.equal(open.effectiveCap, 0n)
  assert.equal(open.remaining, null)
  assert.equal(open.soldOut, false)
  assert.equal(open.mintable, true)

  const tooMany = releaseAvailability(state({ supplyCap: 3n, minted: 2n }), 150, { quantity: 2n })
  assert.equal(tooMany.remaining, 1n)
  assert.equal(tooMany.mintable, false)
})

test("scheduled, exact end, and invalid quantity states fail closed", () => {
  assert.equal(releaseAvailability(state(), 99).lifecycle, SurfaceStatus.Scheduled)
  assert.equal(releaseAvailability(state(), 99).mintable, false)
  assert.equal(releaseAvailability(state(), 200).lifecycle, SurfaceStatus.Closed)
  assert.equal(releaseAvailability(state(), 200).mintable, false)
  assert.equal(releaseAvailability(state(), 150, { quantity: 0n }).quantityValid, false)
  assert.equal(releaseAvailability(state(), 150, { quantity: 0n }).mintable, false)
})

test("wallet caps expose remaining allowance and prevent over-minting", () => {
  const available = releaseAvailability(state({ walletCap: 3n, mintedByAccount: 1n }), 150, { quantity: 2n })
  assert.equal(available.walletRemaining, 2n)
  assert.equal(available.walletCapped, false)
  assert.equal(available.mintable, true)

  const reached = releaseAvailability(state({ walletCap: 3n, mintedByAccount: 3n }), 150)
  assert.equal(reached.walletRemaining, 0n)
  assert.equal(reached.walletCapped, true)
  assert.equal(reached.mintable, false)

  const exceeds = releaseAvailability(state({ walletCap: 3n, mintedByAccount: 2n }), 150, { quantity: 2n })
  assert.equal(exceeds.walletRemaining, 1n)
  assert.equal(exceeds.mintable, false)
})

test("allowlist releases fail closed without a proof and open with one", () => {
  const missing = releaseAvailability(state({ allowlistRoot: gatedRoot }), 150)
  assert.equal(missing.allowlistRequired, true)
  assert.equal(missing.allowlistSatisfied, false)
  assert.equal(missing.mintable, false)

  const supplied = releaseAvailability(state({ allowlistRoot: gatedRoot }), 150, { allowlistProofAvailable: true })
  assert.equal(supplied.allowlistSatisfied, true)
  assert.equal(supplied.mintable, true)
})
