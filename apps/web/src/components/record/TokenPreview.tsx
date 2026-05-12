"use client"

import { useTokenInfo } from "./useTokenInfo"

/**
 * Single-token preview card. Renders nothing when the inputs are
 * incomplete or the contract/token isn't an NFT we can resolve.
 *
 * The /api/meta route returns the parsed metadata + a CDN-resolved
 * mediaUri (IPFS gateway, etc.) — we render a small thumb plus name.
 */
export function TokenPreview({
  contract,
  tokenId,
}: {
  contract: string
  tokenId: string | null
}) {
  const { data, isLoading } = useTokenInfo(contract, tokenId)

  if (!tokenId || tokenId.trim() === "" || !contract.trim()) return null

  if (isLoading) {
    return (
      <div className="border border-gray-200 rounded-md p-3 text-xs text-gray-500 animate-pulse">
        Looking up token #{tokenId}...
      </div>
    )
  }

  if (!data) {
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-md p-3 text-xs text-amber-800">
        Token #{tokenId} not found on this contract. You can still
        declare it.
      </div>
    )
  }

  return (
    <div className="border border-gray-200 rounded-md p-3 flex items-center gap-3">
      {data.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.image}
          alt={data.name ?? `Token #${tokenId}`}
          className="h-12 w-12 rounded-md object-cover bg-gray-100 shrink-0"
        />
      ) : (
        <div className="h-12 w-12 rounded-md bg-gray-100 shrink-0" />
      )}
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium truncate">
          {data.name ?? `Token #${tokenId}`}
        </div>
        <div className="text-xs text-gray-500">Token #{tokenId}</div>
      </div>
    </div>
  )
}
