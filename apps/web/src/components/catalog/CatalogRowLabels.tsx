"use client"

import { useContractInfo } from "./useContractInfo"
import { useTokenInfo } from "./useTokenInfo"
import { useOptimizedImage } from "@/lib/use-optimized-image"

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function TokenThumbnail({ src, alt }: { src: string; alt: string }) {
  const { src: mediaSrc, onError, ref, failed } = useOptimizedImage(src, 96)
  if (failed) {
    return <div className="h-10 w-10 rounded-md bg-gray-100 shrink-0" />
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={mediaSrc}
      alt={alt}
      className="h-10 w-10 rounded-md object-cover bg-gray-100 shrink-0"
      loading="lazy"
      onError={onError}
    />
  )
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
    <div className="min-w-0 space-y-0.5 flex-1">
      {name ? (
        <p className="text-sm font-medium truncate">{name}</p>
      ) : null}
      <a
        href={`https://evm.now/address/${address}`}
        target="_blank"
        rel="noopener noreferrer"
        className="block font-mono text-xs text-gray-500 underline-offset-2 hover:underline truncate"
      >
        {address}
      </a>
    </div>
  )
}

/**
 * Right-side "1,139 tokens" badge for a contract row, fed by the same
 * `/api/contract-info` totalSupply field surfaced in the import
 * planner. Renders nothing when totalSupply isn't known (older
 * contracts that don't implement the ERC-721 enumerable extension) so
 * the row just shows name + address with no count rather than a
 * misleading zero.
 */
export function ContractTotalSupplyBadge({ address }: { address: string }) {
  const { data } = useContractInfo(address)
  const raw = data?.totalSupply
  if (!raw) return null
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return (
    <span className="shrink-0 text-xs text-gray-500 tabular-nums">
      {n.toLocaleString()} {n === 1 ? "token" : "tokens"}
    </span>
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
      {thumbnail &&
        (image ? (
          <TokenThumbnail
            src={image}
            alt={tokenName ?? `Token #${tokenId}`}
          />
        ) : (
          <div className="h-10 w-10 rounded-md bg-gray-100 shrink-0" />
        ))}
      <div className="min-w-0 space-y-0.5">
        <a
          href={`https://evm.now/address/${contractAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-sm font-medium truncate underline-offset-2 hover:underline"
        >
          {tokenName ?? `Token #${tokenId}`}
        </a>
        <a
          href={`https://evm.now/address/${contractAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="block font-mono text-xs text-gray-500 truncate underline-offset-2 hover:underline"
        >
          {contractName ? `${contractName} · ` : ""}
          {shortAddr(contractAddress)} · #{tokenId}
        </a>
      </div>
    </div>
  )
}
