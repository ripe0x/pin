"use client"

import { useContractInfo } from "./useContractInfo"
import { useTokenInfo } from "./useTokenInfo"

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

/**
 * Inline name + short-address label for a contract row. Renders just
 * the short address while the lookup is in flight; falls back to short
 * address if name resolution fails. Per the registry's no-semantic-
 * checks rule, the name is purely informational.
 *
 * Each instance triggers its own `/api/contract-info` fetch; the route
 * is server-cached (1h pgCache + L1) and returns `Cache-Control:
 * private, max-age=60`, so duplicate addresses across the page dedupe
 * in the browser's HTTP cache. No raw on-chain fan-out from the list.
 */
export function ContractLabel({ address }: { address: string }) {
  const { data } = useContractInfo(address)
  const name = data?.name ?? null
  return (
    <div className="min-w-0 space-y-0.5">
      {name ? (
        <div className="text-sm font-medium truncate">{name}</div>
      ) : null}
      <div className="font-mono text-xs text-gray-500">
        {shortAddr(address)}
      </div>
    </div>
  )
}

/**
 * Token row label: contract name + token name + #id. Reuses the
 * `/api/contract-info` and `/api/meta` routes — both server-cached.
 * Falls back gracefully when either lookup hasn't resolved.
 */
export function TokenLabel({
  contractAddress,
  tokenId,
  thumbnail = true,
}: {
  contractAddress: string
  tokenId: string
  thumbnail?: boolean
}) {
  const { data: contractInfo } = useContractInfo(contractAddress)
  const { data: tokenInfo } = useTokenInfo(contractAddress, tokenId)

  const contractName = contractInfo?.name ?? null
  const tokenName = tokenInfo?.name ?? null
  const image = tokenInfo?.image ?? null

  return (
    <div className="flex items-center gap-3 min-w-0">
      {thumbnail && (
        image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={tokenName ?? `Token #${tokenId}`}
            className="h-10 w-10 rounded-md object-cover bg-gray-100 shrink-0"
          />
        ) : (
          <div className="h-10 w-10 rounded-md bg-gray-100 shrink-0" />
        )
      )}
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium truncate">
          {tokenName ?? `Token #${tokenId}`}
        </div>
        <div className="font-mono text-xs text-gray-500 truncate">
          {contractName ? `${contractName} · ` : ""}
          {shortAddr(contractAddress)} · #{tokenId}
        </div>
      </div>
    </div>
  )
}
