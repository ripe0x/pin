/**
 * Thin server-side helpers for Alchemy's enhanced APIs.
 *
 * The standard JSON-RPC endpoint is what `viem` talks to via our `/api/rpc`
 * proxy — that path is already covered. This file is for the *enhanced* APIs
 * (`alchemy_getAssetTransfers`) and the REST NFT API (`/nft/v3/...`), which
 * are billed under a separate, much cheaper compute-unit budget than wide
 * `eth_getLogs` scans.
 *
 * Why "enhanced" matters here:
 *
 *   `eth_getLogs` over the full ~14 M-block history of a Foundation token
 *   bills like an indexer query but without the indexer; we were paying
 *   premium CUs to do work Alchemy already does for free on its NFT side.
 *   `alchemy_getAssetTransfers` returns the same data (with block
 *   timestamps included via `withMetadata: true`, eliminating the per-
 *   transfer `getBlock` round-trip) for a fraction of the cost.
 *
 * All calls in this file run server-side and authenticate with the secret
 * `ALCHEMY_API_KEY`. They never reach the client bundle.
 */

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY

const RPC_URL = ALCHEMY_API_KEY
  ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
  : null

const NFT_URL = ALCHEMY_API_KEY
  ? `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`
  : null

export type AssetTransferCategory =
  | "erc721"
  | "erc1155"
  | "erc20"
  | "external"
  | "internal"
  | "specialnft"

export type AssetTransfer = {
  blockNum: string // hex
  hash: string
  from: string
  to: string | null
  value: number | null
  asset: string | null
  category: AssetTransferCategory
  /** Present on ERC721 transfers; lowercase 0x… hex tokenId. */
  tokenId?: string | null
  /** Present on ERC1155 transfers — one entry per token id in the batch. */
  erc1155Metadata?: Array<{ tokenId: string; value: string }> | null
  /** Present when withMetadata: true. Block timestamp ISO string. */
  metadata?: { blockTimestamp: string } | null
}

type GetAssetTransfersParams = {
  fromBlock?: string // hex or "0x0"
  toBlock?: string // hex or "latest"
  fromAddress?: string
  toAddress?: string
  contractAddresses?: string[]
  category: AssetTransferCategory[]
  withMetadata?: boolean
  excludeZeroValue?: boolean
  /** Max 1000 per page; we paginate via `pageKey` if more exist. */
  maxCount?: string // hex (default 0x3e8 = 1000)
  pageKey?: string
  order?: "asc" | "desc"
}

/**
 * Fetch *all* matching asset transfers, paginating through Alchemy's
 * `pageKey` cursor. For per-token queries the result fits in one page so
 * this is usually a single HTTP call.
 *
 * Returns an empty array (not throws) on any failure — callers treat that
 * as "no history available" rather than crashing the page.
 */
export async function getAssetTransfers(
  params: GetAssetTransfersParams,
): Promise<AssetTransfer[]> {
  if (!RPC_URL) return []

  const all: AssetTransfer[] = []
  let pageKey: string | undefined = params.pageKey
  // Alchemy caps pageKey iteration; in practice we never hit this for a
  // per-token query, but guard anyway so a misuse can't loop forever.
  for (let i = 0; i < 50; i++) {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [
        {
          fromBlock: "0x0",
          toBlock: "latest",
          withMetadata: true,
          excludeZeroValue: false,
          maxCount: "0x3e8",
          ...params,
          ...(pageKey ? { pageKey } : {}),
        },
      ],
    }
    let json: { result?: { transfers: AssetTransfer[]; pageKey?: string } }
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return all
      json = (await res.json()) as typeof json
    } catch {
      return all
    }

    const transfers = json.result?.transfers ?? []
    all.push(...transfers)
    pageKey = json.result?.pageKey
    if (!pageKey) break
  }
  return all
}

export type OwnedNft = {
  contract: string
  tokenId: string
}

/**
 * Tokens currently owned by `wallet`, optionally filtered to a list of
 * contract addresses (max 45 per Alchemy NFT API). Returns the union
 * across all paginated calls. Used by collector-side adapter methods
 * (`discoverCollectorTokens`) to avoid scanning Transfer events
 * directly — the NFT API already tracks current ownership.
 *
 * `contractAddresses` is required: passing an unfiltered call back from
 * the gallery tier costs significantly more (Alchemy charges per page
 * regardless of result count), and we always have a known list of
 * contracts per platform.
 */
export async function getNFTsForOwner(
  wallet: string,
  contractAddresses: string[],
): Promise<OwnedNft[]> {
  if (!NFT_URL || contractAddresses.length === 0) return []

  // Alchemy caps contractAddresses at 45 per call. Batch if larger.
  const BATCH = 45
  const batches: string[][] = []
  for (let i = 0; i < contractAddresses.length; i += BATCH) {
    batches.push(contractAddresses.slice(i, i + BATCH))
  }

  const out: OwnedNft[] = []
  for (const batch of batches) {
    let pageKey: string | undefined
    do {
      const url = new URL(`${NFT_URL}/getNFTsForOwner`)
      url.searchParams.set("owner", wallet)
      url.searchParams.set("withMetadata", "false")
      url.searchParams.set("pageSize", "100")
      for (const c of batch) url.searchParams.append("contractAddresses[]", c)
      if (pageKey) url.searchParams.set("pageKey", pageKey)

      let json: {
        ownedNfts?: Array<{ contract: { address: string }; tokenId: string }>
        pageKey?: string
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) break
        json = (await res.json()) as typeof json
      } catch {
        break
      }
      for (const n of json.ownedNfts ?? []) {
        out.push({ contract: n.contract.address, tokenId: n.tokenId })
      }
      pageKey = json.pageKey
    } while (pageKey)
  }
  return out
}

/**
 * Unfiltered version: every NFT the wallet currently owns, across all
 * contracts. Used by Manifold's collector adapter where the universe of
 * Manifold creator-core contracts isn't known in advance — we pull the
 * wallet's full inventory and classify by supportsInterface afterward.
 *
 * Bounded by `MAX_PAGES` to prevent a whale wallet from running away
 * with cost. Each page is a separate billable NFT API call (~150 CU).
 */
export async function getAllNFTsForOwner(
  wallet: string,
  maxPages = 20,
): Promise<OwnedNft[]> {
  if (!NFT_URL) return []
  const out: OwnedNft[] = []
  let pageKey: string | undefined
  let pages = 0
  do {
    const url = new URL(`${NFT_URL}/getNFTsForOwner`)
    url.searchParams.set("owner", wallet)
    url.searchParams.set("withMetadata", "false")
    url.searchParams.set("pageSize", "100")
    if (pageKey) url.searchParams.set("pageKey", pageKey)

    let json: {
      ownedNfts?: Array<{ contract: { address: string }; tokenId: string }>
      pageKey?: string
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) break
      json = (await res.json()) as typeof json
    } catch {
      break
    }
    for (const n of json.ownedNfts ?? []) {
      out.push({ contract: n.contract.address, tokenId: n.tokenId })
    }
    pageKey = json.pageKey
    pages++
    if (pages >= maxPages && pageKey) {
      console.warn(
        `getAllNFTsForOwner: hit ${maxPages}-page cap on ${wallet}; tail truncated.`,
      )
      break
    }
  } while (pageKey)
  return out
}

export type NftOwner = {
  ownerAddress: string
  tokenBalances: Array<{ tokenId: string; balance: string }>
}

/**
 * Get every owner of a single ERC1155 token id. Cheaper and simpler than
 * replaying `TransferSingle` events to compute current balances.
 */
export async function getOwnersForNft(
  contract: string,
  tokenId: string,
): Promise<NftOwner[]> {
  if (!NFT_URL) return []
  const url = new URL(`${NFT_URL}/getOwnersForNFT`)
  url.searchParams.set("contractAddress", contract)
  url.searchParams.set("tokenId", tokenId)

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return []
    const json = (await res.json()) as { owners?: string[] }
    // The simple endpoint returns a flat owner list; we synthesize a
    // tokenBalances shape so callers don't care about the API quirk.
    return (json.owners ?? []).map((ownerAddress) => ({
      ownerAddress,
      tokenBalances: [{ tokenId, balance: "1" }],
    }))
  } catch {
    return []
  }
}
