import type { Abi, Address, Hex } from "viem"
import type { ProviderResult } from "@pin/release-spec"
import type { BuildOptions, ContentResolver, TokenData, WorkInput } from "./render/types.ts"

export type ReleaseRef = {
  chainId: number
  collection: Address
  protocol: "surface@1"
  factory?: Address
}

export type ValidatedRelease = ReleaseRef & {
  idMode: IdMode
  owner: Address
  renderer: Address
  primaryMinter: Address | null
  validatedAtBlock: bigint
}

export const SurfaceStatus = { Scheduled: 0, Open: 1, Closed: 2 } as const
export type SurfaceStatus = (typeof SurfaceStatus)[keyof typeof SurfaceStatus]

export const IdMode = { Sequential: 0, Pooled: 1 } as const
export type IdMode = (typeof IdMode)[keyof typeof IdMode]

export type SaleWindow = {
  mintStart: bigint
  mintEnd: bigint
  supplyCap: bigint
}

export type ReleaseState = {
  release: ValidatedRelease
  account?: Address
  minted: bigint
  supplyCap: bigint
  saleMinted?: bigint
  saleSupplyCap?: bigint
  mintStart: bigint
  mintEnd: bigint
  price: bigint
  priceStrategy: Address
  allowlistRoot?: Hex
  walletCap?: bigint
  mintedByAccount?: bigint
  referralShareBps?: number
  lifecycle: SurfaceStatus
  blockNumber: bigint
}

export type MintQuoteInput = {
  release: ValidatedRelease
  account?: Address
  quantity: bigint
  referrer: Address
  selection?: unknown
}

export type MintQuote = {
  quantity: bigint
  unitPrice: bigint
  totalValue: bigint
  referrer: Address
  quotedAtBlock: bigint
  expiresAfterBlock?: bigint
}

export type PreparedTransaction = {
  chainId: number
  target: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value: bigint
  effects: string[]
}

export type PrepareMintInput = MintQuoteInput & {
  quote: MintQuote
}

export type TokenReadInput = {
  release: ValidatedRelease
  tokenId: bigint
}

export type TokenState = {
  tokenId: bigint
  owner: Address | null
  seed: Hex | null
  tokenUri: string | null
  blockNumber: bigint
}

export type RenderInput = {
  work: WorkInput
  tokenData: TokenData
  resolver: ContentResolver
  options: BuildOptions
}

export type RenderDocument = {
  mediaType: "text/html"
  document: string
}

export type RevealSource =
  | { kind: "transfer-log" }
  | { kind: "event"; abiEvent: string }

export type RevealLog = {
  address: string
  topics: readonly Hex[]
  data: Hex
}

export type RevealInput = {
  source: RevealSource
  logs: readonly RevealLog[]
  collection: Address
  abi: Abi
  minter?: Address
}

export type RevealResult = {
  tokenId: bigint | null
}

export interface CoreReleaseProvider {
  validateRelease(ref: ReleaseRef, signal?: AbortSignal): Promise<ProviderResult<ValidatedRelease>>
  readState(release: ValidatedRelease, account?: Address, signal?: AbortSignal): Promise<ProviderResult<ReleaseState>>
  quoteMint(input: MintQuoteInput, signal?: AbortSignal): Promise<ProviderResult<MintQuote>>
  prepareMint(input: PrepareMintInput, signal?: AbortSignal): Promise<ProviderResult<PreparedTransaction>>
  readToken(input: TokenReadInput, signal?: AbortSignal): Promise<ProviderResult<TokenState>>
  prepareRender(input: RenderInput, signal?: AbortSignal): Promise<ProviderResult<RenderDocument>>
  resolveReveal(input: RevealInput, signal?: AbortSignal): Promise<ProviderResult<RevealResult>>
}

export type HistoryPageInput = {
  release: ValidatedRelease
  cursor?: string
  limit: number
}

export type HistoryPage<T> = {
  items: T[]
  nextCursor: string | null
}

export type MintRecord = { txHash: Hex; blockNumber: bigint; tokenId?: bigint; quantity: bigint; recipient: Address }
export type SaleRecord = { txHash: Hex; blockNumber: bigint; tokenId: bigint; seller: Address; buyer: Address; amount: bigint }
export type BidRecord = { txHash: Hex; blockNumber: bigint; tokenId: bigint; bidder: Address; amount: bigint }
export type OwnershipInput = { release: ValidatedRelease; tokenId: bigint }
export type OwnershipRecord = { tokenId: bigint; owner: Address | null; observedAtBlock: bigint }

export interface ReleaseHistoryProvider {
  listMints(input: HistoryPageInput): Promise<ProviderResult<HistoryPage<MintRecord>>>
  listSales(input: HistoryPageInput): Promise<ProviderResult<HistoryPage<SaleRecord>>>
  listBids(input: HistoryPageInput): Promise<ProviderResult<HistoryPage<BidRecord>>>
  listOwnership(input: OwnershipInput): Promise<ProviderResult<OwnershipRecord>>
}

export type PortableIdentity = { address: Address; name?: string; avatarUrl?: string; profileUrl?: string }
export interface IdentityProvider {
  resolve(address: Address): Promise<ProviderResult<PortableIdentity>>
}

export type ResolvedMedia = {
  canonicalUri: string
  preparedUrl?: string
  mediaType?: string
  width?: number
  height?: number
  sha256?: string
  expiresAt?: string
}

export interface MediaProvider {
  resolve(ref: import("@pin/release-spec").PortableMediaRef): Promise<ProviderResult<ResolvedMedia>>
}
