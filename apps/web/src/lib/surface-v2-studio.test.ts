/**
 * The studio's pure v2 decisions: the Launcher.launch arguments the wizard
 * sends, setter form-to-argument mapping, the renounce precondition (design
 * section 8), airdrop parsing, checks and call sequencing (section 4), and
 * the AllowlistGate activation calls.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ZERO_ADDRESS,
  ZERO_ROOT,
  airdropProblems,
  airdropRestoreTarget,
  buildAirdropCalls,
  buildLaunchArgs,
  gateActivationCalls,
  gateStatus,
  isOwner,
  isSupersededV2,
  launchFormProblems,
  minterRole,
  mintWindowProblem,
  nameArgs,
  parseAirdropRecipients,
  parseCount,
  renouncePrecondition,
  royaltyArgs,
  saleWindowLabel,
  supplyCapProblem,
  type SaleV2State,
  type SurfaceV2State,
} from "./surface-v2-studio.ts"

const NOW = 1_800_000_000
const OWNER = "0x1111111111111111111111111111111111111111" as const
const COLLECTION = "0x2222222222222222222222222222222222222222" as const
const SALE = "0x3333333333333333333333333333333333333333" as const
const GATE = "0x4444444444444444444444444444444444444444" as const
const RENDERER = "0x5555555555555555555555555555555555555555" as const
const A = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa" as const
const B = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" as const
const ROOT = ("0x" + "ab".repeat(32)) as `0x${string}`

function sale(over: Partial<SaleV2State> = {}): SaleV2State {
  return {
    address: SALE,
    canonical: true,
    price: "10000000000000000",
    mintStart: "0",
    mintEnd: "0",
    maxMints: "0",
    walletCap: "0",
    payoutRecipient: OWNER,
    gate: ZERO_ADDRESS,
    closed: false,
    totalMinted: "0",
    defaultReferrer: ZERO_ADDRESS,
    referralShareBps: 500,
    ...over,
  }
}

function state(over: Partial<SurfaceV2State> = {}): SurfaceV2State {
  return {
    primitiveV2: true,
    collection: COLLECTION,
    name: "Studies",
    symbol: "STD",
    owner: OWNER,
    renounced: false,
    renderer: RENDERER,
    minter: SALE,
    supplyCap: "10",
    minted: "3",
    royaltyBps: 500,
    royaltyReceiver: OWNER,
    sale: sale(),
    allowlistGate: GATE,
    gateRoot: ZERO_ROOT,
    gateListCount: null,
    ...over,
  }
}

// ── launch ──────────────────────────────────────────────────────────────────

test("buildLaunchArgs: empty receiver and payout go in as zero (the Launcher maps them to the owner)", () => {
  const [t, s] = buildLaunchArgs({
    name: "  Studies ",
    symbol: " STD",
    owner: OWNER,
    renderer: RENDERER,
    supplyCap: null,
    royaltyBps: 750,
    priceWei: 10n ** 16n,
    mintStart: 0n,
    mintEnd: 0n,
  })
  assert.deepEqual(t, {
    name: "Studies",
    symbol: "STD",
    owner: OWNER,
    renderer: RENDERER,
    supplyCap: 0n,
    royaltyBps: 750,
    royaltyReceiver: ZERO_ADDRESS,
  })
  assert.deepEqual(s, {
    price: 10n ** 16n,
    mintStart: 0n,
    mintEnd: 0n,
    maxMints: 0n,
    walletCap: 0n,
    payoutRecipient: ZERO_ADDRESS,
    gate: ZERO_ADDRESS,
  })
})

test("buildLaunchArgs: a capped supply, a window and an explicit payout map through", () => {
  const [t, s] = buildLaunchArgs({
    name: "S",
    symbol: "S",
    owner: OWNER,
    renderer: RENDERER,
    supplyCap: 10n,
    royaltyBps: 0,
    royaltyReceiver: "not-an-address",
    priceWei: 0n,
    mintStart: 100n,
    mintEnd: 200n,
    maxMints: 5n,
    payoutRecipient: A,
  })
  assert.equal(t.supplyCap, 10n)
  assert.equal(t.royaltyReceiver, ZERO_ADDRESS)
  assert.equal(s.payoutRecipient, A)
  assert.equal(s.maxMints, 5n)
  assert.deepEqual([s.mintStart, s.mintEnd], [100n, 200n])
})

test("launchFormProblems catches what launch would revert on", () => {
  const base = {
    name: "S",
    symbol: "S",
    owner: OWNER,
    renderer: RENDERER,
    supplyCap: null,
    royaltyBps: 500,
    priceWei: 0n,
    mintStart: 0n,
    mintEnd: 0n,
  }
  assert.deepEqual(launchFormProblems(base), [])
  assert.equal(launchFormProblems({ ...base, royaltyBps: 5001 }).length, 1)
  assert.equal(launchFormProblems({ ...base, renderer: ZERO_ADDRESS }).length, 1)
  assert.equal(launchFormProblems({ ...base, mintStart: 10n, mintEnd: 10n }).length, 1)
  assert.equal(launchFormProblems({ ...base, supplyCap: 0n }).length, 1)
  assert.equal(launchFormProblems({ ...base, name: " " }).length, 1)
})

// ── setters ─────────────────────────────────────────────────────────────────

test("mintWindowProblem mirrors FixedPriceSale._setMintWindow", () => {
  assert.equal(mintWindowProblem(0n, 0n), null)
  assert.equal(mintWindowProblem(0n, 5n), null)
  assert.equal(mintWindowProblem(10n, 0n), null)
  assert.ok(mintWindowProblem(10n, 10n))
  assert.ok(mintWindowProblem(10n, 5n))
})

test("parseCount: empty is 0 (unlimited), digits only", () => {
  assert.equal(parseCount(""), 0n)
  assert.equal(parseCount(" 12 "), 12n)
  assert.equal(parseCount("1.5"), null)
  assert.equal(parseCount("-1"), null)
})

test("supplyCapProblem: 0 is open; a nonzero cap must cover the lifetime mints", () => {
  assert.equal(supplyCapProblem(0n, 7n), null)
  assert.equal(supplyCapProblem(7n, 7n), null)
  assert.ok(supplyCapProblem(6n, 7n))
})

test("royaltyArgs: empty receiver is the owner, bps bounded by 50%", () => {
  assert.deepEqual(royaltyArgs("250", "", OWNER), { ok: true, args: [250, OWNER] })
  assert.deepEqual(royaltyArgs("0", A, OWNER), { ok: true, args: [0, A] })
  assert.equal(royaltyArgs("5001", "", OWNER).ok, false)
  assert.equal(royaltyArgs("2.5", "", OWNER).ok, false)
  assert.equal(royaltyArgs("100", ZERO_ADDRESS, OWNER).ok, false)
  assert.equal(royaltyArgs("100", "0x12", OWNER).ok, false)
})

test("nameArgs trims and requires both", () => {
  assert.deepEqual(nameArgs(" New ", " NEW "), { ok: true, args: ["New", "NEW"] })
  assert.equal(nameArgs("New", " ").ok, false)
})

// ── roles, routing ──────────────────────────────────────────────────────────

test("minterRole and isOwner", () => {
  assert.equal(minterRole(state()), "sale")
  assert.equal(minterRole(state({ minter: null, sale: null })), "none")
  assert.equal(minterRole(state({ minter: OWNER, sale: null })), "owner")
  assert.equal(minterRole(state({ minter: A, sale: null })), "other")
  assert.equal(isOwner(state(), OWNER.toUpperCase().replace("0X", "0x")), true)
  assert.equal(isOwner(state(), A), false)
  assert.equal(isOwner(state({ renounced: true, owner: ZERO_ADDRESS }), ZERO_ADDRESS), false)
})

test("isSupersededV2: only a version-2 Surface that is not primitive v2", () => {
  assert.equal(isSupersededV2({ primitiveV2: false, protocolVersion: 2 }), true)
  assert.equal(isSupersededV2({ primitiveV2: false, protocolVersion: 1 }), false)
})

// ── renounce (section 8) ────────────────────────────────────────────────────

test("renouncePrecondition: refused while the sale can stay open", () => {
  assert.equal(renouncePrecondition(state(), NOW).ok, false) // no end
  assert.equal(renouncePrecondition(state({ sale: sale({ mintEnd: String(NOW + 60) }) }), NOW).ok, false)
})

test("renouncePrecondition: allowed once the end has passed or the sale is closed", () => {
  assert.equal(renouncePrecondition(state({ sale: sale({ mintEnd: String(NOW) }) }), NOW).ok, true)
  assert.equal(renouncePrecondition(state({ sale: sale({ mintEnd: String(NOW - 1) }) }), NOW).ok, true)
  assert.equal(renouncePrecondition(state({ sale: sale({ closed: true }) }), NOW).ok, true)
})

test("renouncePrecondition: minter slot cases", () => {
  // Cleared slot: nothing can mint again, fine.
  assert.equal(renouncePrecondition(state({ minter: null, sale: null }), NOW).ok, true)
  // The owner's wallet mid-airdrop would mint forever after renounce.
  assert.equal(renouncePrecondition(state({ minter: OWNER, sale: null }), NOW).ok, false)
  // A minter the studio cannot read.
  assert.equal(renouncePrecondition(state({ minter: A, sale: null }), NOW).ok, false)
  assert.equal(renouncePrecondition(state({ renounced: true }), NOW).ok, false)
})

// ── airdrop (section 4) ─────────────────────────────────────────────────────

test("parseAirdropRecipients: one per line, optional quantity, repeats merge", () => {
  const r = parseAirdropRecipients(`${A}\n${B}, 3\n\n${A.toLowerCase()} 2\n`)
  assert.ok(r.ok)
  assert.equal(r.total, 6n)
  assert.deepEqual(
    r.recipients.map((x) => [x.to.toLowerCase(), x.quantity]),
    [
      [A.toLowerCase(), 3n],
      [B.toLowerCase(), 3n],
    ],
  )
  assert.equal(parseAirdropRecipients("").ok, false)
  assert.equal(parseAirdropRecipients("0x12").ok, false)
  assert.equal(parseAirdropRecipients(`${A}, 0`).ok, false)
  assert.equal(parseAirdropRecipients(`${A}, 1, 2`).ok, false)
  assert.equal(parseAirdropRecipients(ZERO_ADDRESS).ok, false)
})

test("buildAirdropCalls: take the slot, mint each, hand it back to the sale", () => {
  const calls = buildAirdropCalls({
    owner: OWNER,
    currentMinter: SALE,
    restoreTo: SALE,
    recipients: [
      { to: A, quantity: 1n },
      { to: B, quantity: 2n },
    ],
  })
  assert.deepEqual(
    calls.map((c) => [c.functionName, ...c.args]),
    [
      ["setMinter", OWNER],
      ["mintTo", A, 1n],
      ["mintTo", B, 2n],
      ["setMinter", SALE],
    ],
  )
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["takeSlot", "mint", "mint", "restoreSlot"],
  )
})

test("buildAirdropCalls: resuming with the owner already holding the slot skips the take", () => {
  const calls = buildAirdropCalls({ owner: OWNER, currentMinter: OWNER, restoreTo: SALE, recipients: [{ to: A, quantity: 1n }] })
  assert.deepEqual(
    calls.map((c) => c.functionName),
    ["mintTo", "setMinter"],
  )
  // Restore only (no recipients): one call.
  assert.deepEqual(
    buildAirdropCalls({ owner: OWNER, currentMinter: OWNER, restoreTo: SALE, recipients: [] }).map((c) => c.id),
    ["restore-slot"],
  )
})

test("airdropRestoreTarget: the current minter, else the remembered sale, never the owner", () => {
  assert.equal(airdropRestoreTarget(state(), null), SALE)
  assert.equal(airdropRestoreTarget(state({ minter: OWNER }), SALE), SALE)
  assert.equal(airdropRestoreTarget(state({ minter: OWNER }), OWNER), null)
  assert.equal(airdropRestoreTarget(state({ minter: OWNER }), "junk"), null)
  assert.equal(airdropRestoreTarget(state({ minter: OWNER }), null), null)
})

test("airdropProblems: owner only, supply cap headroom, no self-custody", () => {
  const two = [
    { to: A, quantity: 1n },
    { to: B, quantity: 1n },
  ]
  assert.deepEqual(airdropProblems(state(), OWNER, two), [])
  assert.equal(airdropProblems(state(), A, two).length, 1)
  // 3 minted of 10: 8 more does not fit.
  assert.equal(airdropProblems(state(), OWNER, [{ to: A, quantity: 8n }]).length, 1)
  assert.deepEqual(airdropProblems(state(), OWNER, [{ to: A, quantity: 7n }]), [])
  // Open supply: no ceiling.
  assert.deepEqual(airdropProblems(state({ supplyCap: "0" }), OWNER, [{ to: A, quantity: 1000n }]), [])
  assert.equal(airdropProblems(state(), OWNER, [{ to: COLLECTION, quantity: 1n }]).length, 1)
  assert.equal(airdropProblems(state({ renounced: true }), OWNER, two).length, 1)
})

// ── mint gate ───────────────────────────────────────────────────────────────

test("gateStatus", () => {
  assert.equal(gateStatus(state()), "none")
  assert.equal(gateStatus(state({ sale: sale({ gate: GATE }) })), "allowlist-unset")
  assert.equal(gateStatus(state({ sale: sale({ gate: GATE }), gateRoot: ROOT })), "allowlist")
  assert.equal(gateStatus(state({ sale: sale({ gate: A }) })), "other")
})

test("gateActivationCalls: root first, then point the sale at the gate unless it already is", () => {
  const both = gateActivationCalls({ collection: COLLECTION, allowlistGate: GATE, sale: SALE, currentGate: ZERO_ADDRESS, root: ROOT })
  assert.deepEqual(
    both.map((c) => [c.to, c.functionName, ...c.args]),
    [
      [GATE, "setRoot", COLLECTION, ROOT],
      [SALE, "setGate", GATE],
    ],
  )
  const rootOnly = gateActivationCalls({ collection: COLLECTION, allowlistGate: GATE, sale: SALE, currentGate: GATE, root: ROOT })
  assert.deepEqual(
    rootOnly.map((c) => c.id),
    ["set-root"],
  )
})

test("saleWindowLabel", () => {
  assert.equal(saleWindowLabel(sale(), NOW), "Open")
  assert.equal(saleWindowLabel(sale({ closed: true }), NOW), "Closed")
  assert.equal(saleWindowLabel(sale({ mintStart: String(NOW + 1) }), NOW), "Scheduled")
  assert.equal(saleWindowLabel(sale({ mintEnd: String(NOW) }), NOW), "Ended")
})
