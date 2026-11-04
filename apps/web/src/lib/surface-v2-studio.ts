/**
 * The studio's pure decisions for primitive-first Surface v2 collections
 * (contracts/src/surface/v2, docs/pnd-surface-v2-design.md): the state shape
 * the studio panels read, the Launcher.launch arguments the create wizard
 * sends, the renounce precondition (design section 8), the airdrop call
 * sequence (section 4), and the form-to-argument mapping of each setter.
 *
 * No React, no server-only imports, no I/O: shared by the API route, the
 * client panels and the unit tests.
 */
import { isAddress, type Address } from "viem"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
export const ZERO_ROOT = ("0x" + "0".repeat(64)) as `0x${string}`

/** Surface.MAX_ROYALTY_BPS. */
export const V2_MAX_ROYALTY_BPS = 5_000

const lc = (a: string) => a.toLowerCase()
const isZero = (a: string | null | undefined) => !a || lc(a) === ZERO_ADDRESS

// ── State (what GET /api/collections/[address]/v2 returns) ──────────────────

/** A FixedPriceSale's live config. bigints as decimal strings. */
export type SaleV2State = {
  address: Address
  /** Made by the configured v2 sale CloneFactory; null when no sale
   *  factory is configured on this network. */
  canonical: boolean | null
  price: string
  mintStart: string
  mintEnd: string
  maxMints: string
  walletCap: string
  payoutRecipient: Address
  gate: Address
  closed: boolean
  /** Mints through this sale. Owner airdrops never count here. */
  totalMinted: string
  defaultReferrer: Address
  referralShareBps: number
}

export type SurfaceV2State = {
  primitiveV2: true
  collection: Address
  name: string
  symbol: string
  /** The zero address once renounced. */
  owner: Address
  renounced: boolean
  renderer: Address
  /** The single minter slot; null when cleared (nobody can mint). */
  minter: Address | null
  supplyCap: string
  /** Lifetime mints (burns included): the count supplyCap bounds. */
  minted: string
  royaltyBps: number
  royaltyReceiver: Address
  /** The current minter, read as a FixedPriceSale bound to this collection.
   *  Null when the minter is not one (cleared, the owner's wallet mid-
   *  airdrop, or a bespoke minter). */
  sale: SaleV2State | null
  /** The network's AllowlistGate singleton, null when not configured. */
  allowlistGate: Address | null
  /** AllowlistGate.root(collection); the zero root when unset or no gate
   *  singleton is configured. */
  gateRoot: `0x${string}`
  /** Size of the published list stored for gateRoot, null when none. */
  gateListCount: number | null
}

/** GET /api/collections/[address]/v2 for a collection that is not a
 *  primitive v2 Surface: the panels route it to the v1 tools (or the
 *  superseded-v2 notice) by this version. */
export type NotV2State = { primitiveV2: false; protocolVersion: number }

/** The superseded August SurfaceFactoryV2 collections (Sepolia only)
 *  answer version() 2 without being primitive v2. The studio shows them a
 *  read-only notice instead of writing through an ABI they no longer
 *  match. */
export function isSupersededV2(s: NotV2State): boolean {
  return s.protocolVersion === 2
}

export function isOwner(state: Pick<SurfaceV2State, "owner" | "renounced">, account: string | null | undefined): boolean {
  return !state.renounced && !!account && lc(account) === lc(state.owner)
}

/** What currently holds the single minter slot, for display and gating. */
export type MinterRole = "none" | "sale" | "owner" | "other"
export function minterRole(state: Pick<SurfaceV2State, "minter" | "owner" | "sale">): MinterRole {
  if (isZero(state.minter)) return "none"
  if (state.sale && lc(state.sale.address) === lc(state.minter!)) return "sale"
  if (lc(state.minter!) === lc(state.owner)) return "owner"
  return "other"
}

// ── Create: Launcher.launch arguments ───────────────────────────────────────

export type LaunchForm = {
  name: string
  symbol: string
  owner: Address
  renderer: Address
  /** null = open supply. */
  supplyCap: bigint | null
  royaltyBps: number
  /** Empty = the owner (the Launcher maps a zero receiver to the owner). */
  royaltyReceiver?: string
  priceWei: bigint
  mintStart: bigint
  mintEnd: bigint
  maxMints?: bigint
  walletCap?: bigint
  /** Empty = the owner (the Launcher maps a zero recipient to the owner). */
  payoutRecipient?: string
  gate?: Address | null
}

export type LaunchTokenParams = {
  name: string
  symbol: string
  owner: Address
  renderer: Address
  supplyCap: bigint
  royaltyBps: number
  royaltyReceiver: Address
}
export type LaunchSaleParams = {
  price: bigint
  mintStart: bigint
  mintEnd: bigint
  maxMints: bigint
  walletCap: bigint
  payoutRecipient: Address
  gate: Address
}

function addrOrZero(raw: string | null | undefined): Address {
  const t = (raw ?? "").trim()
  return (t !== "" && isAddress(t) ? t : ZERO_ADDRESS) as Address
}

/** The two structs Launcher.launch takes. Zero receiver and zero payout are
 *  passed through as zero on purpose: the Launcher resolves both to the
 *  owner, so the wizard never has to know who that is. */
export function buildLaunchArgs(f: LaunchForm): readonly [LaunchTokenParams, LaunchSaleParams] {
  return [
    {
      name: f.name.trim(),
      symbol: f.symbol.trim(),
      owner: f.owner,
      renderer: f.renderer,
      supplyCap: f.supplyCap ?? 0n,
      royaltyBps: f.royaltyBps,
      royaltyReceiver: addrOrZero(f.royaltyReceiver),
    },
    {
      price: f.priceWei,
      mintStart: f.mintStart,
      mintEnd: f.mintEnd,
      maxMints: f.maxMints ?? 0n,
      walletCap: f.walletCap ?? 0n,
      payoutRecipient: addrOrZero(f.payoutRecipient),
      gate: (f.gate ?? ZERO_ADDRESS) as Address,
    },
  ] as const
}

/** Problems the contracts would revert on, caught before the wallet. */
export function launchFormProblems(f: LaunchForm): string[] {
  const out: string[] = []
  if (f.name.trim() === "" || f.symbol.trim() === "") out.push("Name and symbol are required.")
  if (!isAddress(f.renderer) || isZero(f.renderer)) out.push("A renderer contract is required.")
  if (f.royaltyBps < 0 || f.royaltyBps > V2_MAX_ROYALTY_BPS) out.push("Royalty cannot exceed 50%.")
  if (f.supplyCap !== null && f.supplyCap <= 0n) out.push("A capped supply needs a cap above 0.")
  const w = mintWindowProblem(f.mintStart, f.mintEnd)
  if (w) out.push(w)
  return out
}

// ── Setters: form value to argument ─────────────────────────────────────────

/** FixedPriceSale._setMintWindow: a nonzero end must be after the start.
 *  A zero start means open now, a zero end means no end. */
export function mintWindowProblem(start: bigint, end: bigint): string | null {
  if (end !== 0n && end <= start) return "End must be after start."
  return null
}

/** Whole non-negative number from a text field; empty = 0 (the contracts'
 *  "unlimited" / "open" value). Null when it is not one. */
export function parseCount(raw: string): bigint | null {
  const t = raw.trim()
  if (t === "") return 0n
  if (!/^\d+$/.test(t)) return null
  return BigInt(t)
}

/** Surface.setSupplyCap: 0 = open, else at least the lifetime mint count. */
export function supplyCapProblem(cap: bigint, minted: bigint): string | null {
  if (cap !== 0n && cap < minted) return `The cap cannot be below the ${minted} already minted.`
  return null
}

/** Surface.setRoyalty arguments. An empty receiver means the owner (v2 has
 *  no zero-receiver sentinel: the token rejects a zero receiver). */
export function royaltyArgs(
  bpsRaw: string,
  receiverRaw: string,
  owner: Address,
): { ok: true; args: readonly [number, Address] } | { ok: false; error: string } {
  const bps = parseCount(bpsRaw)
  if (bps === null) return { ok: false, error: "Basis points must be a whole number." }
  if (bps > BigInt(V2_MAX_ROYALTY_BPS)) return { ok: false, error: "Basis points cannot exceed 5000 (50%)." }
  const r = receiverRaw.trim()
  const receiver = r === "" ? owner : r
  if (!isAddress(receiver) || isZero(receiver)) return { ok: false, error: "Not a valid receiver address." }
  return { ok: true, args: [Number(bps), receiver as Address] as const }
}

/** Surface.setName arguments: both required, trimmed. */
export function nameArgs(
  nameRaw: string,
  symbolRaw: string,
): { ok: true; args: readonly [string, string] } | { ok: false; error: string } {
  const name = nameRaw.trim()
  const symbol = symbolRaw.trim()
  if (name === "" || symbol === "") return { ok: false, error: "Name and symbol are both required." }
  return { ok: true, args: [name, symbol] as const }
}

// ── Renounce (design section 8) ─────────────────────────────────────────────

export type RenounceCheck = { ok: true; note: string } | { ok: false; reason: string }

/**
 * The studio's renounce precondition. Renouncing freezes every token setter
 * and, through borrowed authority, every sale setter, so it is offered only
 * once the sale can no longer stay open forever: its mint end has passed or
 * it is closed. A cleared minter slot is fine (nothing can mint again); the
 * owner's own wallet in the slot (an airdrop in progress) or a minter the
 * studio cannot read would be frozen in place, so both are refused.
 */
export function renouncePrecondition(
  state: Pick<SurfaceV2State, "renounced" | "minter" | "owner" | "sale">,
  nowSec: number,
): RenounceCheck {
  if (state.renounced) return { ok: false, reason: "Ownership is already renounced." }
  const role = minterRole(state)
  if (role === "none") {
    return { ok: true, note: "No minter is set, so nothing can ever mint after you renounce." }
  }
  if (role === "owner") {
    return {
      ok: false,
      reason:
        "Your wallet holds the minter slot (an airdrop that did not finish). Renouncing now would let this wallet mint forever. Restore the sale as minter, or clear the minter, first.",
    }
  }
  if (role === "other") {
    return {
      ok: false,
      reason:
        "The minter is not a PND sale for this collection, so its end cannot be checked here. Clear the minter or point it at a closed sale first.",
    }
  }
  const sale = state.sale!
  if (sale.closed) return { ok: true, note: "The sale is closed." }
  const end = BigInt(sale.mintEnd)
  if (end !== 0n && BigInt(nowSec) >= end) return { ok: true, note: "The sale's mint end has passed." }
  return {
    ok: false,
    reason:
      end === 0n
        ? "The sale has no mint end, so it would stay open forever with nobody able to close it. Close the sale, or set a mint end and wait for it to pass, first."
        : "The sale's mint end has not passed yet. Wait for it, or close the sale, first.",
  }
}

// ── Airdrop / artist proofs (design section 4) ─────────────────────────────

export type AirdropRecipient = { to: Address; quantity: bigint }

/**
 * Parse the airdrop textarea: one recipient per line, `address` (one token)
 * or `address, quantity` / `address quantity`. Repeated addresses merge.
 */
export function parseAirdropRecipients(
  raw: string,
): { ok: true; recipients: AirdropRecipient[]; total: bigint } | { ok: false; error: string } {
  const lines = raw
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return { ok: false, error: "Add at least one recipient." }
  const merged = new Map<string, AirdropRecipient>()
  for (const line of lines) {
    const [addr, qtyRaw, ...rest] = line.split(/[\s,]+/).filter(Boolean)
    if (rest.length > 0 || !addr || !isAddress(addr)) return { ok: false, error: `Not a recipient line: ${line.slice(0, 64)}` }
    if (isZero(addr)) return { ok: false, error: "The zero address cannot receive a token." }
    const qty = qtyRaw === undefined ? 1n : parseCount(qtyRaw)
    if (qty === null || qty === 0n) return { ok: false, error: `Quantity must be a whole number above 0: ${line.slice(0, 64)}` }
    const key = lc(addr)
    const prev = merged.get(key)
    merged.set(key, { to: (prev?.to ?? addr) as Address, quantity: (prev?.quantity ?? 0n) + qty })
  }
  const recipients = [...merged.values()]
  return { ok: true, recipients, total: recipients.reduce((s, r) => s + r.quantity, 0n) }
}

/** Everything that would make the airdrop revert, checked before signing. */
export function airdropProblems(
  state: Pick<SurfaceV2State, "collection" | "owner" | "renounced" | "supplyCap" | "minted">,
  account: string | null | undefined,
  recipients: AirdropRecipient[],
): string[] {
  const out: string[] = []
  if (state.renounced) out.push("Ownership is renounced: the minter slot can no longer change.")
  else if (!account || lc(account) !== lc(state.owner)) out.push("Only the collection owner can airdrop.")
  if (recipients.some((r) => lc(r.to) === lc(state.collection))) {
    out.push("The collection's own address cannot hold its tokens.")
  }
  const total = recipients.reduce((s, r) => s + r.quantity, 0n)
  const cap = BigInt(state.supplyCap)
  const minted = BigInt(state.minted)
  if (cap !== 0n && minted + total > cap) {
    out.push(`That is ${total} tokens, but only ${cap - minted} remain under the supply cap of ${cap}.`)
  }
  return out
}

export type AirdropCall =
  | { id: string; kind: "takeSlot"; functionName: "setMinter"; args: readonly [Address] }
  | { id: string; kind: "mint"; functionName: "mintTo"; args: readonly [Address, bigint] }
  | { id: string; kind: "restoreSlot"; functionName: "setMinter"; args: readonly [Address] }

/**
 * The airdrop as ordered calls, all to the collection:
 * setMinter(owner), one mintTo per recipient, setMinter(restore). The slot is
 * taken only when the owner does not already hold it (resuming a run that
 * stopped half way), and always handed back to `restoreTo`: the sale (or
 * whatever held the slot before). Owner mints go straight to the token, so
 * they count toward supplyCap and never toward the sale's maxMints.
 */
export function buildAirdropCalls(p: {
  owner: Address
  currentMinter: Address | null
  restoreTo: Address
  recipients: AirdropRecipient[]
}): AirdropCall[] {
  const calls: AirdropCall[] = []
  const ownerHolds = !!p.currentMinter && lc(p.currentMinter) === lc(p.owner)
  if (!ownerHolds) calls.push({ id: "take-slot", kind: "takeSlot", functionName: "setMinter", args: [p.owner] as const })
  p.recipients.forEach((r, i) => {
    calls.push({ id: `mint-${i}`, kind: "mint", functionName: "mintTo", args: [r.to, r.quantity] as const })
  })
  calls.push({ id: "restore-slot", kind: "restoreSlot", functionName: "setMinter", args: [p.restoreTo] as const })
  return calls
}

/** The address the airdrop hands the slot back to: the current minter when
 *  it is not the owner (normally the sale); otherwise the sale address the
 *  artist confirms (a run that stopped with the owner still holding it). */
export function airdropRestoreTarget(
  state: Pick<SurfaceV2State, "minter" | "owner">,
  remembered: string | null | undefined,
): Address | null {
  if (state.minter && lc(state.minter) !== lc(state.owner)) return state.minter
  const r = (remembered ?? "").trim()
  if (r !== "" && isAddress(r) && lc(r) !== lc(state.owner)) return r as Address
  return null
}

// ── Mint gate (AllowlistGate) ───────────────────────────────────────────────

export type GateStatus = "none" | "allowlist" | "allowlist-unset" | "other"

/** How the sale is gated: not at all, by the AllowlistGate with a root set,
 *  by the AllowlistGate with no root (every mint fails), or by a gate the
 *  studio does not manage. */
export function gateStatus(state: Pick<SurfaceV2State, "sale" | "allowlistGate" | "gateRoot">): GateStatus {
  const gate = state.sale?.gate
  if (isZero(gate)) return "none"
  if (state.allowlistGate && lc(gate!) === lc(state.allowlistGate)) {
    return state.gateRoot === ZERO_ROOT ? "allowlist-unset" : "allowlist"
  }
  return "other"
}

/** The calls that activate a published list: setRoot on the AllowlistGate
 *  (authority: the collection owner) and, unless the sale already points at
 *  it, setGate on the sale. Order matters only for the reader: the gate
 *  rejects every mint until a root is set, so the root goes first. */
export type GateActivationCall =
  | { id: "set-root"; to: Address; target: "gate"; functionName: "setRoot"; args: readonly [Address, `0x${string}`] }
  | { id: "set-gate"; to: Address; target: "sale"; functionName: "setGate"; args: readonly [Address] }

export function gateActivationCalls(p: {
  collection: Address
  allowlistGate: Address
  sale: Address
  currentGate: Address
  root: `0x${string}`
}): GateActivationCall[] {
  const calls: GateActivationCall[] = [
    { id: "set-root", to: p.allowlistGate, target: "gate", functionName: "setRoot", args: [p.collection, p.root] as const },
  ]
  if (lc(p.currentGate) !== lc(p.allowlistGate)) {
    calls.push({ id: "set-gate", to: p.sale, target: "sale", functionName: "setGate", args: [p.allowlistGate] as const })
  }
  return calls
}

// ── Display helpers ─────────────────────────────────────────────────────────

/** "Open", "Scheduled", "Ended", or "Closed" for the sale card. */
export function saleWindowLabel(sale: Pick<SaleV2State, "closed" | "mintStart" | "mintEnd">, nowSec: number): string {
  if (sale.closed) return "Closed"
  const start = BigInt(sale.mintStart)
  const end = BigInt(sale.mintEnd)
  const now = BigInt(nowSec)
  if (end !== 0n && now >= end) return "Ended"
  if (start !== 0n && now < start) return "Scheduled"
  return "Open"
}
