"use client"

// Claim + redeem pickers for homage — ported from the homage repo's useHomageMint.ts,
// parameterized by the detected {minter, collection} instead of module-level env consts.
//
//   useOwnedPunks  — the connected wallet's CLAIMABLE punks (held directly or via
//                    delegate.xyz), filtered to unminted homages. Mirrors HomageMinter
//                    ._isPunkHolder for both raw + wrapped ownership.
//   useOwnedHomages — the connected wallet's owned homage NFTs (for redeem).

import {useEffect, useState} from "react"
import {type Address, zeroHash} from "viem"
import {usePublicClient} from "wagmi"
import {PREFERRED_CHAIN} from "@/components/tx/tx-ui"
import {
  CRYPTOPUNKS_MARKET,
  DELEGATE_REGISTRY,
  HAS_WRAPPED_PUNKS,
  WRAPPED_PUNKS,
  WRAPPED_PUNKS_721,
  delegateRegistryAbi,
  homageCollectionAbi,
  homageMinterAbi,
  punksMarketAbi,
  wrappedPunksAbi,
} from "./contracts"

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const SEPOLIA_MODE = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"
const SCAN_WINDOW = 9_000n
const MAX_DELEGATION_VAULTS = 4
// The /api/owned-punks proxy only knows mainnet punk state (see the route's
// comment) — the sepolia/fork test instances run a mock punks market the
// upstream API has never heard of, so raw-punk discovery there stays on the
// log scan.
const USE_OWNED_PUNKS_API = !FORK_MODE && !SEPOLIA_MODE

// ── test state ────────────────────────────────────────────────────────────────
// `?testPunks=1` fills the claim picker with stand-in punks so the holder UI can be
// seen without holding one: a raw punk, a wrapped punk, and one reached through a
// delegate.xyz vault, which is every row variant the list can draw. Discovery only,
// so the rows render and the buttons enable, but any mint still goes to the contract
// and reverts for a wallet that does not hold the punk. Refused on mainnet: it exists
// for the test instances, and inventing holdings on the live mint would be a lie about
// what a wallet owns.
const TEST_PUNKS_ALLOWED = SEPOLIA_MODE || FORK_MODE
const TEST_PUNKS: PunkPick[] = [
  {id: 1234, wrapped: false, minted: false},
  {id: 5678, wrapped: true, minted: false},
  {id: 9012, wrapped: false, vault: "0x1234567890AbcdEF1234567890aBcdef12345678", minted: false},
  // One already minted, so the "already minted, view" row shows up alongside the
  // claimable ones rather than only appearing once someone mints for real.
  {id: 3456, wrapped: false, minted: true},
]

function testPunksRequested(): boolean {
  if (!TEST_PUNKS_ALLOWED || typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).get("testPunks") === "1"
}

export type OwnedStatus = "idle" | "loading" | "ok" | "partial" | "error"
export type PunkPick = {id: number; wrapped: boolean; vault?: Address; minted: boolean}

type Client = NonNullable<ReturnType<typeof usePublicClient>>

/** Raw punk candidates for `who` from the /api/owned-punks proxy (mainnet only).
 *  Returns null on a soft-fail (bad status, `ok: false`, network error, non-mainnet
 *  mode) so the caller falls back to the log scan. */
async function fetchApiRawCandidates(who: Address): Promise<Set<bigint> | null> {
  if (!USE_OWNED_PUNKS_API) return null
  try {
    const res = await fetch(`/api/owned-punks/${who}`)
    if (!res.ok) return null
    const body = (await res.json()) as {ok?: boolean; punks?: Array<{index: number; wrapped?: boolean}>}
    if (!body.ok) return null
    const ids = new Set<bigint>()
    for (const p of body.punks ?? []) if (!p.wrapped) ids.add(BigInt(p.index))
    return ids
  } catch {
    return null
  }
}

/** Wrapped punks (enumerable, exact) + raw punks (held by `who`). Raw candidates come
 *  from the /api/owned-punks proxy on mainnet, falling back to an acquisition-event log
 *  scan when the proxy is unavailable or unusable (sepolia/fork). Either source is then
 *  confirmed against live ownership via punkIndexToAddress before being reported held.
 *  Returns id -> wrapped. `rawFailed` marks a log-scan error; `usedFallback` marks that
 *  the log scan (bounded by `getFromBlock`'s window) ran instead of the proxy. */
async function scanWalletPunks(
  client: Client,
  who: Address,
  getFromBlock: () => Promise<bigint>,
): Promise<{held: Map<number, boolean>; rawFailed: boolean; usedFallback: boolean}> {
  // ── wrapped punks: enumerable, exact ── (skipped on sepolia — no deployment, see HAS_WRAPPED_PUNKS)
  const wBal = HAS_WRAPPED_PUNKS
    ? ((await client.readContract({
        address: WRAPPED_PUNKS,
        abi: wrappedPunksAbi,
        functionName: "balanceOf",
        args: [who],
      })) as bigint)
    : 0n
  const wIds: bigint[] = []
  if (wBal > 0n) {
    const idxReads = await client.multicall({
      contracts: Array.from(
        {length: Number(wBal)},
        (_, i) =>
          ({address: WRAPPED_PUNKS, abi: wrappedPunksAbi, functionName: "tokenOfOwnerByIndex", args: [who, BigInt(i)]}) as const,
      ),
      allowFailure: true,
    })
    for (const r of idxReads) if (r.status === "success") wIds.push(r.result as bigint)
  }

  // ── raw punks: /api/owned-punks first (complete, mainnet only), falling back to an
  // acquisition-event log scan (bounded to SCAN_WINDOW) when the proxy is unavailable ──
  let rawFailed = false
  let usedFallback = false
  let rawCandidates = await fetchApiRawCandidates(who)
  if (!rawCandidates) {
    usedFallback = true
    rawCandidates = new Set<bigint>()
    try {
      const fromBlock = await getFromBlock()
      const [assigns, xfers, boughts] = await Promise.all([
        client.getContractEvents({address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, eventName: "Assign", args: {to: who}, fromBlock, toBlock: "latest"}),
        client.getContractEvents({address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, eventName: "PunkTransfer", args: {to: who}, fromBlock, toBlock: "latest"}),
        client.getContractEvents({address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, eventName: "PunkBought", args: {toAddress: who}, fromBlock, toBlock: "latest"}),
      ])
      for (const l of assigns) {const v = (l.args as {punkIndex?: bigint}).punkIndex; if (v !== undefined) rawCandidates.add(v)}
      for (const l of xfers) {const v = (l.args as {punkIndex?: bigint}).punkIndex; if (v !== undefined) rawCandidates.add(v)}
      for (const l of boughts) {const v = (l.args as {punkIndex?: bigint}).punkIndex; if (v !== undefined) rawCandidates.add(v)}
    } catch {
      rawFailed = true // a log failure must not sink the wrapped enumeration
    }
  }
  const rawIds = Array.from(rawCandidates)
  const rawOwnerReads = rawIds.length
    ? await client.multicall({
        contracts: rawIds.map((id) => ({address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, functionName: "punkIndexToAddress", args: [id]}) as const),
        allowFailure: true,
      })
    : []
  const confirmedRaw = rawIds.filter((_, i) => {
    const r = rawOwnerReads[i]
    return r?.status === "success" && (r.result as string).toLowerCase() === who.toLowerCase()
  })

  const held = new Map<number, boolean>() // id -> wrapped
  for (const id of wIds) held.set(Number(id), true)
  for (const id of confirmedRaw) if (!held.has(Number(id))) held.set(Number(id), false)
  return {held, rawFailed, usedFallback}
}

/** Incoming delegate.xyz delegations relevant to punk claims: vaults that delegated `who`
 *  wallet-wide or for a punk contract, and token-level (id, vault) candidates. Rights-scoped
 *  delegations are skipped — HomageMinter.claimFor checks empty rights. */
async function claimDelegations(
  client: Client,
  who: Address,
): Promise<{vaults: Address[]; tokens: {id: bigint; vault: Address}[]}> {
  const raw = (await client.readContract({
    address: DELEGATE_REGISTRY,
    abi: delegateRegistryAbi,
    functionName: "getIncomingDelegations",
    args: [who],
  })) as readonly {type_: number; from: Address; rights: `0x${string}`; contract_: Address; tokenId: bigint}[]
  const isPunkSource = (c: string) =>
    c.toLowerCase() === CRYPTOPUNKS_MARKET.toLowerCase() ||
    c.toLowerCase() === WRAPPED_PUNKS.toLowerCase() ||
    c.toLowerCase() === WRAPPED_PUNKS_721.toLowerCase()
  const vaults = new Set<Address>()
  const tokens: {id: bigint; vault: Address}[] = []
  for (const d of raw) {
    if (d.rights !== zeroHash) continue
    // DelegationType: 1 = ALL, 2 = CONTRACT, 3 = ERC721
    if (d.type_ === 1 || (d.type_ === 2 && isPunkSource(d.contract_))) vaults.add(d.from)
    else if (d.type_ === 3 && isPunkSource(d.contract_) && d.tokenId <= 9_999n) tokens.push({id: d.tokenId, vault: d.from})
  }
  return {vaults: Array.from(vaults).slice(0, MAX_DELEGATION_VAULTS), tokens}
}

async function scanFromBlock(client: Client): Promise<{fromBlock: bigint; partialBase: boolean}> {
  const latest = await client.getBlockNumber()
  let fromBlock = latest > SCAN_WINDOW ? latest - SCAN_WINDOW : 0n
  if (fromBlock > latest) fromBlock = 0n
  // On mainnet the recent-window scan misses older acquisitions → always partial; on the
  // fork the homage was just deployed, so the window covers everything relevant.
  return {fromBlock, partialBase: !FORK_MODE}
}

/** Memoized fromBlock for the log-scan fallback, computed on first use so a getBlockNumber
 *  call is only made when the /api/owned-punks proxy actually fails and the fallback runs. */
function makeFromBlockGetter(client: Client): () => Promise<bigint> {
  let cached: Promise<bigint> | undefined
  return () => {
    if (!cached) {
      cached = (async () => {
        const latest = await client.getBlockNumber()
        let fromBlock = latest > SCAN_WINDOW ? latest - SCAN_WINDOW : 0n
        if (fromBlock > latest) fromBlock = 0n
        return fromBlock
      })()
    }
    return cached
  }
}

/** Whether a scan that used the log-scan fallback should be reported partial: the
 *  bounded window misses older acquisitions on a live chain; on the fork the homage
 *  was just deployed, so the window covers everything relevant. */
function fallbackIsPartial(): boolean {
  return !FORK_MODE
}

/** The connected wallet's claimable punks — held directly or via delegation — filtered to
 *  unminted homages (tokenId == punkId). Mirrors HomageMinter claim eligibility. */
export function useOwnedPunks(minter: Address, address?: Address, refreshKey?: number): {punks: PunkPick[]; status: OwnedStatus} {
  const client = usePublicClient({chainId: PREFERRED_CHAIN.id})
  const [state, setState] = useState<{punks: PunkPick[]; status: OwnedStatus}>({punks: [], status: "idle"})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!client || !address) {
        setState({punks: [], status: "idle"})
        return
      }
      if (testPunksRequested()) {
        setState({punks: TEST_PUNKS, status: "ok"})
        return
      }
      setState((s) => ({...s, status: "loading"}))
      try {
        const getFromBlock = makeFromBlockGetter(client)
        let partial = false

        const own = await scanWalletPunks(client, address, getFromBlock)
        partial = partial || own.rawFailed || (own.usedFallback && fallbackIsPartial())
        if (cancelled) return

        const merged = new Map<number, Omit<PunkPick, "minted">>()
        for (const [id, wrapped] of own.held) merged.set(id, {id, wrapped})
        try {
          const {vaults, tokens} = await claimDelegations(client, address)
          for (const vault of vaults) {
            if (cancelled) return
            const v = await scanWalletPunks(client, vault, getFromBlock)
            partial = partial || v.rawFailed || (v.usedFallback && fallbackIsPartial())
            for (const [id, wrapped] of v.held) if (!merged.has(id)) merged.set(id, {id, wrapped, vault})
          }
          const fresh = tokens.filter((t) => !merged.has(Number(t.id)))
          if (fresh.length) {
            const owners = await client.multicall({
              contracts: fresh.map((t) => ({address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, functionName: "punkIndexToAddress", args: [t.id]}) as const),
              allowFailure: true,
            })
            const wrappedChecks = fresh.map((t, i) => ({t, raw: owners[i]?.status === "success" ? (owners[i].result as string) : undefined}))
            const wrapperOf = (raw?: string) =>
              raw?.toLowerCase() === WRAPPED_PUNKS.toLowerCase()
                ? WRAPPED_PUNKS
                : raw?.toLowerCase() === WRAPPED_PUNKS_721.toLowerCase()
                  ? WRAPPED_PUNKS_721
                  : undefined
            const needWrapped = wrappedChecks.filter((c) => wrapperOf(c.raw) !== undefined)
            const wrappedOwners = needWrapped.length
              ? await client.multicall({
                  contracts: needWrapped.map((c) => ({address: wrapperOf(c.raw)!, abi: wrappedPunksAbi, functionName: "ownerOf", args: [c.t.id]}) as const),
                  allowFailure: true,
                })
              : []
            for (const c of wrappedChecks) {
              const id = Number(c.t.id)
              if (!c.raw || merged.has(id)) continue
              if (c.raw.toLowerCase() === c.t.vault.toLowerCase()) merged.set(id, {id, wrapped: false, vault: c.t.vault})
              else if (wrapperOf(c.raw) !== undefined) {
                const wi = needWrapped.findIndex((n) => n.t === c.t)
                const wo = wrappedOwners[wi]
                if (wo?.status === "success" && (wo.result as string).toLowerCase() === c.t.vault.toLowerCase()) {
                  merged.set(id, {id, wrapped: true, vault: c.t.vault})
                }
              }
            }
          }
        } catch {
          // registry unavailable → own punks still shown; manual path checks delegation per id
        }
        if (cancelled) return

        const ids = Array.from(merged.keys())
        const mintedReads = ids.length
          ? await client.multicall({
              contracts: ids.map((id) => ({address: minter, abi: homageMinterAbi, functionName: "isMinted", args: [BigInt(id)]}) as const),
              allowFailure: true,
            })
          : []
        if (cancelled) return
        // Keep already-minted punks in the list, ANNOTATED — the claim UI shows them
        // as "already minted" instead of silently hiding them (a holder wondering why
        // their punk isn't listed is worse than a disabled row).
        const punks: PunkPick[] = ids
          .map((id, i) => {
            const r = mintedReads[i]
            return {...merged.get(id)!, minted: r?.status === "success" && r.result === true}
          })
          .sort((a, b) => Number(a.minted) - Number(b.minted) || a.id - b.id)

        setState({punks, status: partial ? "partial" : "ok"})
      } catch {
        if (!cancelled) setState({punks: [], status: "error"})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, minter, address, refreshKey])

  return state
}

/** The connected wallet's owned homage NFTs (Transfer(to=you) scan + live ownerOf), for redeem. */
export function useOwnedHomages(collection: Address, address?: Address, refreshKey?: number): {ids: number[]; status: OwnedStatus} {
  const client = usePublicClient({chainId: PREFERRED_CHAIN.id})
  const [state, setState] = useState<{ids: number[]; status: OwnedStatus}>({ids: [], status: "idle"})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!client || !address) {
        setState({ids: [], status: "idle"})
        return
      }
      setState((s) => ({...s, status: "loading"}))
      try {
        const {fromBlock, partialBase} = await scanFromBlock(client)
        const logs = await client.getContractEvents({
          address: collection,
          abi: homageCollectionAbi,
          eventName: "Transfer",
          args: {to: address},
          fromBlock,
          toBlock: "latest",
        })
        if (cancelled) return
        const candidates = Array.from(
          new Set(logs.map((l) => (l.args as {tokenId?: bigint}).tokenId).filter((x): x is bigint => x !== undefined)),
        )
        if (candidates.length === 0) {
          setState({ids: [], status: partialBase ? "partial" : "ok"})
          return
        }
        const owners = await client.multicall({
          contracts: candidates.map((id) => ({address: collection, abi: homageCollectionAbi, functionName: "ownerOf", args: [id]}) as const),
          allowFailure: true,
        })
        if (cancelled) return
        const ids = candidates
          .filter((_, i) => {
            const r = owners[i]
            return r.status === "success" && (r.result as string).toLowerCase() === address.toLowerCase()
          })
          .map(Number)
          .sort((a, b) => a - b)
        setState({ids, status: partialBase ? "partial" : "ok"})
      } catch {
        if (!cancelled) setState({ids: [], status: "error"})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, collection, address, refreshKey])

  return state
}
