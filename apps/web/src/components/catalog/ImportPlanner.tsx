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
}: Props) {
  const { address: connected, isConnected } = useAccount()
  const walletMatches =
    !!connected && connected.toLowerCase() === artistAddress.toLowerCase()

  // Default all entries selected. The artist explicitly unchecks ones
  // they want to skip — matches the "land + click" expectation in the
  // brief better than "land + check every box".
  const allKeys = useMemo(() => plan.ops.map(entryKey), [plan.ops])
  const [selected, setSelected] = useState<Set<EntryKey>>(
    () => new Set(allKeys),
  )

  useEffect(() => {
    setSelected(new Set(allKeys))
  }, [allKeys])

  // Per-contract mode: "specific" (default, safe — emits the per-entry
  // ops) or "whole" (consolidates into one `addContract(c)`). The
  // toggle is suppressed for known shared-platform contracts (see
  // shared-contracts.ts) so an artist can't accidentally claim other
  // people's tokens. Mode survives re-renders but resets when the plan
  // identity changes.
  const groupedOps = useMemo(() => groupByContract(plan.ops), [plan.ops])
  const [contractMode, setContractMode] = useState<
    Record<Address, ContractMode>
  >({})
  useEffect(() => {
    setContractMode({})
  }, [plan.ops])

  const setMode = (contract: Address, mode: ContractMode) => {
    setContractMode((prev) => ({ ...prev, [contract]: mode }))
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

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 pb-32">
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
        <div className="mt-8 space-y-6">
          {groupedOps.map(({ contract, ops }) => (
            <ContractGroup
              key={contract}
              contract={contract}
              ops={ops}
              selected={selected}
              onToggle={toggle}
              mode={contractMode[contract] ?? "specific"}
              onModeChange={(m) => setMode(contract, m)}
            />
          ))}
        </div>
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

function ContractGroup({
  contract,
  ops,
  selected,
  onToggle,
  mode,
  onModeChange,
}: {
  contract: Address
  ops: CatalogOp[]
  selected: Set<EntryKey>
  onToggle: (k: EntryKey) => void
  mode: ContractMode
  onModeChange: (mode: ContractMode) => void
}) {
  const total = ops.reduce((n, op) => n + tokenCount(op), 0)
  const selectedCount = ops.filter((op) => selected.has(entryKey(op))).length
  const shared = isSharedContract(contract)
  const sharedInfo = sharedContractInfo(contract)
  const showWholeOption = !shared

  return (
    <section className="border border-gray-200 rounded-md overflow-hidden">
      <header className="flex items-start justify-between bg-gray-50 border-b border-gray-200 px-4 py-3 gap-4">
        <div className="min-w-0 flex-1">
          <a
            href={`https://evm.now/address/${contract}?chainId=1`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-gray-700 hover:text-gray-900 underline break-all"
          >
            {contract}
          </a>
          <p className="text-xs text-gray-500 mt-0.5">
            {ops.length} {pluralize("entry", "entries", ops.length)} · {total}{" "}
            {pluralize("token", "tokens", total)}
            {mode === "specific" && <> · {selectedCount} selected</>}
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
          sharedPlatform={sharedInfo?.platform ?? null}
        />
      </header>

      {mode === "whole" && showWholeOption ? (
        <WholeContractRow contract={contract} ops={ops} total={total} />
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
  sharedPlatform,
}: {
  mode: ContractMode
  onChange: (mode: ContractMode) => void
  showWholeOption: boolean
  sharedPlatform: string | null
}) {
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
  return (
    <div className="shrink-0 inline-flex border border-gray-200 rounded overflow-hidden text-[11px] font-mono">
      <button
        type="button"
        onClick={() => onChange("specific")}
        className={`px-2.5 py-1 transition-colors ${
          mode === "specific"
            ? "bg-gray-900 text-white"
            : "bg-white text-gray-600 hover:bg-gray-100"
        }`}
      >
        By token ID
      </button>
      <button
        type="button"
        onClick={() => onChange("whole")}
        className={`px-2.5 py-1 border-l border-gray-200 transition-colors ${
          mode === "whole"
            ? "bg-gray-900 text-white"
            : "bg-white text-gray-600 hover:bg-gray-100"
        }`}
        title="Register the full contract: cheaper gas, claims all current AND future tokens minted on it. Only safe if YOU own this contract."
      >
        Full contract
      </button>
    </div>
  )
}

function WholeContractRow({
  contract,
  ops,
  total,
}: {
  contract: Address
  ops: CatalogOp[]
  total: number
}) {
  const firstWorkWithImage = ops
    .flatMap((op) => op.works)
    .find((w) => w.imageUrl)
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 shrink-0 bg-gray-100 rounded overflow-hidden relative">
          {firstWorkWithImage?.imageUrl && (
            <Thumb
              src={firstWorkWithImage.imageUrl}
              fallback={firstWorkWithImage.imageFallbackUrl}
              alt=""
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Register the full contract</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Claims all current ({total} {pluralize("token", "tokens", total)}{" "}
            in your registry) AND any future tokens minted on{" "}
            <span className="font-mono">{contract.slice(0, 10)}…</span>.
            Replaces the {ops.length}{" "}
            {pluralize("specific entry", "specific entries", ops.length)} for
            this contract with a single <code className="font-mono">addContract</code>{" "}
            call.
          </p>
        </div>
        <span className="shrink-0 text-[10px] uppercase font-mono tracking-wider px-2 py-0.5 rounded bg-gray-50 text-gray-600 border border-gray-200">
          contract
        </span>
      </div>
    </div>
  )
}

/**
 * <img> wrapper with a graceful three-stage failure path. Source
 * registries link out to a grab-bag of hosts (artist personal sites,
 * IPFS gateways with expired DNS, NFT CDNs with stale TLS certs, etc.).
 *
 * Fallback chain:
 *   1. primary `src`               — what the source feed gave us
 *   2. `fallback` (e.g. IPFS pin) — if the mapper populated it
 *   3. weserv image proxy          — fetches the primary server-side,
 *                                    bypassing expired certs / CORS
 *
 * Stage 3 always exists (the proxy is public + free), so any image
 * the server can fetch will ultimately render. Stage 3 only fires
 * after stages 1+2 have both errored — so for the ~99% case where
 * the primary works, we don't add a third-party hop.
 */
const WESERV_PROXY = "https://images.weserv.nl/?url="

function weservProxyUrl(src: string): string {
  // weserv accepts URLs with or without protocol; stripping `https://`
  // and `http://` keeps the encoded path shorter.
  const stripped = src.replace(/^https?:\/\//, "")
  return `${WESERV_PROXY}${encodeURIComponent(stripped)}`
}

function Thumb({
  src,
  fallback,
  alt,
}: {
  src: string
  fallback?: string
  alt: string
}) {
  // 0 = primary, 1 = fallback, 2 = proxy, 3 = give up (hide).
  // Keyed off `src` so a row swap (re-render with new primary URL)
  // resets the chain.
  const [stage, setStage] = useState(0)
  useEffect(() => {
    setStage(0)
  }, [src])

  const active = (() => {
    if (stage === 0) return src
    if (stage === 1 && fallback) return fallback
    return weservProxyUrl(src)
  })()

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={active}
      alt={alt}
      className="h-full w-full object-cover"
      loading="lazy"
      onError={(e) => {
        // Stage 0 fail → try `fallback` if present, otherwise skip to proxy.
        if (stage === 0) {
          setStage(fallback ? 1 : 2)
          return
        }
        if (stage === 1) {
          setStage(2)
          return
        }
        // Stage 2 (proxy) failed — last resort, hide the element so
        // the gray placeholder behind shows through.
        ;(e.currentTarget as HTMLImageElement).style.display = "none"
      }}
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
    <div className="fixed bottom-0 inset-x-0 border-t border-gray-200 bg-white/95 backdrop-blur px-6 py-4 z-50">
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
            className="px-5 py-2.5 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
