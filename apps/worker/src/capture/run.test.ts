/**
 * Run with: node --experimental-strip-types --test apps/worker/src/capture/run.test.ts
 * Stubs the parts of IrysUploader that checkIrysBalance and uploadSignedItem
 * touch -- no network, no real Irys client.
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { checkIrysBalance } from "./run.ts"
import { uploadSignedItem, type IrysUploader, type SignedItem } from "./irys.ts"

/** Minimal BigNumber-like stub: only the comparison method checkIrysBalance calls. */
function bn(value: number) {
  return {
    isGreaterThan: (v: string | number) => value > Number(v),
    isLessThan: (v: string | number) => value < Number(v),
    toString: () => String(value),
  }
}

function stubIrys(opts: {
  price: number
  loadedBalance?: number
  approvedAmount?: string
}): IrysUploader {
  return {
    token: "ethereum",
    address: "0xUPLOADER",
    getPrice: async () => bn(opts.price) as never,
    getLoadedBalance: async () => bn(opts.loadedBalance ?? 0) as never,
    utils: { fromAtomic: (v: unknown) => ({ toString: () => String(v) }) } as never,
    approval: {
      getApprovedBalanceFrom: async (_payingAddress: string) => ({ amount: opts.approvedAmount ?? "0" }),
    } as never,
  } as unknown as IrysUploader
}

test("checkIrysBalance: dry-run never checks any balance", async () => {
  const irys = stubIrys({ price: 100 })
  await assert.doesNotReject(checkIrysBalance(irys, 1000, true))
})

test("checkIrysBalance: own balance sufficient passes", async () => {
  const irys = stubIrys({ price: 100, loadedBalance: 200 })
  await assert.doesNotReject(checkIrysBalance(irys, 1000, false))
})

test("checkIrysBalance: own balance insufficient throws", async () => {
  const irys = stubIrys({ price: 100, loadedBalance: 50 })
  await assert.rejects(checkIrysBalance(irys, 1000, false), /insufficient Irys balance/)
})

test("checkIrysBalance: paidBy with sufficient approval passes", async () => {
  const irys = stubIrys({ price: 100, approvedAmount: "200" })
  await assert.doesNotReject(checkIrysBalance(irys, 1000, false, "0xARTIST"))
})

test("checkIrysBalance: paidBy with insufficient approval throws and names the approver", async () => {
  const irys = stubIrys({ price: 100, approvedAmount: "50" })
  await assert.rejects(
    checkIrysBalance(irys, 1000, false, "0xARTIST"),
    /insufficient Irys approval.*0xARTIST.*approved 50/s,
  )
})

test("checkIrysBalance: paidBy with no approval (amount 0) throws", async () => {
  const irys = stubIrys({ price: 100, approvedAmount: "0" })
  await assert.rejects(checkIrysBalance(irys, 1000, false, "0xARTIST"), /insufficient Irys approval/)
})

test("uploadSignedItem: carries paidBy in the upload options when set", async () => {
  let capturedOpts: unknown
  const irys = {
    uploader: {
      uploadTransaction: async (_item: unknown, opts: unknown) => {
        capturedOpts = opts
      },
    },
  } as unknown as IrysUploader
  const signed = { item: {}, itemId: "id-1", sha256: "sha" } as unknown as SignedItem
  await uploadSignedItem(irys, signed, "0xARTIST")
  assert.deepEqual(capturedOpts, { paidBy: "0xARTIST" })
})

test("uploadSignedItem: omits paidBy from the upload options when unset", async () => {
  let capturedOpts: unknown = "unset"
  const irys = {
    uploader: {
      uploadTransaction: async (_item: unknown, opts: unknown) => {
        capturedOpts = opts
      },
    },
  } as unknown as IrysUploader
  const signed = { item: {}, itemId: "id-1", sha256: "sha" } as unknown as SignedItem
  await uploadSignedItem(irys, signed)
  assert.equal(capturedOpts, undefined)
})
