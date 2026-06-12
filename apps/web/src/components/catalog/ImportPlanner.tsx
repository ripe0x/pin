"use client"

import { useEffect, useMemo, useState } from "react"
import { useAccount } from "wagmi"
import type { Address } from "viem"
import type {
  CatalogOp,
  NormalizedPlan,
  RawWork,
  SkippedWork,
} from "@/lib/import-sources/types"
import { chunkOps, OPS_PER_TX } from "@/lib/import-sources/normalize"
import {
  isSharedContract,
  sharedContractInfo,
} from "@/lib/import-sources/shared-contracts"
import { useCatalogMulticall } from "./useCatalogMulticall"
import { useThumbnailMedia } from "@/lib/use-thumbnail-media"

/**
 * Import planner.
 *
 *  - Renders the normalized plan grouped by contract.
 *  - Each entry has a checkbox; toggling recomputes the live summary.
 *  - On submit, the selected entries are chunked at `OPS_PER_TX` and
 *    sent sequentially as `multicall(bytes[])` txs by the hook; each
 *    chunk's receipt is awaited before the next is signed.
 *  - Wallet gate: button disabled until the connected wallet equals
 *    the artist address.
 *
 * Designed to be artist-self-service. No operator support in v1 —
 * artists who can't connect their key today won't use this page.
 */
type Props = {
  artistAddress: Address
  sourceName: string
  sourceUrl: string
  plan: NormalizedPlan
  fetchError: string | null
  /**
   * When true, the planner skips its own page-style header (eyebrow + h1
   * + source description) and skips the outer max-width wrapper. The
   * embedding parent owns the section title. Used by IndexedWorkSection
   * on `/catalog/[address]` to avoid duplicate titles.
   */
  embedded?: boolean
}

type EntryKey = string
type ContractMode = "specific" | "whole"

function entryKey(op: CatalogOp): EntryKey {
  if (op.kind === "addToken") {
    return `t:${op.contract}:${op.tokenId.toString()}`
  }
  if (op.kind === "addTokenRange") {
    return `r:${op.contract}:${op.start.toString()}-${op.end.toString()}`
  }
  return `c:${op.contract}`
}

function tokenCount(op: CatalogOp): number {
  // For "tokens claimed" summary. addContract is open-ended on-chain
  // (claims all current + future), so we use the sum of the specific
  // entries it consolidates — a lower bound the artist can verify
  // against the source registry.
  if (op.kind === "addToken") return 1
  if (op.kind === "addTokenRange") return Number(op.end - op.start + 1n)
  return op.works.reduce((n, w) => {
    if (w.tokenIdStart !== undefined && w.tokenIdEnd !== undefined) {
      return n + Number(w.tokenIdEnd - w.tokenIdStart + 1n)
    }
    if (w.tokenIds && w.tokenIds.length > 0) return n + w.tokenIds.length
    if (w.tokenId !== undefined) return n + 1
    return n
  }, 0)
}

export function ImportPlanner({
  artistAddress,
  sourceName,
  sourceUrl,
  plan,
  fetchError,
  embedded = false,
}: Props) {
  const { address: connected, isConnected } = useAccount()
  const walletMatches =
    !!connected && connected.toLowerCase() === artistAddress.toLowerCase()

  // Extra ops added inline by the artist via the "Add a contract we
  // missed" affordance at the bottom of the planner. Merged into
  // effectiveOps so they ride the same multicall as the pre-fill
  // selection. Stable EntryKey via the standard entryKey() helper.
  const [extraOps, setExtraOps] = useState<CatalogOp[]>([])
  const addExtraOp = (op: CatalogOp) => {
    setExtraOps((prev) => {
      const k = entryKey(op)
      if (prev.some((p) => entryKey(p) === k)) return prev
      return [...prev, op]
    })
  }
  const removeExtraOp = (k: EntryKey) => {
    setExtraOps((prev) => prev.filter((p) => entryKey(p) !== k))
  }

  // Default all entries selected (pre-fill + extras). The artist
  // explicitly unchecks ones they want to skip — matches the "land +
  // click" expectation in the brief better than "land + check every
  // box".
  const allKeys = useMemo(
    () => [...plan.ops, ...extraOps].map(entryKey),
    [plan.ops, extraOps],
  )
  const [selected, setSelected] = useState<Set<EntryKey>>(
    () => new Set(allKeys),
  )

  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const k of allKeys) next.add(k)
      return next
    })
  }, [allKeys])

  // Per-contract mode: "specific" (default, safe — emits the per-entry
  // ops) or "whole" (consolidates into one `addContract(c)`). The
  // toggle is suppressed for known shared-platform contracts (see
  // shared-contracts.ts) so an artist can't accidentally claim other
  // people's tokens. Mode survives re-renders but resets when the plan
  // identity changes.
  const groupedOps = useMemo(
    () => groupByContract([...plan.ops, ...extraOps]),
    [plan.ops, extraOps],
  )
  const [contractMode, setContractMode] = useState<
    Record<Address, ContractMode>
  >({})
  // In "whole" mode, the entire contract becomes a single addContract
  // op. Track per-contract selection so the artist can opt OUT of a
  // whole contract without flipping back to specific mode + unchecking
  // every token. Defaults to all whole-mode contracts selected.
  const [selectedContracts, setSelectedContracts] = useState<Set<Address>>(
    () => new Set(),
  )
  // Default per-contract mode: "whole" when EVERY underlying work for
  // that contract carries `claimWholeContract: true` (signaled by the
  // adapter when the artist owns the contract). Shared-platform
  // contracts and any contract with mixed signals stay in "specific"
  // mode. Re-evaluated whenever the plan identity changes.
  useEffect(() => {
    const nextMode: Record<Address, ContractMode> = {}
    const nextSelected = new Set<Address>()
    for (const { contract, ops } of groupedOps) {
      if (isSharedContract(contract)) continue
      const allWorks = ops.flatMap((op) => op.works)
      if (allWorks.length === 0) continue
      const allClaim = allWorks.every((w) => w.claimWholeContract === true)
      if (allClaim) {
        nextMode[contract] = "whole"
        nextSelected.add(contract)
      }
    }
    setContractMode(nextMode)
    setSelectedContracts(nextSelected)
  }, [groupedOps])

  const setMode = (contract: Address, mode: ContractMode) => {
    setContractMode((prev) => ({ ...prev, [contract]: mode }))
    // When flipping INTO whole mode, opt the contract in by default.
    if (mode === "whole") {
      setSelectedContracts((prev) => {
        const next = new Set(prev)
        next.add(contract)
        return next
      })
    }
  }

  const toggleContract = (contract: Address) => {
    setSelectedContracts((prev) => {
      const next = new Set(prev)
      if (next.has(contract)) next.delete(contract)
      else next.add(contract)
      return next
    })
  }

  const toggle = (key: EntryKey) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /**
   * Walk each contract group and emit the effective ops based on the
   * current mode. Specific mode: filter by checkbox state. Whole mode:
   * one `addContract` op carrying the source `works` along for the
   * UI. Order preserved per contract group → stable chunk layout.
   */
  const effectiveOps = useMemo<CatalogOp[]>(() => {
    const out: CatalogOp[] = []
    for (const { contract, ops } of groupedOps) {
      const mode = contractMode[contract] ?? "specific"
      if (mode === "whole" && !isSharedContract(contract)) {
        // Whole-mode contracts are gated by the contract-level checkbox.
        // Unchecked = skip this contract entirely.
        if (!selectedContracts.has(contract)) continue
        const allWorks = ops.flatMap((op) => op.works)
        out.push({ kind: "addContract", contract, works: allWorks })
      } else {
        for (const op of ops) {
          if (selected.has(entryKey(op))) out.push(op)
        }
      }
    }
    return out
  }, [groupedOps, contractMode, selected])

  const selectedTokenCount = effectiveOps.reduce(
    (n, op) => n + tokenCount(op),
    0,
  )
  const chunks = useMemo(() => chunkOps(effectiveOps), [effectiveOps])

  const wholeContractCount = useMemo(
    () =>
      Object.values(contractMode).filter((m) => m === "whole").length,
    [contractMode],
  )

  // `pb-32` reserves space for the fixed-position SubmitBar so the last
  // row isn't hidden behind it. Standalone page needs it because the
  // planner IS the page; embedded panels don't because the host page
  // continues past them and provides its own bottom space.
  const containerClass = embedded
    ? ""
    : "mx-auto max-w-5xl px-6 py-10 pb-32"

  return (
    <div className={containerClass}>
      {!embedded && (
        <header className="mb-8">
          <p className="text-xs uppercase tracking-widest text-gray-500">
            Catalog import
          </p>
          <h1 className="text-3xl font-semibold mt-1">
            Import {sourceName}&rsquo;s registry to Catalog
          </h1>
          <p className="text-gray-600 mt-3 text-sm leading-relaxed">
            Source:{" "}
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-gray-900"
            >
              {sourceUrl}
            </a>
            . Reviewed against the on-chain Catalog for{" "}
            <span className="font-mono text-xs">{artistAddress}</span>. Anything
            already declared on-chain is skipped automatically.
          </p>
        </header>
      )}

      {fetchError && (
        <div className="mb-6 border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 rounded-md text-sm">
          Could not fetch the source registry: {fetchError}
        </div>
      )}

      <SummaryChips
        entries={effectiveOps.length}
        selectedTokenCount={selectedTokenCount}
        chunks={chunks.length}
        alreadyIndexed={plan.alreadyIndexed.length}
        nonMainnet={plan.nonMainnet.length}
        unparseable={plan.unparseable.length}
        offChain={plan.offChain.length}
        wholeContracts={wholeContractCount}
      />

      {plan.ops.length === 0 ? (
        <NothingToDo
          alreadyIndexed={plan.alreadyIndexed.length}
          nonMainnet={plan.nonMainnet.length}
          unparseable={plan.unparseable.length}
          offChain={plan.offChain.length}
        />
      ) : (
        (() => {
          // Split contracts into two visual categories:
          //   - "Whole contract" group: owner-controlled contracts (artist
          //     deployed or owns). The claim shape is identical for every
          //     row, so we render them as a single flat list with ONE
          //     explanation header and tight per-row chrome (no section
          //     box per contract, no repeating description sentence).
          //   - Everything else: shared-platform per-token claims, plus
          //     adapter rows that don't carry a claimWholeContract hint
          //     (Brinkman, etc.) — keep the existing per-contract section
          //     with the mode toggle since those rows have real choices.
          const wholeGroups: typeof groupedOps = []
          const sharedGroups: typeof groupedOps = []
          const otherGroups: typeof groupedOps = []
          for (const g of groupedOps) {
            if (isSharedContract(g.contract)) {
              sharedGroups.push(g)
              continue
            }
            const allWorks = g.ops.flatMap((op) => op.works)
            const allClaim =
              allWorks.length > 0 &&
              allWorks.every((w) => w.claimWholeContract === true)
            if (allClaim) wholeGroups.push(g)
            else otherGroups.push(g)
          }
          return (
            <div className="mt-8 space-y-6">
              {wholeGroups.length > 0 && (
                <WholeContractsList
                  groups={wholeGroups}
                  selectedContracts={selectedContracts}
                  onSetSelected={setSelectedContracts}
                />
              )}
              {sharedGroups.length > 0 && (
                <SharedTokensList
                  groups={sharedGroups}
                  selected={selected}
                  onToggle={toggle}
                  onSetSelected={setSelected}
                />
              )}
              {otherGroups.map(({ contract, ops }) => (
                <ContractGroup
                  key={contract}
                  contract={contract}
                  ops={ops}
                  selected={selected}
                  onToggle={toggle}
                  mode={contractMode[contract] ?? "specific"}
                  onModeChange={(m) => setMode(contract, m)}
                  wholeContractSelected={selectedContracts.has(contract)}
                  onToggleWholeContract={() => toggleContract(contract)}
                />
              ))}
              <section className="border border-gray-200 rounded-md overflow-hidden">
                <BatchAddRow onAdd={addExtraOp} />
              </section>
            </div>
          )
        })()
      )}

      <OffChainNotice offChain={plan.offChain} />

      <SkippedSections plan={plan} />

      {plan.ops.length > 0 && (
        <SubmitBar
          artistAddress={artistAddress}
          isConnected={isConnected}
          walletMatches={walletMatches}
          selectedOps={effectiveOps}
          chunks={chunks}
        />
      )}
    </div>
  )
}

function SummaryChips({
  entries,
  selectedTokenCount,
  chunks,
  alreadyIndexed,
  nonMainnet,
  unparseable,
  offChain,
  wholeContracts,
}: {
  entries: number
  selectedTokenCount: number
  chunks: number
  alreadyIndexed: number
  nonMainnet: number
  unparseable: number
  offChain: number
  wholeContracts: number
}) {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <Chip
        label={`${entries} new ${pluralize("entry", "entries", entries)}`}
        tone="primary"
      />
      <Chip
        label={`${selectedTokenCount}+ ${pluralize("token", "tokens", selectedTokenCount)} selected`}
        tone="primary"
      />
      <Chip
        label={`${chunks} ${pluralize("transaction", "transactions", chunks)} (≤${OPS_PER_TX} entries each)`}
        tone="muted"
      />
      {wholeContracts > 0 && (
        <Chip
          label={`${wholeContracts} whole-contract ${pluralize("claim", "claims", wholeContracts)}`}
          tone="primary"
        />
      )}
      {alreadyIndexed > 0 && (
        <Chip label={`${alreadyIndexed} already in catalog`} tone="muted" />
      )}
      {nonMainnet > 0 && (
        <Chip label={`${nonMainnet} skipped (non-mainnet)`} tone="muted" />
      )}
      {offChain > 0 && (
        <Chip
          label={`${offChain} ${pluralize("off-chain work", "off-chain works", offChain)}`}
          tone="muted"
        />
      )}
      {unparseable > 0 && (
        <Chip label={`${unparseable} skipped (no tokenId)`} tone="muted" />
      )}
    </div>
  )
}

function pluralize(singular: string, plural: string, n: number) {
  return n === 1 ? singular : plural
}

function Chip({ label, tone }: { label: string; tone: "primary" | "muted" }) {
  const cls =
    tone === "primary"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
      : "border-gray-300 bg-gray-50 text-gray-600"
  return (
    <span
      className={`inline-flex items-center border px-2 py-1 rounded-md ${cls}`}
    >
      {label}
    </span>
  )
}

/**
 * Top-of-page callout for the artist's off-chain works (physical
 * prints, Tezos/Flow/Bitcoin entries, anything without an EVM
 * contract+tokenId). Catalog.sol only indexes EVM pointers, so these
 * can't be represented on-chain — but the artist should know we
 * recognized them and intentionally excluded them rather than missed
 * them.
 */
function OffChainNotice({ offChain }: { offChain: SkippedWork[] }) {
  if (offChain.length === 0) return null
  const counts: Record<SkippedWork["reason"], number> = {
    "physical": 0,
    "off-chain": 0,
    "non-evm-chain": 0,
  }
  for (const w of offChain) counts[w.reason]++
  const parts: string[] = []
  if (counts["physical"] > 0)
    parts.push(`${counts["physical"]} physical / print`)
  if (counts["non-evm-chain"] > 0)
    parts.push(`${counts["non-evm-chain"]} on non-EVM chains`)
  if (counts["off-chain"] > 0)
    parts.push(`${counts["off-chain"]} other off-chain`)
  return (
    <div className="mt-8 border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 rounded-md text-xs leading-relaxed">
      <span className="font-semibold">
        {offChain.length} {pluralize("work", "works", offChain.length)}{" "}
        won&rsquo;t be imported:
      </span>{" "}
      {parts.join(", ")}. Catalog.sol only indexes EVM-chain (contract,
      tokenId) pointers, so works without one — physical editions, Tezos /
      Flow / Bitcoin mints — stay only in the source registry. Expand
      &ldquo;Show skipped&rdquo; below to see the full list.
    </div>
  )
}

function NothingToDo({
  alreadyIndexed,
  nonMainnet,
  unparseable,
  offChain,
}: {
  alreadyIndexed: number
  nonMainnet: number
  unparseable: number
  offChain: number
}) {
  return (
    <div className="mt-10 border border-gray-200 rounded-md bg-gray-50 p-8 text-center">
      <h2 className="text-lg font-semibold">Nothing left to import.</h2>
      <p className="text-sm text-gray-600 mt-2">
        {alreadyIndexed > 0 && (
          <>
            {alreadyIndexed} {pluralize("work is", "works are", alreadyIndexed)}{" "}
            already in your Catalog.{" "}
          </>
        )}
        {nonMainnet > 0 && (
          <>
            {nonMainnet} non-mainnet{" "}
            {pluralize("work", "works", nonMainnet)} can&rsquo;t be imported
            (Catalog is only deployed on Ethereum mainnet).{" "}
          </>
        )}
        {offChain > 0 && (
          <>
            {offChain} off-chain{" "}
            {pluralize("work", "works", offChain)} (physical / non-EVM) aren&rsquo;t
            representable as (contract, tokenId) pointers.{" "}
          </>
        )}
        {unparseable > 0 && (
          <>
            {unparseable} {pluralize("entry", "entries", unparseable)}{" "}
            couldn&rsquo;t be mapped to a token.
          </>
        )}
      </p>
    </div>
  )
}

function groupByContract(
  ops: CatalogOp[],
): Array<{ contract: Address; ops: CatalogOp[] }> {
  const map = new Map<Address, CatalogOp[]>()
  for (const op of ops) {
    if (!map.has(op.contract)) map.set(op.contract, [])
    map.get(op.contract)!.push(op)
  }
  return Array.from(map.entries()).map(([contract, ops]) => ({ contract, ops }))
}

/**
 * Inline "add to selection" form. Lightweight version of AddEntryForm
 * that builds a CatalogOp and hands it back to the parent instead of
 * triggering its own chain write. Lets the artist add custom entries
 * to the planner's batch so everything submits together via a single
 * multicall — no separate transaction for hand-typed contracts.
 *
 * Just contract address + scope toggle. Validation is intentionally
 * minimal: we accept any well-formed address. Catalog itself does no
 * semantic checks, and adding into a multicall means a bad entry
 * reverts the whole batch — so the existing AddEntryForm (full
 * standalone) still exists for the case where the artist wants the
 * preview + duplicate-guard.
 */
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

function BatchAddRow({
  onAdd,
}: {
  onAdd: (op: CatalogOp) => void
}) {
  const [open, setOpen] = useState(false)
  const [addr, setAddr] = useState("")
  const [scope, setScope] = useState<"all" | "single" | "range">("all")
  const [tokenInput, setTokenInput] = useState("")
  const [err, setErr] = useState<string | null>(null)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left text-sm text-gray-700 underline hover:text-gray-900 px-4 py-3"
      >
        + Add a contract we missed
      </button>
    )
  }

  function handleAdd() {
    const c = addr.trim().toLowerCase() as Address
    if (!ADDRESS_PATTERN.test(c)) {
      setErr("Enter a valid contract address.")
      return
    }
    if (scope === "all") {
      onAdd({
        kind: "addContract",
        contract: c,
        works: [
          {
            id: `manual:${c}`,
            title: c,
            chainId: 1,
            contract: c,
            claimWholeContract: true,
          },
        ],
      })
    } else if (scope === "single") {
      const id = tokenInput.trim()
      if (!/^\d+$/.test(id)) {
        setErr("Enter a token ID (digits).")
        return
      }
      const tokenId = BigInt(id)
      onAdd({
        kind: "addToken",
        contract: c,
        tokenId,
        works: [
          {
            id: `manual:${c}:${id}`,
            title: `#${id}`,
            chainId: 1,
            contract: c,
            tokenId,
          },
        ],
      })
    } else {
      const m = tokenInput.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/)
      if (!m) {
        setErr("Enter a range like 1-100.")
        return
      }
      const start = BigInt(m[1])
      const end = BigInt(m[2])
      if (end < start) {
        setErr("Range end must be ≥ start.")
        return
      }
      onAdd({
        kind: "addTokenRange",
        contract: c,
        start,
        end,
        works: [
          {
            id: `manual:${c}:${start}-${end}`,
            title: `#${start}–${end}`,
            chainId: 1,
            contract: c,
            tokenIdStart: start,
            tokenIdEnd: end,
          },
        ],
      })
    }
    // Clear + leave open so the artist can add several without
    // re-expanding.
    setAddr("")
    setTokenInput("")
    setScope("all")
    setErr(null)
  }

  return (
    <div className="px-4 py-3 space-y-2 bg-gray-50/50">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-700">
          Add a contract we missed
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-gray-500 hover:text-gray-900 underline"
        >
          Cancel
        </button>
      </div>
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={addr}
        onChange={(e) => {
          setAddr(e.target.value)
          setErr(null)
        }}
        placeholder="0x... contract address"
        className="w-full border border-gray-200 rounded-md px-3 py-2 font-mono text-xs focus:outline-none focus:border-gray-400"
      />
      <div className="flex items-center gap-2">
        <div className="inline-flex border border-gray-200 rounded overflow-hidden text-[11px] font-mono">
          {(["all", "single", "range"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setScope(s)
                setErr(null)
              }}
              className={`px-2.5 py-1 transition-colors ${
                scope === s
                  ? "bg-fg text-bg"
                  : "bg-surface text-gray-600 hover:bg-gray-100"
              } ${s !== "all" ? "border-l border-gray-200" : ""}`}
            >
              {s === "all"
                ? "Whole contract"
                : s === "single"
                  ? "Single token"
                  : "Token range"}
            </button>
          ))}
        </div>
        {scope !== "all" && (
          <input
            type="text"
            value={tokenInput}
            onChange={(e) => {
              setTokenInput(e.target.value)
              setErr(null)
            }}
            placeholder={scope === "single" ? "Token ID" : "1-100"}
            className="flex-1 border border-gray-200 rounded-md px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-gray-400"
          />
        )}
        <button
          type="button"
          onClick={handleAdd}
          className="text-xs px-3 py-1.5 bg-fg text-bg rounded hover:opacity-80 transition-opacity"
        >
          Add to selection
        </button>
      </div>
      {err && <p className="text-xs text-amber-700">{err}</p>}
    </div>
  )
}

/**
 * Single-section render for owner-controlled contracts.
 *
 * Each owner-controlled contract has the same claim shape (addContract
 * — claims everything past + future), so showing a separate section
 * box per contract with the same explanation sentence on every row is
 * just noise when the artist has 10+ collections. Render the whole
 * group as one flat list with ONE explanation header and tight rows.
 *
 * Per-row content is the minimum needed for the artist to recognize +
 * decide: checkbox, thumbnail, collection name, address. No mode
 * toggle (it's whole-only), no body description (it's in the header).
 */
function WholeContractsList({
  groups,
  selectedContracts,
  onSetSelected,
}: {
  groups: Array<{ contract: Address; ops: CatalogOp[] }>
  selectedContracts: Set<Address>
  onSetSelected: (
    updater: (prev: Set<Address>) => Set<Address>,
  ) => void
}) {
  const total = groups.length
  const selectedCount = groups.filter((g) => selectedContracts.has(g.contract))
    .length
  const allSelected = selectedCount === total
  const allAddresses = groups.map((g) => g.contract)

  const toggleOne = (contract: Address) => {
    onSetSelected((prev) => {
      const next = new Set(prev)
      if (next.has(contract)) next.delete(contract)
      else next.add(contract)
      return next
    })
  }
  const toggleAll = () => {
    onSetSelected((prev) => {
      if (selectedCount === total) {
        const next = new Set(prev)
        for (const c of allAddresses) next.delete(c)
        return next
      }
      const next = new Set(prev)
      for (const c of allAddresses) next.add(c)
      return next
    })
  }

  return (
    <section className="border border-gray-200 rounded-md overflow-hidden">
      <header className="bg-gray-50 border-b border-gray-200 px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-semibold">Your collections</h3>
          <div className="flex items-baseline gap-3 text-xs">
            <span className="text-gray-500 font-mono">
              {selectedCount}/{total}
            </span>
            <button
              type="button"
              onClick={toggleAll}
              className="text-gray-700 hover:text-gray-900 underline"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          One <code className="font-mono">addContract</code> call per row —
          claims the entire contract, every existing token and every
          future mint.
        </p>
      </header>
      <ul className="divide-y divide-gray-100">
        {groups.map(({ contract, ops }) => {
          const allWorks = ops.flatMap((op) => op.works)
          const firstImage = allWorks.find((w) => w.imageUrl)
          const name =
            allWorks.find((w) => w.collectionName)?.collectionName ?? null
          const totalSupply = allWorks.find(
            (w) => typeof w.contractTotalSupply === "number",
          )?.contractTotalSupply
          const isSelected = selectedContracts.has(contract)
          return (
            <li
              key={contract}
              className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleOne(contract)}
                className="h-4 w-4 accent-emerald-600 cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              />
              {/*
               * Layout: image | (name over address-link) | total-count.
               * Image + name area is the click-target that toggles the
               * row's checkbox. The address is a real anchor inside the
               * name block so the artist can click it to verify on
               * evm.now without toggling (stopPropagation).
               */}
              <button
                type="button"
                onClick={() => toggleOne(contract)}
                className="h-10 w-10 shrink-0 bg-gray-100 rounded overflow-hidden relative cursor-pointer"
                aria-label={`Toggle ${name ?? contract}`}
              >
                {firstImage?.imageUrl && (
                  <Thumb
                    src={firstImage.imageUrl}
                    fallback={firstImage.imageFallbackUrl}
                    alt=""
                  />
                )}
              </button>
              <div className="min-w-0 flex-1">
                {name ? (
                  <button
                    type="button"
                    onClick={() => toggleOne(contract)}
                    className="block text-left text-sm font-medium truncate w-full cursor-pointer hover:underline"
                  >
                    {name}
                  </button>
                ) : null}
                <a
                  href={`https://evm.now/address/${contract}?chainId=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="font-mono text-[11px] text-gray-500 hover:text-gray-900 underline truncate block"
                >
                  {contract}
                </a>
              </div>
              <span className="shrink-0 text-xs text-gray-500 tabular-nums">
                {totalSupply !== undefined
                  ? `${totalSupply.toLocaleString()} ${totalSupply === 1 ? "token" : "tokens"}`
                  : ""}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * Single-section render for shared-platform tokens (FND shared 1/1, SR V2
 * shared, etc). Same principle as WholeContractsList: one consolidated
 * section instead of N per-contract section boxes that all say the same
 * "Specific only" thing. Tokens are grouped by platform name so the
 * artist can see which marketplace each minted-on is.
 */
function SharedTokensList({
  groups,
  selected,
  onToggle,
  onSetSelected,
}: {
  groups: Array<{ contract: Address; ops: CatalogOp[] }>
  selected: Set<EntryKey>
  onToggle: (k: EntryKey) => void
  onSetSelected: (
    updater: (prev: Set<EntryKey>) => Set<EntryKey>,
  ) => void
}) {
  // Flatten then partition by platform name, preserving order.
  type Item = {
    op: Exclude<CatalogOp, { kind: "addContract" }>
    contract: Address
    platform: string
  }
  const itemsByPlatform = new Map<string, Item[]>()
  for (const g of groups) {
    const info = sharedContractInfo(g.contract)
    const platform = info?.platform ?? "Shared"
    for (const op of g.ops) {
      if (op.kind === "addContract") continue
      const bucket = itemsByPlatform.get(platform) ?? []
      bucket.push({ op, contract: g.contract, platform })
      itemsByPlatform.set(platform, bucket)
    }
  }
  const allItems = [...itemsByPlatform.values()].flat()
  if (allItems.length === 0) return null

  const allKeys = allItems.map((it) => entryKey(it.op))
  const selectedCount = allKeys.filter((k) => selected.has(k)).length
  const total = allKeys.length
  const allSelected = selectedCount === total

  const toggleAll = () => {
    onSetSelected((prev) => {
      if (selectedCount === total) {
        const next = new Set(prev)
        for (const k of allKeys) next.delete(k)
        return next
      }
      const next = new Set(prev)
      for (const k of allKeys) next.add(k)
      return next
    })
  }

  return (
    <section className="border border-gray-200 rounded-md overflow-hidden">
      <header className="bg-gray-50 border-b border-gray-200 px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-semibold">Tokens on shared contracts</h3>
          <div className="flex items-baseline gap-3 text-xs">
            <span className="text-gray-500 font-mono">
              {selectedCount}/{total}
            </span>
            <button
              type="button"
              onClick={toggleAll}
              className="text-gray-700 hover:text-gray-900 underline"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Per-token claims — these contracts are shared across many artists,
          so only the specific tokens you minted are added.
        </p>
      </header>
      <div className="divide-y divide-gray-100">
        {[...itemsByPlatform.entries()].map(([platform, items]) => (
          <div key={platform}>
            <p className="text-[10px] uppercase tracking-wider font-mono text-gray-500 bg-gray-50/60 px-4 py-1.5">
              {platform}
            </p>
            <ul className="divide-y divide-gray-100">
              {items.map(({ op, contract }) => {
                const k = entryKey(op)
                const work = op.works[0]
                const tokenIdLabel =
                  op.kind === "addToken"
                    ? `#${op.tokenId.toString()}`
                    : `#${op.start.toString()}–${op.end.toString()}`
                return (
                  <li
                    key={k}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(k)}
                      onChange={() => onToggle(k)}
                      className="h-4 w-4 accent-emerald-600 cursor-pointer"
                    />
                    <button
                      type="button"
                      onClick={() => onToggle(k)}
                      className="h-10 w-10 shrink-0 bg-gray-100 rounded overflow-hidden relative cursor-pointer"
                      aria-label={`Toggle ${work?.title ?? tokenIdLabel}`}
                    >
                      {work?.imageUrl && (
                        <Thumb
                          src={work.imageUrl}
                          fallback={work.imageFallbackUrl}
                          alt=""
                        />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => onToggle(k)}
                        className="block text-left text-sm truncate w-full cursor-pointer hover:underline"
                      >
                        {work?.title || tokenIdLabel}
                      </button>
                      <a
                        href={`https://evm.now/address/${contract}?chainId=1`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-[11px] text-gray-500 hover:text-gray-900 underline truncate block"
                      >
                        {contract}
                      </a>
                    </div>
                    <span className="shrink-0 text-xs text-gray-500 font-mono tabular-nums">
                      {tokenIdLabel}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

function ContractGroup({
  contract,
  ops,
  selected,
  onToggle,
  mode,
  onModeChange,
  wholeContractSelected,
  onToggleWholeContract,
}: {
  contract: Address
  ops: CatalogOp[]
  selected: Set<EntryKey>
  onToggle: (k: EntryKey) => void
  mode: ContractMode
  onModeChange: (mode: ContractMode) => void
  wholeContractSelected: boolean
  onToggleWholeContract: () => void
}) {
  const total = ops.reduce((n, op) => n + tokenCount(op), 0)
  const selectedCount = ops.filter((op) => selected.has(entryKey(op))).length
  const shared = isSharedContract(contract)
  const sharedInfo = sharedContractInfo(contract)
  const showWholeOption = !shared
  // Hide the per-token mode toggle when the contract is owner-controlled
  // (adapter signaled claimWholeContract on every work). For those, the
  // addContract claim is the natural correct action and per-token mode
  // is a false choice: the visible "X of N indexed" count is just our
  // mints-to-artist subset, not the artist's full creation set, so
  // exposing it would let the artist pick from a misleading menu.
  // Specific-token curation (disavow individual tokens) is an exception
  // case handled by post-add Catalog editing, not by this importer.
  const allWorks = ops.flatMap((op) => op.works)
  const allClaimWhole =
    allWorks.length > 0 &&
    allWorks.every((w) => w.claimWholeContract === true)
  const showSpecificOption = shared || !allClaimWhole
  const collectionName = allWorks.find((w) => w.collectionName)?.collectionName

  return (
    <section className="border border-gray-200 rounded-md overflow-hidden">
      <header className="flex items-start justify-between bg-gray-50 border-b border-gray-200 px-4 py-3 gap-4">
        <div className="min-w-0 flex-1">
          {collectionName ? (
            <>
              <p className="text-sm font-semibold truncate">{collectionName}</p>
              <a
                href={`https://evm.now/address/${contract}?chainId=1`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px] text-gray-500 hover:text-gray-900 underline break-all"
              >
                {contract}
              </a>
            </>
          ) : (
            <a
              href={`https://evm.now/address/${contract}?chainId=1`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-gray-700 hover:text-gray-900 underline break-all"
            >
              {contract}
            </a>
          )}
          <p className="text-xs text-gray-500 mt-0.5">
            {mode === "whole" && showWholeOption ? (
              // Whole-contract mode: count is intentionally absent here
              // — addContract claims the entire contract regardless of
              // how many tokens we've indexed, and saying "N indexed"
              // implies the contract HAS N tokens, which is usually
              // wrong (we typically only see the mints-to-artist subset
              // for owner-controlled contracts).
              <>Full contract</>
            ) : (
              <>
                {total} of your works indexed ·{" "}
                {selectedCount} selected
              </>
            )}
            {sharedInfo && (
              <>
                {" "}· <span className="text-amber-700">{sharedInfo.platform}</span>
              </>
            )}
          </p>
        </div>
        <ModeRadio
          mode={mode}
          onChange={onModeChange}
          showWholeOption={showWholeOption}
          showSpecificOption={showSpecificOption}
          sharedPlatform={sharedInfo?.platform ?? null}
        />
      </header>

      {mode === "whole" && showWholeOption ? (
        <WholeContractRow
          contract={contract}
          ops={ops}
          total={total}
          selected={wholeContractSelected}
          onToggle={onToggleWholeContract}
        />
      ) : (
        <ul className="divide-y divide-gray-100">
          {ops.map((op) => {
            // `normalize()` never emits addContract — guard here is for
            // the type narrowing the OpRow component requires.
            if (op.kind === "addContract") return null
            const k = entryKey(op)
            return (
              <OpRow
                key={k}
                op={op}
                checked={selected.has(k)}
                onToggle={() => onToggle(k)}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}

function ModeRadio({
  mode,
  onChange,
  showWholeOption,
  showSpecificOption,
  sharedPlatform,
}: {
  mode: ContractMode
  onChange: (mode: ContractMode) => void
  showWholeOption: boolean
  showSpecificOption: boolean
  sharedPlatform: string | null
}) {
  // Shared platforms: only per-token mode makes sense.
  if (!showWholeOption) {
    return (
      <span
        className="shrink-0 text-[10px] uppercase font-mono tracking-wider px-2 py-1 rounded border border-amber-200 bg-amber-50 text-amber-700"
        title={
          sharedPlatform
            ? `${sharedPlatform} is shared across many artists. Only specific token IDs are registered to avoid claiming others' tokens.`
            : undefined
        }
      >
        Specific only ({sharedPlatform ?? "shared"})
      </span>
    )
  }
  // Owner-controlled contracts: only whole-contract mode. Render as a
  // static label, not a toggle — there's no decision to make.
  if (!showSpecificOption) {
    return (
      <span
        className="shrink-0 text-[10px] uppercase font-mono tracking-wider px-2 py-1 rounded border border-gray-200 bg-fg text-bg"
        title="You own this contract. addContract is the correct claim — the whole collection, every existing and future token."
      >
        Full contract
      </span>
    )
  }
  return (
    <div className="shrink-0 inline-flex border border-gray-200 rounded overflow-hidden text-[11px] font-mono">
      <button
        type="button"
        onClick={() => onChange("specific")}
        className={`px-2.5 py-1 transition-colors ${
          mode === "specific"
            ? "bg-fg text-bg"
            : "bg-surface text-gray-600 hover:bg-gray-100"
        }`}
      >
        By token ID
      </button>
      <button
        type="button"
        onClick={() => onChange("whole")}
        className={`px-2.5 py-1 border-l border-gray-200 transition-colors ${
          mode === "whole"
            ? "bg-fg text-bg"
            : "bg-surface text-gray-600 hover:bg-gray-100"
        }`}
        title="Register the full contract: cheaper gas, claims all current AND future tokens minted on it. Only safe if YOU own this contract."
      >
        Full contract
      </button>
    </div>
  )
}

function WholeContractRow({
  ops,
  selected,
  onToggle,
}: {
  contract: Address
  ops: CatalogOp[]
  total: number
  selected: boolean
  onToggle: () => void
}) {
  const allWorks = ops.flatMap((op) => op.works)
  const firstWorkWithImage = allWorks.find((w) => w.imageUrl)
  return (
    <label className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 cursor-pointer">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="h-4 w-4 accent-emerald-600"
      />
      <div className="h-12 w-12 shrink-0 bg-gray-100 rounded overflow-hidden relative">
        {firstWorkWithImage?.imageUrl && (
          <Thumb
            src={firstWorkWithImage.imageUrl}
            fallback={firstWorkWithImage.imageFallbackUrl}
            alt=""
          />
        )}
      </div>
      <p className="min-w-0 flex-1 text-xs text-gray-500">
        Claims the entire contract — every existing token (whoever holds
        it) and every future mint, in one{" "}
        <code className="font-mono">addContract</code> call.
      </p>
      <span className="shrink-0 text-[10px] uppercase font-mono tracking-wider px-2 py-0.5 rounded bg-gray-50 text-gray-600 border border-gray-200">
        contract
      </span>
    </label>
  )
}

/**
 * Row thumbnail driven by the shared `useThumbnailMedia` escalation
 * (same logic as ArtistGallery / PreserveGrid / SellerListingsView):
 * `ipfs://` URIs resolve through the gateway + proxy cascade — a plain
 * <img src="ipfs://…"> never even fires onError, which is how this
 * panel used to render a wall of broken icons — and works that put a
 * VIDEO file in `metadata.image` (whole catalogs do) escalate to a
 * muted <video> whose first frame acts as the still thumb.
 *
 * When the primary URL exhausts the cascade and the mapper supplied a
 * distinct `fallback` (e.g. the raw on-chain tokenURI), retry the whole
 * cascade once with that URL before giving up to the gray placeholder.
 */
function Thumb({
  src,
  fallback,
  alt,
}: {
  src: string
  fallback?: string
  alt: string
}) {
  const media = useThumbnailMedia(src, 160)
  if (media.kind === "failed") {
    if (fallback && fallback !== src) {
      return <Thumb src={fallback} alt={alt} />
    }
    // Give up — the sized gray wrapper behind shows through.
    return null
  }
  if (media.kind === "video") {
    return (
      <video
        src={media.videoSrc}
        className="h-full w-full object-cover"
        muted
        playsInline
        preload="metadata"
        onError={media.onVideoError}
      />
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={media.imgRef}
      src={media.imgSrc}
      alt={alt}
      className="h-full w-full object-cover"
      loading="lazy"
      onError={media.onImgError}
    />
  )
}

function OpRow({
  op,
  checked,
  onToggle,
}: {
  // OpRow is only rendered for the "specific" mode rows, never for
  // addContract — narrow at the call site so the kind-checks below
  // exhaust correctly.
  op: Extract<CatalogOp, { kind: "addToken" | "addTokenRange" }>
  checked: boolean
  onToggle: () => void
}) {
  const work = op.works[0] as RawWork | undefined
  const label =
    op.kind === "addToken"
      ? `Token #${op.tokenId.toString()}`
      : `Tokens #${op.start.toString()}–#${op.end.toString()}`
  const count =
    op.kind === "addToken"
      ? "1 token"
      : `${tokenCount(op).toLocaleString()} tokens`

  return (
    <li>
      <label className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="h-4 w-4 accent-emerald-600"
        />
        <div className="h-12 w-12 shrink-0 bg-gray-100 rounded overflow-hidden relative">
          {work?.imageUrl && (
            <Thumb
              src={work.imageUrl}
              fallback={work.imageFallbackUrl}
              alt={work.title}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">
            {work?.title ?? "(untitled)"}
          </p>
          <p className="text-xs text-gray-500">
            {label} · {count}
            {work?.editionInfo ? ` · ${work.editionInfo}` : ""}
            {work?.year ? ` · ${work.year}` : ""}
          </p>
        </div>
        <span
          className={`text-[10px] uppercase font-mono tracking-wider px-2 py-0.5 rounded ${
            op.kind === "addTokenRange"
              ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
              : "bg-gray-50 text-gray-600 border border-gray-200"
          }`}
        >
          {op.kind === "addTokenRange" ? "range" : "token"}
        </span>
      </label>
    </li>
  )
}

function SkippedSections({ plan }: { plan: NormalizedPlan }) {
  const total =
    plan.alreadyIndexed.length +
    plan.nonMainnet.length +
    plan.unparseable.length +
    plan.offChain.length
  if (total === 0) return null
  return (
    <details className="mt-10 border border-gray-200 rounded-md">
      <summary className="cursor-pointer px-4 py-3 text-sm text-gray-700 select-none">
        Show {total} skipped {pluralize("row", "rows", total)}
      </summary>
      <div className="border-t border-gray-200 divide-y divide-gray-100">
        <SkippedList
          label="Already in your Catalog"
          works={plan.alreadyIndexed}
        />
        <SkippedList
          label="Skipped — not on Ethereum mainnet"
          works={plan.nonMainnet}
        />
        <SkippedList
          label="Skipped — no on-chain token reference"
          works={plan.unparseable}
        />
        <SkippedListSimple
          label="Off-chain (physical / non-EVM)"
          items={plan.offChain.map((w) => ({
            id: w.id,
            title: w.title,
            meta: w.blockchain ? w.blockchain : w.reason,
          }))}
        />
      </div>
    </details>
  )
}

function SkippedList({ label, works }: { label: string; works: RawWork[] }) {
  if (works.length === 0) return null
  return (
    <div className="px-4 py-3">
      <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">
        {label} ({works.length})
      </p>
      <ul className="text-xs text-gray-600 space-y-1">
        {works.slice(0, 20).map((w) => (
          <li key={w.id} className="truncate">
            <span className="font-medium">{w.title}</span>{" "}
            {w.contract && (
              <span className="font-mono opacity-70">{w.contract}</span>
            )}
            {w.tokenId && (
              <span className="opacity-70"> #{w.tokenId.toString()}</span>
            )}
          </li>
        ))}
        {works.length > 20 && (
          <li className="opacity-50">…and {works.length - 20} more</li>
        )}
      </ul>
    </div>
  )
}

function SkippedListSimple({
  label,
  items,
}: {
  label: string
  items: Array<{ id: string; title: string; meta?: string }>
}) {
  if (items.length === 0) return null
  return (
    <div className="px-4 py-3">
      <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">
        {label} ({items.length})
      </p>
      <ul className="text-xs text-gray-600 space-y-1">
        {items.slice(0, 30).map((it) => (
          <li key={it.id} className="truncate">
            <span className="font-medium">{it.title}</span>
            {it.meta && (
              <span className="opacity-70"> · {it.meta}</span>
            )}
          </li>
        ))}
        {items.length > 30 && (
          <li className="opacity-50">…and {items.length - 30} more</li>
        )}
      </ul>
    </div>
  )
}

function SubmitBar({
  artistAddress,
  isConnected,
  walletMatches,
  selectedOps,
  chunks,
}: {
  artistAddress: Address
  isConnected: boolean
  walletMatches: boolean
  selectedOps: CatalogOp[]
  chunks: CatalogOp[][]
}) {
  const { runBatch, reset, phase, hashes, isRunning } = useCatalogMulticall()

  const onStart = () => {
    void runBatch(chunks)
  }

  const buttonLabel = (() => {
    if (!isConnected) return "Connect a wallet"
    if (!walletMatches) return "Connect as artist wallet"
    if (phase.kind === "signing")
      return `Signing tx ${phase.index + 1} of ${phase.total}…`
    if (phase.kind === "mining")
      return `Mining tx ${phase.index + 1} of ${phase.total}…`
    if (phase.kind === "chunk-done")
      return `Confirmed ${phase.index + 1} of ${phase.total}, continuing…`
    if (phase.kind === "done") return "Import another batch"
    if (phase.kind === "error") return "Retry"
    return chunks.length === 1
      ? `Add ${selectedOps.length} ${pluralize("entry", "entries", selectedOps.length)} (1 tx)`
      : `Add ${selectedOps.length} entries in ${chunks.length} txs`
  })()

  const disabled = !walletMatches || isRunning || selectedOps.length === 0

  return (
    <div className="fixed bottom-0 inset-x-0 border-t border-gray-200 bg-surface/95 backdrop-blur px-6 py-4 z-50">
      <div className="mx-auto max-w-5xl flex items-center justify-between gap-4">
        <div className="min-w-0 text-xs text-gray-600">
          {!isConnected && (
            <span>
              Connect the wallet for{" "}
              <span className="font-mono">{artistAddress}</span> to sign.
            </span>
          )}
          {isConnected && !walletMatches && (
            <span className="text-amber-700">
              Connected wallet doesn&rsquo;t match the artist address{" "}
              <span className="font-mono">{artistAddress}</span>.
            </span>
          )}
          {walletMatches && phase.kind === "idle" && (
            <span>
              Ready to sign. Each transaction adds up to {OPS_PER_TX} pointers
              to your on-chain Catalog.
            </span>
          )}
          {phase.kind === "signing" && (
            <span>
              Waiting for wallet signature — tx {phase.index + 1} of{" "}
              {phase.total}.
            </span>
          )}
          {phase.kind === "mining" && (
            <span>
              Broadcast — mining tx {phase.index + 1} of {phase.total}.
            </span>
          )}
          {phase.kind === "chunk-done" && (
            <span className="text-emerald-700">
              Tx {phase.index + 1} of {phase.total} confirmed. Preparing
              next…
            </span>
          )}
          {phase.kind === "done" && (
            <span className="text-emerald-700">
              All {phase.total}{" "}
              {pluralize("transaction", "transactions", phase.total)} confirmed.
              Catalog refreshing.
            </span>
          )}
          {phase.kind === "error" && (
            <span className="text-rose-700 block">
              Tx {phase.index + 1} of {phase.total} failed: {phase.message}
            </span>
          )}
          {hashes.length > 0 && (
            <div className="mt-1 font-mono text-[11px] opacity-70 space-y-0.5">
              {hashes.map((h, idx) => (
                <a
                  key={h}
                  href={`https://evm.now/tx/${h}?chainId=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block underline break-all"
                >
                  tx {idx + 1}: {h}
                </a>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {phase.kind === "error" && (
            <button
              type="button"
              onClick={reset}
              className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Dismiss
            </button>
          )}
          <button
            type="button"
            onClick={onStart}
            disabled={disabled}
            className="px-5 py-2.5 bg-emerald-600 text-bg text-sm font-medium rounded-md hover:bg-emerald-700 disabled:bg-surface-muted disabled:text-fg-subtle disabled:cursor-not-allowed transition-colors"
          >
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
