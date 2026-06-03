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
import { PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL, formatWriteError } from "@/components/tx/tx-ui"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import {
  EditionKind,
  SURFACE_SHARE_BPS,
  ZERO_ADDRESS,
  buildSplitArgs,
  formatBps,
  pndEditionsFactory,
  pndSplitMain,
  pndMuriRenderer,
  validateCollaborators,
} from "@/lib/pnd-editions"

const LABEL = "block text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-1.5"
const INPUT =
  "w-full px-3 py-2 text-xs font-mono bg-surface border border-gray-200 focus:border-gray-400 outline-none transition-colors disabled:opacity-40"
const BTN =
  "block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
const HELP = "mt-1.5 text-[10px] font-mono text-gray-400 leading-relaxed"

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
            <button onClick={openConnectModal} className={BTN}>
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
          className={BTN}
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
  const canSubmit =
    !!factory &&
    !!address &&
    title.trim().length > 0 &&
    symbol.trim().length > 0 &&
    artworkURI.trim().length > 0 &&
    (price.isEmpty || price.isValid) &&
    royaltyOk &&
    capOk &&
    (splitOn ? splitOk : payoutOk)

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
    if (splitOn) {
      if (!splitMain) return
      const { accounts, allocations } = buildSplitArgs(collabCheck.parsed)
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
          : splitOn
            ? "Deploy split + edition"
            : "Deploy edition"
  const writeError = split.error ?? edition.error

  function setCollab(i: number, field: keyof CollabRow, value: string) {
    setCollabs((rows) => rows.map((r, j) => (j === i ? { ...r, [field]: value } : r)))
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-5">
      {!factory && (
        <p className="text-[11px] font-mono text-red-500">
          No PND Editions factory is configured for this network.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className={LABEL} htmlFor="ed-title">
            Title
          </label>
          <input
            id="ed-title"
            className={INPUT}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Studies in Grey"
            disabled={busy}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="ed-symbol">
            Symbol
          </label>
          <input
            id="ed-symbol"
            className={INPUT}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="GREY"
            disabled={busy}
          />
        </div>
      </div>

      <ArtworkInput value={artworkURI} onChange={setArtworkURI} disabled={busy} />

      {muriRenderer && (
        <div>
          <label className={LABEL}>Preservation</label>
          <div className="mb-1.5 flex gap-1">
            <TierTab active={tier === "standard"} disabled={busy} onClick={() => setTier("standard")}>
              Standard
            </TierTab>
            <TierTab active={tier === "permanent"} disabled={busy} onClick={() => setTier("permanent")}>
              Permanent (MURI)
            </TierTab>
          </div>
          <p className={HELP}>
            {tier === "standard"
              ? "Your artwork stays where you uploaded it and you keep it pinned. You can make it permanent later from the edition page."
              : "Adds onchain media permanence via MURI: multiple fallback URIs, a SHA-256 integrity hash, and an onchain viewer that shows the first surviving copy. After deploy you finish anchoring (2 transactions) on the edition page. Your tokens keep their live Mint Marks, and PND never holds your media."}
          </p>
        </div>
      )}

      <div>
        <label className={LABEL} htmlFor="ed-price">
          Price (ETH)
        </label>
        <input
          id="ed-price"
          {...price.inputProps}
          placeholder="0"
          className={INPUT}
          disabled={busy}
        />
        <p className={HELP}>
          0 = gas only (never called free). The artist always keeps at least{" "}
          {formatBps(10_000 - SURFACE_SHARE_BPS)} of a paid mint; the fixed{" "}
          {formatBps(SURFACE_SHARE_BPS)} surface share goes to PND when minted here, and you
          keep 100% by minting on your own site.
        </p>
        {price.error && <p className="mt-1 text-[10px] font-mono text-red-500">{price.error}</p>}
      </div>

      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={openEdition}
            onChange={(e) => setOpenEdition(e.target.checked)}
            disabled={busy}
          />
          <span className="text-[11px] font-mono text-gray-600">Open edition (no cap)</span>
        </label>
        {!openEdition && (
          <input
            type="number"
            min={1}
            step={1}
            className={INPUT}
            value={supplyCap}
            onChange={(e) => setSupplyCap(e.target.value)}
            disabled={busy}
            placeholder="Max supply"
          />
        )}
      </div>

      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={hasWindow}
            onChange={(e) => setHasWindow(e.target.checked)}
            disabled={busy}
          />
          <span className="text-[11px] font-mono text-gray-600">Set a mint window</span>
        </label>
        {hasWindow && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="ed-start">
                Opens
              </label>
              <input
                id="ed-start"
                type="datetime-local"
                className={INPUT}
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                disabled={busy}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="ed-end">
                Closes
              </label>
              <input
                id="ed-end"
                type="datetime-local"
                className={INPUT}
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="ed-royalty">
            Royalty (%)
          </label>
          <input
            id="ed-royalty"
            type="text"
            inputMode="decimal"
            className={INPUT}
            value={royaltyPct}
            onChange={(e) => setRoyaltyPct(e.target.value.replace(/[^0-9.]/g, ""))}
            disabled={busy}
          />
          <p className={HELP}>EIP-2981, honored by marketplaces. Max 50%.</p>
        </div>
        {!splitOn && (
          <div>
            <label className={LABEL} htmlFor="ed-payout">
              Payout (optional)
            </label>
            <input
              id="ed-payout"
              className={INPUT}
              value={payout}
              onChange={(e) => setPayout(e.target.value.trim())}
              placeholder="defaults to you"
              disabled={busy}
            />
            {!payoutOk && (
              <p className="mt-1 text-[10px] font-mono text-red-500">Invalid address</p>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={splitOn}
            onChange={(e) => setSplitOn(e.target.checked)}
            disabled={busy || !splitMain}
          />
          <span className="text-[11px] font-mono text-gray-600">
            Split proceeds with collaborators
          </span>
        </label>
        {splitOn && (
          <div className="space-y-2">
            {collabs.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_72px_28px] gap-2">
                <input
                  className={INPUT}
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
                  className={INPUT}
                  value={row.percent}
                  onChange={(e) => setCollab(i, "percent", e.target.value)}
                  placeholder="%"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="text-[11px] font-mono text-gray-400 hover:text-red-500 disabled:opacity-30"
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
              className="text-[10px] font-mono uppercase tracking-wider text-gray-500 hover:text-fg disabled:opacity-30"
              onClick={() => setCollabs((rows) => [...rows, { address: "", percent: "" }])}
              disabled={busy}
            >
              + Add collaborator
            </button>
            <p className={HELP}>
              Deploys an immutable 0xSplits split and routes payout to it. Shares are
              whole percentages and must total 100. Two transactions: the split, then
              the edition.
            </p>
            {!splitMain && (
              <p className="text-[10px] font-mono text-red-500">
                0xSplits is not available on this network.
              </p>
            )}
            {collabCheck.error && (
              <p className="text-[10px] font-mono text-red-500">{collabCheck.error}</p>
            )}
          </div>
        )}
      </div>

      <div className="rounded border border-gray-100 px-3 py-2">
        <p className="mb-1 text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Costs, kept separate
        </p>
        <p className={`${HELP} !mt-0`}>
          Storage is handled in the artwork step (free under 100 KB on Arweave,
          or your own IPFS plan; paid once from your wallet if larger). Deploying
          this edition is gas only, in ETH.
          {tier === "permanent" && muriRenderer
            ? " Permanent adds 2 anchor transactions (gas only) after deploy."
            : ""}
        </p>
      </div>

      <button onClick={submit} disabled={!canSubmit || busy} className={BTN}>
        {btnLabel}
      </button>

      {writeError && (
        <p className="text-[11px] font-mono text-red-500 break-words">
          {formatWriteError(writeError, "Deploy")}
        </p>
      )}
    </div>
  )
}

function TierTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wider border transition-colors disabled:opacity-40 ${
        active ? "border-fg bg-fg text-bg" : "border-gray-200 text-gray-500 hover:border-gray-400"
      }`}
    >
      {children}
    </button>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-4">
      <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
        Deploying an edition mints you your own ERC721A contract, set up with your
        artwork and mint conditions in one transaction. You own it. Each token a
        collector mints keeps its own identity and onchain Mint Mark.
      </p>
      {children}
    </div>
  )
}
