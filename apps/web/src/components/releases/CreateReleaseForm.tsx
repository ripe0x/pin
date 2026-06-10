"use client"

/**
 * The artist flow, one step: set the terms and deploy the release. A release
 * is a complete ERC721A contract the artist owns from construction — price,
 * window, supply, and gate are immutable the moment it deploys. Honest
 * pricing language throughout: free means gas only; the artist gets
 * everything they priced; the surface earns only when chosen.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { formatEther, isAddress, parseEventLogs, type Address } from "viem"
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { releaseFactoryAbi } from "@pin/abi"
import {
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  formatWriteError,
} from "@/components/tx/tx-ui"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import {
  GateMode,
  ZERO_ADDRESS,
  releaseFactoryAddress,
} from "@/lib/releases"

const LABEL =
  "block text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-1.5"
const INPUT =
  "w-full px-3 py-2 text-xs font-mono bg-surface border border-gray-200 focus:border-gray-400 outline-none transition-colors disabled:opacity-40"
const BTN =
  "block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
const HELP = "mt-1.5 text-[10px] font-mono text-gray-400 leading-relaxed"

const WINDOW_PRESETS = [
  { value: "24h", label: "24 hours", seconds: 24 * 3600 },
  { value: "72h", label: "3 days", seconds: 72 * 3600 },
  { value: "168h", label: "7 days", seconds: 168 * 3600 },
  { value: "open", label: "Open-ended (close it yourself)", seconds: 0 },
  { value: "custom", label: "Custom dates", seconds: 0 },
] as const

type WindowPreset = (typeof WINDOW_PRESETS)[number]["value"]

export function CreateReleaseForm({
  surfaceFeeWei,
}: {
  /** The factory's current per-token surface fee, read server-side. */
  surfaceFeeWei: string | null
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
  const router = useRouter()

  const factory = releaseFactoryAddress()

  const [title, setTitle] = useState("")
  const [symbol, setSymbol] = useState("")
  const [uri, setUri] = useState("")
  const [uriPerToken, setUriPerToken] = useState(false)
  const price = useEthAmountInput()
  const [openEdition, setOpenEdition] = useState(true)
  const [supplyCap, setSupplyCap] = useState("100")
  const [windowPreset, setWindowPreset] = useState<WindowPreset>("72h")
  const [startAt, setStartAt] = useState("")
  const [endAt, setEndAt] = useState("")
  const [royaltyPct, setRoyaltyPct] = useState("5")
  const [payout, setPayout] = useState("")
  const [contractURI, setContractURI] = useState("")
  const [gated, setGated] = useState(false)
  const [gateToken, setGateToken] = useState("")
  const [gateMode, setGateMode] = useState<GateMode>(GateMode.Hold)

  const deploy = useWriteContract()
  const { data: receipt, isLoading: mining } = useWaitForTransactionReceipt({
    hash: deploy.data,
  })

  // Deploy confirmed: go to the new release.
  useEffect(() => {
    if (!receipt) return
    try {
      const logs = parseEventLogs({
        abi: releaseFactoryAbi,
        logs: receipt.logs,
        eventName: "ReleaseCreated",
      })
      const created = logs[0]?.args as { release?: Address } | undefined
      if (created?.release) {
        deploy.reset()
        router.push(`/releases/${created.release}`)
      }
    } catch {
      // user can retry
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt])

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
          {isSwitchPending
            ? "Switching…"
            : `Switch to ${PREFERRED_CHAIN_LABEL}`}
        </button>
      </Shell>
    )
  }

  function toUnix(local: string): bigint {
    return BigInt(Math.floor(new Date(local).getTime() / 1000))
  }

  const royaltyBps = Math.round(Number(royaltyPct || "0") * 100)
  const royaltyOk = royaltyBps >= 0 && royaltyBps <= 5_000 // MAX_ROYALTY_BPS
  const capOk =
    openEdition || (Number(supplyCap) > 0 && Number.isFinite(Number(supplyCap)))
  const payoutOk = payout === "" || isAddress(payout)
  const customOk =
    windowPreset !== "custom" ||
    (endAt !== "" &&
      toUnix(endAt) > BigInt(Math.floor(Date.now() / 1000)) &&
      (startAt === "" || toUnix(endAt) > toUnix(startAt)))
  const gateOk = !gated || isAddress(gateToken)
  const canSubmit =
    !!factory &&
    !!address &&
    title.trim().length > 0 &&
    symbol.trim().length > 0 &&
    uri.trim().length > 0 &&
    (price.isEmpty || price.isValid) &&
    royaltyOk &&
    capOk &&
    payoutOk &&
    customOk &&
    gateOk

  function submit() {
    if (!factory) return
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    let startTime = 0n // 0 = live immediately
    let endTime = 0n // 0 = open-ended
    if (windowPreset === "custom") {
      startTime = startAt ? toUnix(startAt) : 0n
      endTime = toUnix(endAt)
    } else {
      const preset = WINDOW_PRESETS.find((w) => w.value === windowPreset)
      if (preset && preset.seconds > 0) {
        endTime = nowSec + BigInt(preset.seconds)
      }
    }

    deploy.writeContract({
      address: factory,
      abi: releaseFactoryAbi,
      functionName: "createRelease",
      args: [
        {
          name: title.trim(),
          symbol: symbol.trim(),
          price: price.wei ?? 0n,
          startTime,
          endTime,
          maxSupply: openEdition ? 0n : BigInt(supplyCap),
          gateToken: gated ? (gateToken as Address) : ZERO_ADDRESS,
          gateMode: gated ? gateMode : GateMode.None,
          payout:
            payout && isAddress(payout) ? (payout as Address) : ZERO_ADDRESS,
          royaltyReceiver: ZERO_ADDRESS, // defaults to payout onchain
          royaltyBps: BigInt(royaltyBps),
          uri: uri.trim(),
          uriPerToken,
          renderer: ZERO_ADDRESS,
          contractURI: contractURI.trim(),
        },
      ],
    })
  }

  const busy = deploy.isPending || mining
  const btnLabel = deploy.isPending
    ? "Confirm in wallet…"
    : mining
      ? "Deploying…"
      : "Deploy release"

  const feeLine =
    surfaceFeeWei && BigInt(surfaceFeeWei) > 0n
      ? `${formatEther(BigInt(surfaceFeeWei))} ETH`
      : null

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-5">
      {!factory && (
        <p className="text-[11px] font-mono text-red-500">
          The release factory is not configured for this network.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className={LABEL} htmlFor="rel-title">
            Title
          </label>
          <input
            id="rel-title"
            className={INPUT}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Release title"
            disabled={busy}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="rel-symbol">
            Symbol
          </label>
          <input
            id="rel-symbol"
            className={INPUT}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="WORK"
            disabled={busy}
          />
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="rel-uri">
          Metadata URI
        </label>
        <input
          id="rel-uri"
          className={INPUT}
          value={uri}
          onChange={(e) => setUri(e.target.value.trim())}
          placeholder="ipfs://…/metadata.json"
          disabled={busy}
        />
        <p className={HELP}>
          Link to the token metadata JSON (name, description, image). Pin it
          yourself; you can update it any time until you freeze metadata.
        </p>
        <label className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={uriPerToken}
            onChange={(e) => setUriPerToken(e.target.checked)}
            disabled={busy}
          />
          <span className="text-[11px] font-mono text-gray-600">
            Per-token metadata (token id is appended to the URI)
          </span>
        </label>
      </div>

      <div>
        <label className={LABEL} htmlFor="rel-price">
          Price (ETH)
        </label>
        <input
          id="rel-price"
          {...price.inputProps}
          className={INPUT}
          placeholder="0"
          disabled={busy}
        />
        <p className={HELP}>
          You receive 100% of this, always. Empty or 0 = free, and free means
          gas only: a free release never charges any fee, on any surface.
        </p>
        {feeLine && (
          <p className={HELP}>
            Minting through a surface adds a flat {feeLine} per token, paid by
            the collector to whichever surface serves the mint (PND when
            minted here; you, if you host your own page). Direct mints with no
            surface pay your price only.
          </p>
        )}
        {price.error && (
          <p className="mt-1 text-[10px] font-mono text-red-500">
            {price.error}
          </p>
        )}
      </div>

      <div>
        <label className={LABEL} htmlFor="rel-window">
          Mint window
        </label>
        <select
          id="rel-window"
          className={INPUT}
          value={windowPreset}
          onChange={(e) => setWindowPreset(e.target.value as WindowPreset)}
          disabled={busy}
        >
          {WINDOW_PRESETS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
        <p className={HELP}>
          The window is the release&apos;s supply mechanism: it can be closed
          early but never extended. Whoever shows up during the window decides
          the edition size.
        </p>
        {windowPreset === "custom" && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="rel-start">
                Starts (optional, default now)
              </label>
              <input
                id="rel-start"
                type="datetime-local"
                className={INPUT}
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                disabled={busy}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="rel-end">
                Ends
              </label>
              <input
                id="rel-end"
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

      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={openEdition}
            onChange={(e) => setOpenEdition(e.target.checked)}
            disabled={busy}
          />
          <span className="text-[11px] font-mono text-gray-600">
            Open edition (no supply cap)
          </span>
        </label>
        {!openEdition && (
          <input
            type="number"
            min={1}
            step={1}
            className={INPUT}
            value={supplyCap}
            onChange={(e) => setSupplyCap(e.target.value)}
            placeholder="Max supply"
            aria-label="Max supply"
            disabled={busy}
          />
        )}
      </div>

      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={gated}
            onChange={(e) => setGated(e.target.checked)}
            disabled={busy}
          />
          <span className="text-[11px] font-mono text-gray-600">
            Gate on a previous work (continuation)
          </span>
        </label>
        {gated && (
          <div className="space-y-3">
            <input
              className={INPUT}
              value={gateToken}
              onChange={(e) => setGateToken(e.target.value.trim())}
              placeholder="0x… ERC721 contract collectors must hold (or burn)"
              aria-label="Gate contract"
              disabled={busy}
            />
            <select
              className={INPUT}
              value={gateMode}
              onChange={(e) => setGateMode(Number(e.target.value) as GateMode)}
              aria-label="Gate mode"
              disabled={busy}
            >
              <option value={GateMode.Hold}>
                Hold to mint (each token claims once, token untouched)
              </option>
              <option value={GateMode.Burn}>
                Burn to mint (token is consumed; contract must expose burn)
              </option>
            </select>
            <p className={HELP}>
              Any ERC721 works for hold-gates, including work that predates
              PND. Burn-gates need a contract with owner-or-approved
              burn(tokenId) — every PND release qualifies.
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="rel-royalty">
            Royalty %
          </label>
          <input
            id="rel-royalty"
            type="number"
            min={0}
            max={50}
            step={0.5}
            className={INPUT}
            value={royaltyPct}
            onChange={(e) => setRoyaltyPct(e.target.value)}
            disabled={busy}
          />
          <p className={HELP}>ERC-2981 signal; marketplaces decide.</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="rel-payout">
            Payout (optional)
          </label>
          <input
            id="rel-payout"
            className={INPUT}
            value={payout}
            onChange={(e) => setPayout(e.target.value.trim())}
            placeholder="Defaults to your wallet"
            disabled={busy}
          />
          <p className={HELP}>
            Where proceeds land. Point at a split contract to share them.
          </p>
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="rel-contract-uri">
          Collection metadata URI (optional)
        </label>
        <input
          id="rel-contract-uri"
          className={INPUT}
          value={contractURI}
          onChange={(e) => setContractURI(e.target.value.trim())}
          placeholder="ipfs://…/collection.json"
          disabled={busy}
        />
      </div>

      <button onClick={submit} disabled={!canSubmit || busy} className={BTN}>
        {btnLabel}
      </button>

      {deploy.error && (
        <p className="text-[11px] font-mono text-red-500 break-words">
          {formatWriteError(deploy.error, "Deploy")}
        </p>
      )}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-4">
      <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
        Deploying a release gives you your own complete ERC721A contract, with
        your terms fixed in its bytecode: price, window, supply, gate. You own
        it outright. If every PND page disappeared tomorrow, your release
        keeps minting and paying you.
      </p>
      {children}
    </div>
  )
}
