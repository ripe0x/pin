/**
 * Run with: cd apps/web && ../../node_modules/.bin/tsx --test src/components/tx/tx-ui.test.ts
 * (cwd must be apps/web so tsx resolves the "@/*" path alias from its
 * tsconfig.json; running from the repo root fails with "Cannot find module
 * '@/lib/wagmi'"). Unlike parseEthAmount.test.ts, this imports tx-ui.tsx,
 * which contains JSX (Countdown/TxSuccessBanner) — Node's built-in
 * --experimental-strip-types only erases TS types, it doesn't transform JSX,
 * so plain `node --test` fails on this import. `tsx` (already a repo
 * dependency) handles both.
 *
 * Covers formatWriteError's Collection protocol error mapping. Errors are
 * constructed in the shapes viem actually produces:
 *  - a decoded custom error exposes `data.errorName` on the
 *    ContractFunctionRevertedError node in the cause chain (see
 *    viem/errors/contract.ts ContractFunctionRevertedError). This applies to
 *    both the Collection core errors (WrongPayment, ExceedsCap, ...) and
 *    GateHook.sol's NotAllowlisted/WalletCapExceeded — GateHook reverts with
 *    custom errors, not require(string), so both map through the same
 *    errorName path.
 *  - when the RPC can't ABI-decode the revert data (e.g. a raw send failure
 *    with no preflight `eth_call`), the same name still shows up literally
 *    inside `shortMessage` / `metaMessages`.
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { formatWriteError } from "./tx-ui.tsx"

// ─── decoded custom errors (data.errorName) ────────────────────────────────

test("WrongPayment maps to the stale-price copy", () => {
  const err = {
    shortMessage: "The contract function \"mintWithReferral\" reverted.",
    cause: {
      data: { errorName: "WrongPayment", args: [] },
      cause: undefined,
    },
  }
  assert.equal(
    formatWriteError(err, "Mint"),
    "The price changed since the page loaded. The quote has been refreshed, try again.",
  )
})

test("Underpayment maps to the same stale-price copy", () => {
  const err = {
    shortMessage: "reverted",
    cause: { data: { errorName: "Underpayment" }, cause: undefined },
  }
  assert.equal(
    formatWriteError(err, "Mint"),
    "The price changed since the page loaded. The quote has been refreshed, try again.",
  )
})

test("ExceedsCap maps to the sold-out-mid-tx copy", () => {
  const err = {
    shortMessage: "reverted",
    cause: { data: { errorName: "ExceedsCap" }, cause: undefined },
  }
  assert.equal(
    formatWriteError(err, "Mint"),
    "Sold out during your transaction. Gas is consumed on failed transactions.",
  )
})

test("MintNotStarted and MintEnded both map to the window-closed copy", () => {
  const notStarted = {
    shortMessage: "reverted",
    cause: { data: { errorName: "MintNotStarted" }, cause: undefined },
  }
  const ended = {
    shortMessage: "reverted",
    cause: { data: { errorName: "MintEnded" }, cause: undefined },
  }
  assert.equal(formatWriteError(notStarted, "Mint"), "The mint window is not open.")
  assert.equal(formatWriteError(ended, "Mint"), "The mint window is not open.")
})

test("HookRejected maps to a plain onchain-conditions explanation", () => {
  const err = {
    shortMessage: "reverted",
    cause: { data: { errorName: "HookRejected" }, cause: undefined },
  }
  assert.equal(
    formatWriteError(err, "Mint"),
    "This mint has additional onchain conditions that were not met.",
  )
})

// ─── GateHook custom-error reverts (data.errorName) ────────────────────────

test("NotAllowlisted maps to an allowlist explanation", () => {
  const err = {
    shortMessage: "reverted",
    cause: { data: { errorName: "NotAllowlisted" }, cause: undefined },
  }
  assert.equal(
    formatWriteError(err, "Mint"),
    "This wallet is not on the allowlist for this mint.",
  )
})

test("WalletCapExceeded maps to a per-wallet-cap explanation", () => {
  const err = {
    shortMessage: "reverted",
    cause: { data: { errorName: "WalletCapExceeded", args: [1n, 2n] }, cause: undefined },
  }
  assert.equal(
    formatWriteError(err, "Mint"),
    "This wallet has reached its per-wallet mint limit.",
  )
})

// ─── undecoded fallback: name appears only as text ─────────────────────────

test("undecoded revert still maps via literal text in shortMessage", () => {
  const err = {
    shortMessage: 'The contract function "mint" reverted with the following reason:\nWrongPayment()',
    cause: undefined,
  }
  assert.equal(
    formatWriteError(err, "Mint"),
    "The price changed since the page loaded. The quote has been refreshed, try again.",
  )
})

test("undecoded revert still maps via literal text in metaMessages", () => {
  const err = {
    shortMessage: "The contract function \"mint\" reverted.",
    metaMessages: ["Error: ExceedsCap()"],
    cause: undefined,
  }
  assert.equal(
    formatWriteError(err, "Mint"),
    "Sold out during your transaction. Gas is consumed on failed transactions.",
  )
})

test("undecoded GateHook custom error still maps via literal text", () => {
  const err = {
    shortMessage: 'The contract function "mintWithReferral" reverted with the following reason:\nNotAllowlisted()',
    cause: undefined,
  }
  assert.equal(
    formatWriteError(err, "Mint"),
    "This wallet is not on the allowlist for this mint.",
  )
})

// ─── regressions: existing generic paths are untouched ─────────────────────

test("user rejection short-circuits before the mapping walk", () => {
  const err = { message: "User rejected the request" }
  assert.equal(formatWriteError(err, "Mint"), "Transaction rejected")
})

test("insufficient funds short-circuits before the mapping walk", () => {
  const err = { message: "insufficient funds for gas * price + value" }
  assert.equal(formatWriteError(err, "Mint"), "Insufficient ETH balance")
})

test("an unknown error name falls through to the generic deepest-message copy", () => {
  const err = {
    shortMessage: "The contract function \"mint\" reverted.",
    cause: { data: { errorName: "SomeOtherError" }, cause: undefined },
  }
  assert.equal(formatWriteError(err, "Mint"), 'Mint failed: The contract function "mint" reverted.')
})

test("no cause chain at all still returns a sane generic message", () => {
  const err = { message: "Something went wrong\nsecond line" }
  assert.equal(formatWriteError(err, "Mint"), "Mint failed: Something went wrong")
})

test("non-object input returns the bare '<action> failed'", () => {
  assert.equal(formatWriteError("nope", "Mint"), "Mint failed")
  assert.equal(formatWriteError(null, "Mint"), "Mint failed")
})
