"use client"

/**
 * Collection settings for a primitive-first Surface v2 collection
 * (contracts/src/surface/v2/Surface.sol). Every lever is an owner-only
 * setter on the token: renderer, supply cap, royalty, name, the single
 * minter slot, and renounceOwnership (the only lock). There is no cover or
 * creator roster here: in v2 the cover and description are the renderer's
 * contractURI, and co-creator credit lives in the Catalog. The airdrop flow
 * (owner mints / artist proofs) lives here too, since it borrows the minter
 * slot.
 *
 * State is the live /v2 read (V2Router); each write simulates first, pins
 * the chain, and re-reads on its receipt (useV2Write).
 */

import { useState } from "react"
import { isAddress, type Abi, type Address } from "viem"
import { useAccount, useBytecode } from "wagmi"
import { surfaceTokenV2Abi } from "@pin/abi"
import { BTN, BTN_SECONDARY, ERROR, HELP, INPUT, LABEL } from "@/components/studio/create/wizard-ui"
import { shortAddress } from "@/lib/collection"
import {
  isOwner,
  minterRole,
  nameArgs,
  parseCount,
  royaltyArgs,
  supplyCapProblem,
  type SurfaceV2State,
} from "@/lib/surface-v2-studio"
import { useV2Write } from "./useV2Write"
import { Notice, ReadGrid, Section, WriteError } from "./ui"
import { AirdropSection } from "./AirdropSection"
import { RenounceSection } from "./RenounceSection"

const TOKEN_ABI = surfaceTokenV2Abi as Abi

export function minterLabel(s: SurfaceV2State): string {
  switch (minterRole(s)) {
    case "none":
      return "None (nobody can mint)"
    case "sale":
      return `${shortAddress(s.minter!)} (fixed-price sale)`
    case "owner":
      return `${shortAddress(s.minter!)} (your wallet: public sale paused)`
    default:
      return `${shortAddress(s.minter!)} (custom minter)`
  }
}

export function SurfaceV2SettingsPanel({ state, refetch }: { state: SurfaceV2State; refetch: () => void }) {
  const { address: account } = useAccount()
  const owner = isOwner(state, account)
  const supply = state.supplyCap === "0" ? `${state.minted} minted, open supply` : `${state.minted} / ${state.supplyCap} minted`

  return (
    <div className="space-y-4">
      <ReadGrid
        title="Onchain now"
        rows={[
          ["Contract", "Surface v2"],
          ["Owner", state.renounced ? "Renounced" : state.owner],
          ["Name", `${state.name} (${state.symbol})`],
          ["Renderer", state.renderer],
          ["Minter", minterLabel(state)],
          ["Supply", supply],
          ["Royalty", `${state.royaltyBps / 100}% to ${shortAddress(state.royaltyReceiver)}`],
        ]}
      />

      {state.renounced && (
        <Notice>
          Ownership is renounced. The renderer, minter, supply cap, royalty and name are permanent, and the
          sale&apos;s settings are frozen with them. Payouts still flow.
        </Notice>
      )}
      {!state.renounced && !owner && (
        <Notice tone="amber">
          Connect the owner wallet ({shortAddress(state.owner)}) to change these settings. Every setter is
          owner-only onchain.
        </Notice>
      )}

      {!state.renounced && (
        <>
          <NameSection state={state} enabled={owner} onDone={refetch} />
          <RendererSection state={state} enabled={owner} onDone={refetch} />
          <SupplySection state={state} enabled={owner} onDone={refetch} />
          <RoyaltySection state={state} enabled={owner} onDone={refetch} />
          <MinterSection state={state} enabled={owner} onDone={refetch} />
          <AirdropSection state={state} enabled={owner} onDone={refetch} />
          <RenounceSection state={state} enabled={owner} onDone={refetch} />
        </>
      )}

      <p className="text-[10px] font-mono text-gray-400 leading-relaxed border-t border-gray-100 pt-4">
        A v2 collection has no cover or creator roster on the contract. Its cover and description come from
        the renderer&apos;s contractURI, and co-creator credit comes from the Catalog. Price, window and
        allowlist live on the sale: see Sale settings and Mint gate.
      </p>
    </div>
  )
}

type SectionProps = { state: SurfaceV2State; enabled: boolean; onDone: () => void }

function NameSection({ state, enabled, onDone }: SectionProps) {
  const [name, setName] = useState(state.name)
  const [symbol, setSymbol] = useState(state.symbol)
  const w = useV2Write(onDone)
  const parsed = nameArgs(name, symbol)
  const changed = name.trim() !== state.name || symbol.trim() !== state.symbol
  return (
    <Section title="Name" help="The token name and symbol. Renderers read the name from the token, so a change shows everywhere.">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_10rem]">
        <label className="block">
          <span className={LABEL}>Collection name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Token symbol</span>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className={INPUT} />
        </label>
      </div>
      {!parsed.ok && <p className={ERROR}>{parsed.error}</p>}
      <button
        type="button"
        disabled={!enabled || !parsed.ok || !changed || w.busy}
        onClick={() => parsed.ok && w.run({ address: state.collection, abi: TOKEN_ABI, functionName: "setName", args: parsed.args })}
        className={BTN}
      >
        {w.label ?? "Set name"}
      </button>
      <WriteError error={w.error} action="Set name" />
    </Section>
  )
}

function RendererSection({ state, enabled, onDone }: SectionProps) {
  const [next, setNext] = useState("")
  const w = useV2Write(onDone)
  const trimmed = next.trim()
  const valid = isAddress(trimmed)
  const { data: code } = useBytecode({ address: valid ? (trimmed as Address) : undefined, query: { enabled: valid } })
  const isContract = !!code && code !== "0x"
  return (
    <Section title="Renderer" help="The contract that answers tokenURI and contractURI. Swapping it changes how every token, and the collection cover, render.">
      <label className="block">
        <span className={LABEL}>New renderer</span>
        <input
          type="text"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="0x… renderer contract"
          spellCheck={false}
          className={INPUT}
        />
      </label>
      {valid && code !== undefined && !isContract && (
        <p className={ERROR}>No contract code at this address. The token rejects a renderer without code.</p>
      )}
      <button
        type="button"
        disabled={!enabled || !valid || !isContract || w.busy}
        onClick={() => w.run({ address: state.collection, abi: TOKEN_ABI, functionName: "setRenderer", args: [trimmed as Address] })}
        className={BTN}
      >
        {w.label ?? "Set renderer"}
      </button>
      <WriteError error={w.error} action="Set renderer" />
    </Section>
  )
}

function SupplySection({ state, enabled, onDone }: SectionProps) {
  const [cap, setCap] = useState("")
  const w = useV2Write(onDone)
  const parsed = cap.trim() === "" ? null : parseCount(cap)
  const problem = parsed === null ? null : supplyCapProblem(parsed, BigInt(state.minted))
  return (
    <Section
      title="Supply cap"
      help="The most tokens this collection can ever mint, counting owner airdrops. 0 means open. A nonzero cap cannot go below what is already minted; burns never free room."
    >
      <label className="block">
        <span className={LABEL}>New supply cap</span>
        <input
          type="text"
          inputMode="numeric"
          value={cap}
          onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="0 = open"
          className={INPUT}
        />
      </label>
      {problem && <p className={ERROR}>{problem}</p>}
      <button
        type="button"
        disabled={!enabled || parsed === null || !!problem || w.busy}
        onClick={() => parsed !== null && w.run({ address: state.collection, abi: TOKEN_ABI, functionName: "setSupplyCap", args: [parsed] })}
        className={BTN}
      >
        {w.label ?? "Set supply cap"}
      </button>
      <WriteError error={w.error} action="Set supply cap" />
    </Section>
  )
}

function RoyaltySection({ state, enabled, onDone }: SectionProps) {
  const [bps, setBps] = useState(String(state.royaltyBps))
  const [receiver, setReceiver] = useState(
    state.royaltyReceiver.toLowerCase() === state.owner.toLowerCase() ? "" : state.royaltyReceiver,
  )
  const w = useV2Write(onDone)
  const parsed = royaltyArgs(bps, receiver, state.owner)
  const changed =
    parsed.ok &&
    (parsed.args[0] !== state.royaltyBps || parsed.args[1].toLowerCase() !== state.royaltyReceiver.toLowerCase())
  return (
    <Section title="Royalty" help="The EIP-2981 secondary royalty: basis points (100 = 1%) up to 50%, paid to one receiver. Leave the receiver empty for the owner.">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>Basis points</span>
          <input
            type="text"
            inputMode="numeric"
            value={bps}
            onChange={(e) => setBps(e.target.value.replace(/[^0-9]/g, ""))}
            className={INPUT}
          />
        </label>
        <label className="block">
          <span className={LABEL}>Royalty receiver</span>
          <input
            type="text"
            value={receiver}
            onChange={(e) => setReceiver(e.target.value)}
            placeholder="0x… (default: owner)"
            spellCheck={false}
            className={INPUT}
          />
        </label>
      </div>
      {!parsed.ok && <p className={ERROR}>{parsed.error}</p>}
      <button
        type="button"
        disabled={!enabled || !parsed.ok || !changed || w.busy}
        onClick={() => parsed.ok && w.run({ address: state.collection, abi: TOKEN_ABI, functionName: "setRoyalty", args: parsed.args })}
        className={BTN}
      >
        {w.label ?? "Set royalty"}
      </button>
      <WriteError error={w.error} action="Set royalty" />
    </Section>
  )
}

function MinterSection({ state, enabled, onDone }: SectionProps) {
  const [next, setNext] = useState("")
  const w = useV2Write(onDone)
  const trimmed = next.trim()
  const valid = isAddress(trimmed)
  const { data: code } = useBytecode({ address: valid ? (trimmed as Address) : undefined, query: { enabled: valid } })
  const isZero = valid && /^0x0{40}$/i.test(trimmed)
  return (
    <Section
      title="Minter"
      help="A v2 collection has one minter slot: the only address that can mint. Launch sets it to the collection's fixed-price sale. Pointing it anywhere else stops that sale from minting; the zero address stops all minting."
    >
      <label className="block">
        <span className={LABEL}>New minter</span>
        <input
          type="text"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="0x… minter (0x000…000 = nobody)"
          spellCheck={false}
          className={INPUT}
        />
      </label>
      {valid && !isZero && code !== undefined && (code === "0x" || !code) && (
        <p className={HELP}>
          This address has no contract code: a wallet as minter can mint directly, outside any sale rules.
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!enabled || !valid || w.busy}
          onClick={() => w.run({ address: state.collection, abi: TOKEN_ABI, functionName: "setMinter", args: [trimmed as Address] })}
          className={BTN_SECONDARY}
        >
          {w.label ?? "Set minter"}
        </button>
      </div>
      <WriteError error={w.error} action="Set minter" />
    </Section>
  )
}
