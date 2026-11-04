/**
 * Chain reads for a Surface collection and its sale. Client-safe: takes any
 * viem public client, so the server's cached read (lib/collection.ts), the
 * mint card's live refresh (components/CollectionMintCard.tsx) and a local
 * test script all run the exact same detection.
 *
 * Read budget per call: two multicalls (one eth_call each on mainnet).
 *   1. token: name, symbol, version, owner, minter (v2), primaryMinter +
 *      idMode (v1). The v1 and v2 `config()` share a selector but not a
 *      return shape, so it waits for `version()`.
 *   2. token `config()` decoded with the right ABI, plus every sale getter
 *      the mint card needs, against the minter address from step 1.
 * Nothing here scans logs.
 */
import { getAddress, type Abi, type Address, type PublicClient } from "viem"
import {
  fixedPriceMinterAbi,
  fixedPriceSaleAbi,
  surfaceAbi,
  surfaceTokenV2Abi,
} from "./abi"
import {
  V2_IMINTER_INTERFACE_ID,
  V2_REFERRAL_SHARE_BPS,
  ZERO_ADDRESS,
  ZERO_ROOT,
  type CollectionSummary,
  type SaleState,
} from "./surface"

export type ReadClient = Pick<PublicClient, "multicall" | "readContract">

type Res = { status: "success"; result: unknown } | { status: "failure"; error: Error }
type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }

/** One allowFailure multicall over heterogenous calls. The per-call result
 *  types are recovered by `ok<T>()` at each index, which keeps the
 *  conditional sale-call lists below readable. */
async function multi(client: ReadClient, calls: Call[]): Promise<Res[]> {
  return (await client.multicall({ allowFailure: true, contracts: calls as never })) as Res[]
}

function ok<T>(r: Res | undefined): T | undefined {
  return r && r.status === "success" ? (r.result as T) : undefined
}

function sameAddress(a: string | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase()
}

function nonZero(a: Address | undefined): Address | null {
  return a && a.toLowerCase() !== ZERO_ADDRESS ? getAddress(a) : null
}

/** v1 IdMode.Sequential. PooledSurface reports 1 (Pooled). */
const ID_MODE_SEQUENTIAL = 0

/**
 * Reads the collection and, when it has one, its canonical sale. Returns null
 * only when the address does not answer as an ERC-721 at all (no name()).
 * A collection the template cannot mint through still returns a summary,
 * with `sale: null`, so the page can render it read-only.
 */
export async function readCollectionSummary(
  client: ReadClient,
  address: Address,
): Promise<CollectionSummary | null> {
  const t1 = { address, abi: surfaceTokenV2Abi as Abi }
  const v1 = { address, abi: surfaceAbi as Abi }
  const r1 = await multi(client, [
      { ...t1, functionName: "name" },
      { ...t1, functionName: "symbol" },
      { ...t1, functionName: "version" },
      { ...t1, functionName: "owner" },
      { ...t1, functionName: "minter" },
      { ...v1, functionName: "primaryMinter" },
      { ...v1, functionName: "idMode" },
  ])

  const name = ok<string>(r1[0])
  if (name === undefined) return null
  const symbol = ok<string>(r1[1]) ?? ""
  const rawVersion = ok<bigint>(r1[2])
  const protocolVersion = rawVersion === 1n ? 1 : rawVersion === 2n ? 2 : 0
  const owner = ok<Address>(r1[3]) ?? ZERO_ADDRESS
  const base: CollectionSummary = {
    address,
    name,
    symbol,
    protocolVersion,
    owner,
    supplyCap: 0n,
    minted: 0n,
    sequential: false,
    minter: null,
    sale: null,
  }
  if (protocolVersion === 0) return base

  if (protocolVersion === 2) {
    const minter = nonZero(ok<Address>(r1[4]))
    const s = minter ? { address: minter, abi: fixedPriceSaleAbi as Abi } : null
    const r2 = await multi(client, [
        { ...t1, functionName: "config" },
        ...(s
          ? ([
              { ...s, functionName: "version" },
              { ...s, functionName: "supportsInterface", args: [V2_IMINTER_INTERFACE_ID] },
              { ...s, functionName: "collection" },
              { ...s, functionName: "price" },
              { ...s, functionName: "mintStart" },
              { ...s, functionName: "mintEnd" },
              { ...s, functionName: "maxMints" },
              { ...s, functionName: "walletCap" },
              { ...s, functionName: "gate" },
              { ...s, functionName: "closed" },
              { ...s, functionName: "totalMinted" },
              { ...s, functionName: "payoutRecipient" },
            ] satisfies Call[])
          : []),
    ])
    const cfg = ok<readonly [Address, Address, bigint, number, Address, bigint]>(r2[0])
    const summary: CollectionSummary = {
      ...base,
      supplyCap: cfg?.[2] ?? 0n,
      minted: cfg?.[5] ?? 0n,
      // v2 ids are mint order by construction (no pooled mode).
      sequential: true,
      minter,
    }
    if (!minter) return summary
    const isSale =
      ok<bigint>(r2[1]) === 2n && ok<boolean>(r2[2]) === true && sameAddress(ok<Address>(r2[3]), address)
    const price = ok<bigint>(r2[4])
    const mintStart = ok<bigint>(r2[5])
    const mintEnd = ok<bigint>(r2[6])
    const maxMints = ok<bigint>(r2[7])
    const walletCap = ok<bigint>(r2[8])
    const gate = ok<Address>(r2[9])
    const closed = ok<boolean>(r2[10])
    const totalMinted = ok<bigint>(r2[11])
    const payoutRecipient = ok<Address>(r2[12])
    if (
      !isSale ||
      price === undefined ||
      mintStart === undefined ||
      mintEnd === undefined ||
      maxMints === undefined ||
      walletCap === undefined ||
      gate === undefined ||
      closed === undefined ||
      totalMinted === undefined ||
      payoutRecipient === undefined
    ) {
      return summary
    }
    const sale: SaleState = {
      kind: "v2-fixed-price",
      address: minter,
      price,
      quote1: price,
      priceStrategy: null,
      mintStart: BigInt(mintStart),
      mintEnd: BigInt(mintEnd),
      maxMints,
      totalMinted,
      walletCap,
      gated: gate.toLowerCase() !== ZERO_ADDRESS,
      closed,
      referralShareBps: V2_REFERRAL_SHARE_BPS,
      payoutRecipient,
    }
    return { ...summary, sale }
  }

  // protocolVersion === 1
  const minter = nonZero(ok<Address>(r1[5]))
  const idMode = ok<number>(r1[6])
  const m = minter ? { address: minter, abi: fixedPriceMinterAbi as Abi } : null
  const r2 = await multi(client, [
      { ...v1, functionName: "config" },
      ...(m
        ? ([
            { ...m, functionName: "collection" },
            { ...m, functionName: "price" },
            { ...m, functionName: "priceStrategy" },
            { ...m, functionName: "mintStart" },
            { ...m, functionName: "mintEnd" },
            { ...m, functionName: "maxMints" },
            { ...m, functionName: "totalMinted" },
            { ...m, functionName: "walletCap" },
            { ...m, functionName: "allowlistRoot" },
            { ...m, functionName: "referralShareBps" },
            { ...m, functionName: "payoutRecipient" },
            { ...m, functionName: "priceOf", args: [ZERO_ADDRESS, 1n] },
          ] satisfies Call[])
        : []),
  ])
  const cfg = ok<readonly [{ supplyCap: bigint }, bigint]>(r2[0])
  const summary: CollectionSummary = {
    ...base,
    supplyCap: cfg?.[0].supplyCap ?? 0n,
    minted: cfg?.[1] ?? 0n,
    sequential: idMode !== undefined && Number(idMode) === ID_MODE_SEQUENTIAL,
    minter,
  }
  if (!minter) return summary
  const collection = ok<Address>(r2[1])
  const price = ok<bigint>(r2[2])
  const priceStrategy = ok<Address>(r2[3])
  const mintStart = ok<bigint>(r2[4])
  const mintEnd = ok<bigint>(r2[5])
  const maxMints = ok<bigint>(r2[6])
  const totalMinted = ok<bigint>(r2[7])
  const walletCap = ok<bigint>(r2[8])
  const allowlistRoot = ok<`0x${string}`>(r2[9])
  const referralShareBps = ok<number>(r2[10])
  const payoutRecipient = ok<Address>(r2[11])
  const quote1 = ok<bigint>(r2[12])
  if (
    !sameAddress(collection, address) ||
    price === undefined ||
    priceStrategy === undefined ||
    mintStart === undefined ||
    mintEnd === undefined ||
    maxMints === undefined ||
    totalMinted === undefined ||
    walletCap === undefined ||
    allowlistRoot === undefined ||
    referralShareBps === undefined ||
    payoutRecipient === undefined
  ) {
    return summary
  }
  const sale: SaleState = {
    kind: "v1-fixed-price",
    address: minter,
    price,
    // A strategy quote can fail (a strategy that rejects the zero address);
    // the stored price is the honest fallback for display only.
    quote1: quote1 ?? price,
    priceStrategy: nonZero(priceStrategy),
    mintStart: BigInt(mintStart),
    mintEnd: BigInt(mintEnd),
    maxMints,
    totalMinted,
    walletCap,
    gated: allowlistRoot.toLowerCase() !== ZERO_ROOT,
    closed: false,
    referralShareBps: Number(referralShareBps),
    payoutRecipient,
  }
  return { ...summary, sale }
}

/**
 * The exact payment for `quantity` tokens to `to`, read from the sale at
 * mint time. Both generations expose `priceOf(to, quantity)`; for v2 and a
 * fixed-price v1 it is `price * quantity`, for a v1 price strategy it is the
 * live quote (the minter accepts >= and refunds the excess as a pull balance).
 */
export async function quoteMint(
  client: ReadClient,
  sale: Pick<SaleState, "kind" | "address">,
  to: Address,
  quantity: bigint,
): Promise<bigint> {
  if (sale.kind === "v2-fixed-price") {
    return client.readContract({
      address: sale.address,
      abi: fixedPriceSaleAbi,
      functionName: "priceOf",
      args: [to, quantity],
    })
  }
  return client.readContract({
    address: sale.address,
    abi: fixedPriceMinterAbi,
    functionName: "priceOf",
    args: [to, quantity],
  })
}

/** Tokens already minted to `wallet` through this sale (for the wallet cap). */
export async function readMintedBy(
  client: ReadClient,
  sale: Pick<SaleState, "kind" | "address">,
  wallet: Address,
): Promise<bigint> {
  if (sale.kind === "v2-fixed-price") {
    return client.readContract({
      address: sale.address,
      abi: fixedPriceSaleAbi,
      functionName: "mintedBy",
      args: [wallet],
    })
  }
  return client.readContract({
    address: sale.address,
    abi: fixedPriceMinterAbi,
    functionName: "mintedBy",
    args: [wallet],
  })
}
