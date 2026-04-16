import { ponderQuery } from "./ponder"
import { ipfsToHttp } from "@pin/shared"

// ─── Types matching Ponder schema ─────────────────────────────────────────────

type PonderToken = {
  id: string
  chainId: number
  contract: string
  tokenId: string
  creator: string | null
  owner: string | null
  tokenUri: string | null
  metadata: {
    name?: string
    description?: string
    image?: string
  } | null
  mediaUri: string | null
  createdAt: string | null
}

type PonderAuction = {
  id: string
  chainId: number
  contract: string
  tokenId: string
  seller: string
  reservePrice: string
  highestBid: string
  highestBidder: string | null
  endTime: string
  status: string
  txCreate: string | null
  txFinalize: string | null
}

type PonderListing = {
  id: string
  chainId: number
  contract: string
  tokenId: string
  kind: string
  seller: string
  price: string
  status: string
  createdAt: string
}

type PonderBid = {
  id: string
  auctionId: string
  bidder: string
  amount: string
  blockNumber: string
  logIndex: number
  txHash: string
  blockTime: string
}

type PonderTransfer = {
  id: string
  contract: string
  tokenId: string
  from: string
  to: string
  blockTime: string
  txHash: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveImageUrl(token: PonderToken): string {
  if (token.mediaUri) return ipfsToHttp(token.mediaUri)
  if (token.metadata?.image) return ipfsToHttp(token.metadata.image)
  return "https://placehold.co/800x1000/F2F2F2/999999?text=NFT"
}

// ─── Token page queries ───────────────────────────────────────────────────────

export async function getTokenPageData(contract: string, tokenId: string) {
  const data = await ponderQuery<{
    tokenss: { items: PonderToken[] }
    auctionss: { items: PonderAuction[] }
    listingss: { items: PonderListing[] }
    bidss: { items: PonderBid[] }
    transferss: { items: PonderTransfer[] }
  }>(`
    query TokenPage($contract: String!, $tokenId: BigInt!) {
      tokenss(where: { contract: $contract, tokenId: $tokenId }, limit: 1) {
        items {
          id chainId contract tokenId creator owner tokenUri metadata mediaUri createdAt
        }
      }
      auctionss(
        where: { contract: $contract, tokenId: $tokenId, status: "active" }
        limit: 1
      ) {
        items {
          id chainId contract tokenId seller reservePrice
          highestBid highestBidder endTime status txCreate txFinalize
        }
      }
      listingss(
        where: { contract: $contract, tokenId: $tokenId, status: "active" }
        limit: 1
      ) {
        items {
          id chainId contract tokenId kind seller price status createdAt
        }
      }
      bidss(
        where: { auctionId_in: [] }
        orderBy: "blockTime"
        orderDirection: "desc"
        limit: 50
      ) {
        items {
          id auctionId bidder amount blockNumber logIndex txHash blockTime
        }
      }
      transferss(
        where: { contract: $contract, tokenId: $tokenId }
        orderBy: "blockTime"
        orderDirection: "desc"
        limit: 20
      ) {
        items {
          id contract tokenId from to blockTime txHash
        }
      }
    }
  `, { contract, tokenId })

  const token = data.tokenss.items[0]
  if (!token) return null

  return {
    token,
    transfers: data.transferss.items,
    imageUrl: resolveImageUrl(token),
  }
}
