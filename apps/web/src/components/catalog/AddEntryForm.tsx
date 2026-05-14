"use client"

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useCatalogWrite } from "./useCatalogWrite"
import { extractShortError } from "./catalogErrors"
import { ContractPreview } from "./ContractPreview"
import { TokenPreview } from "./TokenPreview"
import { useContractInfo } from "./useContractInfo"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/**
 * Add form for /record.
 *
 *   1. Contract address (required) — preview card below shows
 *      name / symbol / standard / total supply when we can read them.
 *   2. Which tokens? (optional) — single id ("42") or range
 *      ("1-100"). Blank = all tokens. When a single id is entered,
 *      a small thumbnail+name preview confirms the artist has the
 *      right token. When a range is entered, a count summary appears.
 *   3. A "you're about to add..." summary line tells the artist
 *      exactly which contract function will fire and on what.
 *
 * Validation is intentionally non-blocking. Per the registry's "no
 * semantic checks" rule, the contract accepts anything; the form
 * surfaces what we can find but never refuses submission based on
 * on-chain state. Format errors (non-address, malformed range) DO
 * block — those are pure input mistakes.
 */

type Scope = "all" | "specific"

type ParsedSpecific =
  | { type: "single"; id: bigint }
  | { type: "range"; start: bigint; end: bigint }

type Parsed = { type: "all" } | ParsedSpecific

function parseSpecific(input: string): ParsedSpecific | { error: string } {
  const trimmed = input.trim()
  if (trimmed === "") {
    return { error: "Enter a token ID or a range like 1-100." }
  }
  // Range form: "1-100" / "1 - 100" / with en-dash.
  const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/)
  if (rangeMatch) {
    const start = BigInt(rangeMatch[1])
    const end = BigInt(rangeMatch[2])
    if (start > end) {
      return { error: "Start must be less than or equal to end." }
    }
    if (start === end) return { type: "single", id: start }
    return { type: "range", start, end }
  }
  if (/^\d+$/.test(trimmed)) {
    return { type: "single", id: BigInt(trimmed) }
  }
  return {
    error: "Use a single number like 42 or a range like 1-100.",
  }
}

function formatBigInt(n: bigint): string {
  if (n < 1_000_000_000n) return Number(n).toLocaleString()
  return n.toString()
}

export type ExistingRecord = {
  /** Lowercase contract pointers already in the record. */
  contracts: string[]
  /** Token pointers already in the record (contractAddress lowercased). */
  tokens: Array<{ contractAddress: string; tokenId: string }>
  /** Range pointers already in the record (contractAddress lowercased). */
  tokenRanges: Array<{
    contractAddress: string
    startTokenId: string
    endTokenId: string
  }>
}

export function AddEntryForm({
  existing,
}: {
  existing?: ExistingRecord
}) {
  const {
    call,
    busy,
    error,
    reset,
    isPending,
    isMining,
    isSuccess,
    isReverted,
    txHash,
  } = useCatalogWrite()
  const searchParams = useSearchParams()
  const [addr, setAddr] = useState("")
  const [scope, setScope] = useState<Scope>("all")
  const [tokens, setTokens] = useState("")
  const [localErr, setLocalErr] = useState<string | null>(null)

  // Pre-fill the address when arriving with `?addContract=0x...` —
  // used by the "Declare in your record" CTA on /dependency. Runs
  // once on mount; the artist can edit or clear the field freely
  // after that.
  useEffect(() => {
    const param = searchParams?.get("addContract")
    if (param && ADDRESS_RE.test(param.trim())) {
      setAddr(param.trim())
    }
    // We deliberately don't include `searchParams` in the deps so a
    // navigation back to the same page doesn't re-stomp the field
    // after the artist clears it. Mount-time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addrValid = ADDRESS_RE.test(addr.trim())
  const { data: contractInfo } = useContractInfo(addr)

  // Parse only when the artist is on the "specific" scope. Empty
  // input there is an error; for the "all" scope we skip parsing
  // entirely.
  const parsedSpecific = useMemo<
    ParsedSpecific | { error: string } | null
  >(() => (scope === "specific" ? parseSpecific(tokens) : null), [
    scope,
    tokens,
  ])

  const parsed: Parsed | { error: string } | null =
    scope === "all"
      ? { type: "all" }
      : parsedSpecific

  const parseFailed = parsed !== null && "error" in parsed
  const tokensTouched = tokens.trim() !== ""

  useEffect(() => {
    if (isSuccess) {
      setAddr("")
      setTokens("")
      setScope("all")
    }
  }, [isSuccess])

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const c = addr.trim()
    if (!ADDRESS_RE.test(c)) {
      setLocalErr("Enter a valid contract address.")
      return
    }
    if (parsed === null || "error" in parsed) {
      setLocalErr(parsed && "error" in parsed ? parsed.error : "Pick what to add.")
      return
    }
    // Client-side duplicate guard. The registry reverts on duplicates
    // via `ContractAlreadyRegistered` / `TokenAlreadyRegistered` /
    // `TokenRangeAlreadyRegistered`, but catching it here saves the
    // user a wallet prompt + gas + a confused "Reverted on chain"
    // banner. The check uses the page's last-rendered record, so a
    // very-fresh duplicate (added in another tab between page load and
    // submit) still falls through to the on-chain revert.
    const cLower = c.toLowerCase()
    if (existing) {
      if (parsed.type === "all") {
        if (existing.contracts.includes(cLower)) {
          setLocalErr("This contract is already in your catalog.")
          return
        }
      } else if (parsed.type === "single") {
        const idStr = parsed.id.toString()
        if (
          existing.tokens.some(
            (t) => t.contractAddress === cLower && t.tokenId === idStr,
          )
        ) {
          setLocalErr(
            `Token #${idStr} on this contract is already in your catalog.`,
          )
          return
        }
      } else {
        const start = parsed.start.toString()
        const end = parsed.end.toString()
        if (
          existing.tokenRanges.some(
            (r) =>
              r.contractAddress === cLower &&
              r.startTokenId === start &&
              r.endTokenId === end,
          )
        ) {
          setLocalErr(
            `Range ${start} to ${end} on this contract is already in your catalog.`,
          )
          return
        }
      }
    }
    setLocalErr(null)
    reset()
    if (parsed.type === "all") {
      call("addContract", [c as `0x${string}`])
    } else if (parsed.type === "single") {
      call("addToken", [c as `0x${string}`, parsed.id])
    } else {
      call("addTokenRange", [c as `0x${string}`, parsed.start, parsed.end])
    }
  }

  // Over-supply warning: when totalSupply is known, flag a token id or
  // range upper bound that's higher than what's been minted. Soft —
  // many contracts mint unbounded over time and the artist might be
  // declaring a range that fills out as new tokens drop.
  const overSupplyHint = computeOverSupplyHint(parsed, contractInfo)

  return (
    <form
      onSubmit={onSubmit}
      className="border border-gray-200 rounded-md p-5 space-y-4"
    >
      <h2 className="text-sm font-semibold">Add to your catalog</h2>

      <div className="space-y-1.5">
        <label
          htmlFor="record-addr"
          className="block text-xs text-gray-600"
        >
          Contract address
        </label>
        <input
          id="record-addr"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={addr}
          onChange={(e) => {
            setAddr(e.target.value)
            if (localErr) setLocalErr(null)
          }}
          placeholder="0x..."
          disabled={busy}
          className="w-full border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
        />
        <ContractPreview address={addr} />
      </div>

      <div className="space-y-1.5">
        <div className="block text-xs text-gray-600">What to add</div>
        <ScopePicker
          scope={scope}
          onChange={(s) => {
            setScope(s)
            if (localErr) setLocalErr(null)
          }}
          disabled={busy}
        />
      </div>

      {scope === "specific" && (
        <div className="space-y-1.5">
          <label
            htmlFor="record-tokens"
            className="block text-xs text-gray-600"
          >
            Which tokens?
          </label>
          <input
            id="record-tokens"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={tokens}
            onChange={(e) => {
              setTokens(e.target.value)
              if (localErr) setLocalErr(null)
            }}
            placeholder="42, or 1-100"
            disabled={busy}
            autoFocus
            className="w-full border border-gray-200 rounded-md px-3 py-2 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:opacity-50"
          />
          <p className="text-xs text-gray-500">
            A single ID like <span className="font-mono">42</span> or a
            range like <span className="font-mono">1-100</span>.
          </p>
          {tokensTouched && parseFailed && (
            <p className="text-xs text-amber-700">
              {parsed && "error" in parsed ? parsed.error : ""}
            </p>
          )}

          {addrValid &&
            parsed &&
            !("error" in parsed) &&
            parsed.type === "single" && (
              <TokenPreview contract={addr} tokenId={parsed.id.toString()} />
            )}
          {addrValid &&
            parsed &&
            !("error" in parsed) &&
            parsed.type === "range" && (
              <div className="border border-gray-200 rounded-md p-3 text-sm">
                Adding{" "}
                <strong>
                  {formatBigInt(parsed.end - parsed.start + 1n)}
                </strong>{" "}
                tokens. IDs {parsed.start.toString()} through{" "}
                {parsed.end.toString()}.
              </div>
            )}
          {overSupplyHint && (
            <p className="text-xs text-amber-700">{overSupplyHint}</p>
          )}
        </div>
      )}

      <SummaryLine
        addrValid={addrValid}
        parsed={parsed && !("error" in parsed) ? parsed : null}
        contractName={contractInfo?.name ?? null}
      />

      <div className="flex items-center justify-end">
        <button
          type="submit"
          disabled={busy || !addrValid || parseFailed}
          className="bg-fg text-bg text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {busy ? "Adding..." : "Add to catalog"}
        </button>
      </div>

      {localErr && <p className="text-xs text-amber-700">{localErr}</p>}
      {error && (
        <p className="text-xs text-amber-700">{extractShortError(error)}</p>
      )}
      <TxStatusPanel
        isPending={isPending}
        isMining={isMining}
        isSuccess={isSuccess && !busy}
        isReverted={isReverted && !busy}
        txHash={txHash}
        onDismiss={reset}
      />
    </form>
  )
}

/**
 * Inline status panel that mirrors the wagmi write lifecycle:
 *   - wallet signature pending → "Waiting for wallet…"
 *   - tx broadcast, mining     → "Mining…" with tx hash
 *   - confirmed (status=success)  → green "Confirmed" with evm.now link
 *   - mined but reverted (status=reverted) → red "Reverted" with evm.now link
 *
 * `isSuccess` vs `isReverted` are split in the parent hook so we don't
 * paint a green banner for an on-chain revert just because the receipt
 * came back.
 */
function TxStatusPanel({
  isPending,
  isMining,
  isSuccess,
  isReverted,
  txHash,
  onDismiss,
}: {
  isPending: boolean
  isMining: boolean
  isSuccess: boolean
  isReverted: boolean
  txHash: `0x${string}` | undefined
  onDismiss: () => void
}) {
  if (!isPending && !isMining && !isSuccess && !isReverted) return null

  const palette = isSuccess
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : isReverted
      ? "border-rose-200 bg-rose-50 text-rose-900"
      : "border-gray-200 bg-gray-50 text-gray-700"

  const dismissBorder = isReverted
    ? "border-rose-300 text-rose-900 hover:bg-rose-100"
    : "border-emerald-300 text-emerald-900 hover:bg-emerald-100"

  return (
    <div
      className={`mt-1 rounded-md border ${palette} px-4 py-3 flex items-center justify-between gap-3`}
    >
      <div className="text-xs leading-relaxed min-w-0">
        {isPending && <>Waiting for wallet signature…</>}
        {isMining && (
          <>
            <span className="font-medium">Mining…</span> The transaction has
            been broadcast and is waiting to be included in a block.
          </>
        )}
        {isSuccess && (
          <>
            <span className="font-medium">Confirmed.</span> Your catalog has
            been updated. The list below will refresh in a moment.
          </>
        )}
        {isReverted && (
          <>
            <span className="font-medium">Reverted on chain.</span> The
            transaction was mined but the contract rejected it (likely a
            duplicate or unauthorized operation).
          </>
        )}
        {txHash && (
          <a
            href={`https://evm.now/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-1 font-mono text-[11px] opacity-70 break-all underline hover:opacity-100"
          >
            {txHash}
          </a>
        )}
      </div>
      {(isSuccess || isReverted) && (
        <button
          type="button"
          onClick={onDismiss}
          className={`text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 border transition-colors shrink-0 ${dismissBorder}`}
        >
          Dismiss
        </button>
      )}
    </div>
  )
}

/**
 * One-line "you're about to add..." summary so the artist sees the
 * exact action before clicking. Hidden until address is valid AND
 * tokens-field parses cleanly.
 */
function SummaryLine({
  addrValid,
  parsed,
  contractName,
}: {
  addrValid: boolean
  parsed: Parsed | null
  contractName: string | null
}) {
  if (!addrValid || !parsed) return null
  const label = contractName ?? "this contract"
  let body: React.ReactNode
  if (parsed.type === "all") {
    body = (
      <>
        Adding <strong>all tokens</strong> on{" "}
        <strong>{label}</strong>.
      </>
    )
  } else if (parsed.type === "single") {
    body = (
      <>
        Adding <strong>token #{parsed.id.toString()}</strong> on{" "}
        <strong>{label}</strong>.
      </>
    )
  } else {
    body = (
      <>
        Adding <strong>tokens {parsed.start.toString()}–{parsed.end.toString()}</strong>{" "}
        on <strong>{label}</strong>.
      </>
    )
  }
  return <p className="text-sm text-gray-600">{body}</p>
}

function computeOverSupplyHint(
  parsed: Parsed | { error: string } | null,
  info: { totalSupply: string | null } | null,
): string | null {
  if (!info || info.totalSupply === null) return null
  if (parsed === null || "error" in parsed) return null
  if (parsed.type === "all") return null
  const supply = BigInt(info.totalSupply)
  if (supply === 0n) return null
  if (parsed.type === "single" && parsed.id >= supply) {
    return `Token #${parsed.id.toString()} is above the current supply (${formatBigInt(supply)}). It may not exist yet.`
  }
  if (parsed.type === "range" && parsed.end >= supply) {
    return `Range ends above the current supply (${formatBigInt(supply)}). Some tokens may not exist yet.`
  }
  return null
}

function ScopePicker({
  scope,
  onChange,
  disabled,
}: {
  scope: Scope
  onChange: (s: Scope) => void
  disabled: boolean
}) {
  const opts: Array<{ id: Scope; label: string; hint: string }> = [
    {
      id: "all",
      label: "All tokens on this contract",
      hint: "Add every token, current and future.",
    },
    {
      id: "specific",
      label: "Specific tokens",
      hint: "Add one ID or a range.",
    },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="What to add"
      className="grid grid-cols-1 sm:grid-cols-2 gap-2"
    >
      {opts.map((o) => {
        const active = scope === o.id
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id)}
            disabled={disabled}
            className={`text-left rounded-md border p-3 transition-colors disabled:opacity-50 ${
              active
                ? "border-fg bg-gray-50"
                : "border-gray-200 hover:border-gray-400"
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <span
                className={`inline-block h-3 w-3 rounded-full border ${
                  active ? "bg-fg border-fg" : "border-gray-300"
                }`}
                aria-hidden
              />
              {o.label}
            </div>
            <div className="text-xs text-gray-500 mt-1 ml-5">{o.hint}</div>
          </button>
        )
      })}
    </div>
  )
}
