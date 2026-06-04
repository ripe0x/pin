"use client"

/**
 * The artist flow, one step: configure an edition and deploy it. Deploying an
 * edition mints you your own ERC721A contract, set up with your artwork and
 * mint conditions in a single transaction. Crypto-native: wallet-first,
 * decoded, honest pricing language.
 *
 * Optional collaboration: add collaborators and we deploy an immutable 0xSplits
 * split first, then point the edition's payout at it (two transactions), so
 * proceeds are divided onchain and land outside the artist's upgradeable edition.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { isAddress, parseEventLogs, type Address } from "viem"
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { pndEditionsFactoryAbi, splitMainAbi } from "@pin/abi"
import { ArtworkInput } from "@/components/editions/ArtworkInput"
import { Field, Hint, Segmented, inputCls, labelCls, primaryBtnCls } from "@/components/editions/form-ui"
import { PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL, formatWriteError } from "@/components/tx/tx-ui"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import {
  type Collaborator,
  EditionKind,
  SURFACE_SHARE_BPS,
  ZERO_ADDRESS,
  buildSplitArgsWithPermanence,
  formatBps,
  pndEditionsFactory,
  pndMuriRenderer,
  pndSplitMain,
  validateCollaborators,
  validatePermanence,
} from "@/lib/pnd-editions"

type CollabRow = { address: string; percent: string }

export function CreateEditionForm() {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
  const router = useRouter()

  const factory = pndEditionsFactory()
  const splitMain = pndSplitMain()
  // The MURI bridge is deploy-gated: only offer the Permanent tier where the
  // opt-in renderer is configured (mainnet pending; set on the dev fork).
  const muriRenderer = pndMuriRenderer()

  const [title, setTitle] = useState("")
  const [symbol, setSymbol] = useState("")
  const [artworkURI, setArtworkURI] = useState("")
  const price = useEthAmountInput()
  const [openEdition, setOpenEdition] = useState(true)
  const [supplyCap, setSupplyCap] = useState("100")
  const [hasWindow, setHasWindow] = useState(false)
  const [startAt, setStartAt] = useState("")
  const [endAt, setEndAt] = useState("")
  const [royaltyPct, setRoyaltyPct] = useState("10")
  const [payout, setPayout] = useState("")
  const [splitOn, setSplitOn] = useState(false)
  const [collabs, setCollabs] = useState<CollabRow[]>([
    { address: "", percent: "" },
    { address: "", percent: "" },
  ])
  // Phase 1 of mint-funded permanence (docs/editions-permanence-funding.md):
  // route a slice of every mint to an artist-owned vault by adding it as a
  // recipient in the payout split. No core-contract change — it rides 0xSplits.
  const [permanenceOn, setPermanenceOn] = useState(false)
  const [permanenceVault, setPermanenceVault] = useState("")
  const [permanencePct, setPermanencePct] = useState("1")
  const [tier, setTier] = useState<"standard" | "permanent">("standard")

  // Two-step deploy: optional split first, then the edition pointing at it.
  const split = useWriteContract()
  const edition = useWriteContract()
  const { data: splitReceipt, isLoading: splitMining } = useWaitForTransactionReceipt({
    hash: split.data,
  })
  const { data: editionReceipt, isLoading: editionMining } = useWaitForTransactionReceipt({
    hash: edition.data,
  })

  // Step 1 confirmed: deploy the edition with the freshly-created split as payout.
  useEffect(() => {
    if (!splitReceipt) return
    try {
      const logs = parseEventLogs({
        abi: splitMainAbi,
        logs: splitReceipt.logs,
        eventName: "CreateSplit",
      })
      const addr = (logs[0]?.args as { split?: Address } | undefined)?.split
      if (addr) deployEdition(addr)
    } catch {
      // user can retry
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitReceipt])

  // Step 2 confirmed: go to the new edition.
  useEffect(() => {
    if (!editionReceipt) return
    try {
      const logs = parseEventLogs({
        abi: pndEditionsFactoryAbi,
        logs: editionReceipt.logs,
        eventName: "EditionCreated",
      })
      const created = logs[0]?.args as { edition?: Address } | undefined
      if (created?.edition) {
        edition.reset()
        router.push(`/editions/${created.edition}`)
      }
    } catch {
      // user can retry
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editionReceipt])

  if (!address) {
    return (
      <Shell>
        <ConnectButton.Custom>
          {({ openConnectModal }) => (
            <button onClick={openConnectModal} className={primaryBtnCls}>
              Connect wallet to start
            </button>
          )}
        </ConnectButton.Custom>
      </Shell>
    )
  }

  if (wrongNetwork) {
    return (
      <Shell>
        <button
          onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
          disabled={isSwitchPending}
          className={primaryBtnCls}
        >
          {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
        </button>
      </Shell>
    )
  }

  const royaltyBps = Math.round(Number(royaltyPct || "0") * 100)
  const royaltyOk = royaltyBps >= 0 && royaltyBps <= 5_000 // matches MAX_ROYALTY_BPS
  const capOk = openEdition || (Number(supplyCap) > 0 && Number.isFinite(Number(supplyCap)))
  const payoutOk = payout === "" || isAddress(payout)
  const collabCheck = validateCollaborators(collabs)
  const splitOk = !splitOn || (collabCheck.ok && !!splitMain)
  // The non-permanence payout recipients, used both to validate the vault is
  // distinct and to build the split. With collaborators it's their rows; alone
  // it's just the artist (payout override, or the connected wallet).
  const baseAddresses = splitOn
    ? collabCheck.parsed.map((r) => r.address)
    : [(payout === "" ? (address ?? ZERO_ADDRESS) : payout)]
  const permCheck = validatePermanence(permanenceVault, permanencePct, baseAddresses)
  // Routing a slice to a distinct vault needs a >=2-recipient split, so 0xSplits
  // must be available whenever permanence is on.
  const permanenceOk = !permanenceOn || (permCheck.ok && !!splitMain)
  // Permanence forces a split even when no collaborators are configured.
  const usingSplit = splitOn || permanenceOn
  const canSubmit =
    !!factory &&
    !!address &&
    title.trim().length > 0 &&
    symbol.trim().length > 0 &&
    artworkURI.trim().length > 0 &&
    (price.isEmpty || price.isValid) &&
    royaltyOk &&
    capOk &&
    (splitOn ? splitOk : payoutOk) &&
    permanenceOk

  function toUnix(local: string): bigint {
    if (!local) return 0n
    const ms = new Date(local).getTime()
    return Number.isNaN(ms) ? 0n : BigInt(Math.floor(ms / 1000))
  }

  function buildCfg(payoutAddr: Address) {
    return {
      artworkURI: artworkURI.trim(),
      price: price.wei ?? 0n,
      supplyCap: openEdition ? 0n : BigInt(Math.floor(Number(supplyCap))),
      mintStart: hasWindow ? toUnix(startAt) : 0n,
      mintEnd: hasWindow ? toUnix(endAt) : 0n,
      royaltyBps,
      royaltyReceiver: ZERO_ADDRESS as Address,
      kind: EditionKind.Standalone,
      payoutAddress: payoutAddr,
      // Permanent tier presets the MURI renderer (safe: it falls back to the
      // edition's own artwork() until the artist anchors). Standard uses the
      // default renderer.
      renderer: (tier === "permanent" && muriRenderer ? muriRenderer : ZERO_ADDRESS) as Address,
      mintHook: ZERO_ADDRESS as Address,
    }
  }

  function deployEdition(payoutAddr: Address) {
    if (!factory || !address) return
    edition.writeContract({
      address: factory,
      abi: pndEditionsFactoryAbi,
      functionName: "createEdition",
      args: [title.trim(), symbol.trim(), address, buildCfg(payoutAddr)],
    })
  }

  function submit() {
    if (!canSubmit || !factory || !address) return
    if (usingSplit) {
      if (!splitMain) return
      // Base recipients: collaborators if configured, else the artist alone.
      // The optional permanence vault is carved in as one more recipient.
      const baseRows: Collaborator[] = splitOn
        ? collabCheck.parsed
        : [{ address: (payout === "" ? address : (payout as Address)), percent: 100 }]
      const { accounts, allocations } = buildSplitArgsWithPermanence(
        baseRows,
        permanenceOn ? permCheck.parsed : null,
      )
      // Immutable split: distributorFee 0, controller 0. Receipt -> edition.
      split.writeContract({
        address: splitMain,
        abi: splitMainAbi,
        functionName: "createSplit",
        args: [accounts, allocations, 0, ZERO_ADDRESS as Address],
      })
    } else {
      deployEdition((payout === "" ? ZERO_ADDRESS : payout) as Address)
    }
  }

  const busy = split.isPending || splitMining || edition.isPending || editionMining
  const btnLabel = split.isPending
    ? "Confirm split in wallet…"
    : splitMining
      ? "Deploying split…"
      : edition.isPending
        ? "Confirm in wallet…"
        : editionMining
          ? "Deploying edition…"
          : usingSplit
            ? "Deploy split + edition"
            : "Deploy edition"
  const writeError = split.error ?? edition.error

  function setCollab(i: number, field: keyof CollabRow, value: string) {
    setCollabs((rows) => rows.map((r, j) => (j === i ? { ...r, [field]: value } : r)))
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      {!factory && (
        <p className="border-b border-border px-6 py-3 text-xs text-red-500">
          No PND Editions factory is configured for this network.
        </p>
      )}

      <div className="divide-y divide-border">
        {/* Details */}
        <Section title="Details">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Title" htmlFor="ed-title">
                <input
                  id="ed-title"
                  className={inputCls}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Studies in Grey"
                  disabled={busy}
                />
              </Field>
            </div>
            <Field label="Symbol" htmlFor="ed-symbol">
              <input
                id="ed-symbol"
                className={inputCls}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="GREY"
                disabled={busy}
              />
            </Field>
          </div>
        </Section>

        {/* Artwork + preservation */}
        <Section title="Artwork">
          <ArtworkInput value={artworkURI} onChange={setArtworkURI} disabled={busy} />

          {muriRenderer && (
            <div className="space-y-2">
              <span className={labelCls}>Preservation</span>
              <div className="grid grid-cols-2 gap-2">
                <OptionCard
                  active={tier === "standard"}
                  disabled={busy}
                  onClick={() => setTier("standard")}
                  title="Standard"
                  desc="Artwork lives where you uploaded it; you keep it pinned."
                />
                <OptionCard
                  active={tier === "permanent"}
                  disabled={busy}
                  onClick={() => setTier("permanent")}
                  title="Permanent"
                  desc="Onchain fallbacks, an integrity hash, and a viewer via MURI."
                />
              </div>
              {tier === "permanent" && (
                <Hint>
                  After deploy you finish anchoring (2 transactions) on the edition
                  page. Your tokens keep their live Mint Marks, and PND never holds
                  your media.
                </Hint>
              )}
            </div>
          )}
        </Section>

        {/* Mint settings */}
        <Section title="Mint">
          <Field
            label="Price"
            htmlFor="ed-price"
            hint={
              <>
                0 is gas only, never called free. On paid mints a fixed{" "}
                {formatBps(SURFACE_SHARE_BPS)} surface share goes to PND when minted here;
                deploy your own page and you keep it.
              </>
            }
          >
            <div className="flex items-stretch border border-border transition-colors focus-within:border-border-strong">
              <input
                id="ed-price"
                {...price.inputProps}
                placeholder="0"
                className="flex-1 bg-surface px-3 py-2.5 text-sm font-mono tabular-nums outline-none disabled:opacity-40"
                disabled={busy}
              />
              <span className="flex items-center border-l border-border px-3 text-[10px] font-mono uppercase tracking-[0.1em] text-fg-subtle">
                ETH
              </span>
            </div>
          </Field>
          {price.error && <p className="text-xs text-red-500">{price.error}</p>}

          <div className="space-y-2">
            <span className={labelCls}>Edition size</span>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                value={openEdition ? "open" : "limited"}
                onChange={(v) => setOpenEdition(v === "open")}
                disabled={busy}
                options={[
                  { value: "open", label: "Open" },
                  { value: "limited", label: "Limited" },
                ]}
              />
              {!openEdition && (
                <input
                  type="number"
                  min={1}
                  step={1}
                  className={`${inputCls} w-32 tabular-nums`}
                  value={supplyCap}
                  onChange={(e) => setSupplyCap(e.target.value)}
                  disabled={busy}
                  placeholder="Max supply"
                />
              )}
            </div>
          </div>

          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              checked={hasWindow}
              onChange={(e) => setHasWindow(e.target.checked)}
              disabled={busy}
              className="h-3.5 w-3.5 accent-fg"
            />
            <span className="text-sm text-fg-muted">Set a mint window</span>
          </label>
          {hasWindow && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Opens" htmlFor="ed-start">
                <input
                  id="ed-start"
                  type="datetime-local"
                  className={inputCls}
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field label="Closes" htmlFor="ed-end">
                <input
                  id="ed-end"
                  type="datetime-local"
                  className={inputCls}
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  disabled={busy}
                />
              </Field>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Royalty %" htmlFor="ed-royalty" hint="EIP-2981, honored by marketplaces. Max 50%.">
              <input
                id="ed-royalty"
                type="text"
                inputMode="decimal"
                className={`${inputCls} tabular-nums`}
                value={royaltyPct}
                onChange={(e) => setRoyaltyPct(e.target.value.replace(/[^0-9.]/g, ""))}
                disabled={busy}
              />
            </Field>
            {!splitOn && (
              <Field label="Payout" htmlFor="ed-payout" hint="Defaults to you.">
                <input
                  id="ed-payout"
                  className={inputCls}
                  value={payout}
                  onChange={(e) => setPayout(e.target.value.trim())}
                  placeholder="0x… (optional)"
                  disabled={busy}
                />
                {!payoutOk && <p className="mt-1 text-xs text-red-500">Invalid address</p>}
              </Field>
            )}
          </div>

          {/* Optional collaborator splits (0xSplits) */}
          <div className="space-y-2">
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={splitOn}
                onChange={(e) => setSplitOn(e.target.checked)}
                disabled={busy || !splitMain}
                className="h-3.5 w-3.5 accent-fg"
              />
              <span className="text-sm text-fg-muted">Split proceeds with collaborators</span>
            </label>
            {splitOn && (
              <div className="space-y-2">
                {collabs.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_72px_28px] gap-2">
                    <input
                      className={inputCls}
                      value={row.address}
                      onChange={(e) => setCollab(i, "address", e.target.value.trim())}
                      placeholder="0x… collaborator"
                      disabled={busy}
                    />
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      className={`${inputCls} tabular-nums`}
                      value={row.percent}
                      onChange={(e) => setCollab(i, "percent", e.target.value)}
                      placeholder="%"
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="text-xs font-mono text-fg-subtle hover:text-red-500 disabled:opacity-30"
                      onClick={() => setCollabs((rows) => rows.filter((_, j) => j !== i))}
                      disabled={busy || collabs.length <= 2}
                      aria-label="Remove collaborator"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-[10px] font-mono uppercase tracking-[0.1em] text-fg-subtle hover:text-fg disabled:opacity-30"
                  onClick={() => setCollabs((rows) => [...rows, { address: "", percent: "" }])}
                  disabled={busy}
                >
                  + Add collaborator
                </button>
                <Hint>
                  Deploys an immutable 0xSplits split and routes payout to it. Shares are
                  whole percentages and must total 100. Two transactions: the split, then
                  the edition.
                </Hint>
                {!splitMain && (
                  <p className="text-xs text-red-500">0xSplits is not available on this network.</p>
                )}
                {collabCheck.error && <p className="text-xs text-red-500">{collabCheck.error}</p>}
              </div>
            )}
          </div>

          {/* Optional: fund this work's permanence (Phase 1, Option A) */}
          <div className="space-y-2">
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={permanenceOn}
                onChange={(e) => setPermanenceOn(e.target.checked)}
                disabled={busy || !splitMain}
                className="h-3.5 w-3.5 accent-fg"
              />
              <span className="text-sm text-fg-muted">Fund this work&rsquo;s permanence</span>
            </label>
            {permanenceOn && (
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_72px] gap-2">
                  <input
                    className={inputCls}
                    value={permanenceVault}
                    onChange={(e) => setPermanenceVault(e.target.value.trim())}
                    placeholder="0x… permanence vault"
                    disabled={busy}
                  />
                  <input
                    type="number"
                    min={1}
                    max={99}
                    step={1}
                    className={`${inputCls} tabular-nums`}
                    value={permanencePct}
                    onChange={(e) => setPermanencePct(e.target.value)}
                    placeholder="%"
                    disabled={busy}
                  />
                </div>
                <Hint>
                  Routes {permCheck.ok ? `${permanencePct}%` : "a slice"} of every mint to an
                  address you control, earmarked for keeping this work alive. Carved from
                  your payout (collectors still pay exactly the price), so it
                  proportionally reduces your{splitOn ? " and your collaborators’" : ""}{" "}
                  share. This is a funding pot, not permanence on its own: later you fund a
                  pay-once Arweave copy or renewable pinning from it. PND never holds it.
                </Hint>
                {!splitMain && (
                  <p className="text-xs text-red-500">0xSplits is not available on this network.</p>
                )}
                {permCheck.error && <p className="text-xs text-red-500">{permCheck.error}</p>}
              </div>
            )}
          </div>
        </Section>

        {/* Deploy */}
        <div className="space-y-4 p-6">
          <div className="space-y-2 border border-border bg-surface-muted/40 px-4 py-3">
            <p className={labelCls}>Costs, kept separate</p>
            <CostRow label="Storage" value="Free under 100 KB (Arweave), else wallet-paid" />
            <CostRow label="Deploy" value="Network gas, in ETH" />
            {usingSplit && <CostRow label="Split" value="One transaction before deploy, gas only" />}
            {permanenceOn && permCheck.ok && (
              <CostRow
                label="Permanence"
                value={`${permanencePct}% of each mint routes to your vault`}
              />
            )}
            {tier === "permanent" && muriRenderer && (
              <CostRow label="Anchor" value="2 transactions after deploy, gas only" />
            )}
          </div>

          <button onClick={submit} disabled={!canSubmit || busy} className={primaryBtnCls}>
            {btnLabel}
          </button>

          {writeError && (
            <p className="text-xs text-red-500 break-words">
              {formatWriteError(writeError, "Deploy")}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 p-6">
      <h3 className="text-[10px] font-mono uppercase tracking-[0.18em] text-fg">{title}</h3>
      {children}
    </section>
  )
}

function OptionCard({
  active,
  disabled,
  onClick,
  title,
  desc,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  title: string
  desc: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-start gap-1.5 border p-3 text-left transition-colors disabled:opacity-40 ${
        active ? "border-fg bg-surface-muted/50" : "border-border hover:border-border-strong"
      }`}
    >
      <span className="flex w-full items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        <span
          className={`h-2.5 w-2.5 rounded-full border ${
            active ? "border-fg bg-fg" : "border-border-strong"
          }`}
        />
      </span>
      <span className="text-xs leading-snug text-fg-muted">{desc}</span>
    </button>
  )
}

function CostRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <span className="font-mono uppercase tracking-[0.1em] text-fg-subtle">{label}</span>
      <span className="text-right text-fg-muted">{value}</span>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface p-6">
      <p className="text-sm leading-relaxed text-fg-muted">
        Deploying an edition mints you your own ERC721A contract, set up with your
        artwork and mint conditions in one transaction. You own it. Each token a
        collector mints keeps its own identity and onchain Mint Mark.
      </p>
      {children}
    </div>
  )
}
