/**
 * Tiny presentational helpers for transaction + address feedback. Etherscan
 * links resolve on real mainnet; on a local fork they return 404 but the hash
 * is still useful for debugging the local chain via `cast tx <hash>`.
 */

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function TxLink({
  hash,
  label = "View transaction",
}: {
  hash: `0x${string}`
  label?: string
}) {
  return (
    <a
      href={`https://etherscan.io/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-baseline gap-1 text-xs text-gray-600 hover:text-black underline-offset-2 hover:underline"
    >
      <span>{label}</span>
      <span className="font-mono text-gray-400">{shortHash(hash)}</span>
      <span aria-hidden>↗</span>
    </a>
  )
}

export function AddressLink({
  address,
  label,
}: {
  address: string
  label: string
}) {
  return (
    <a
      href={`https://etherscan.io/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-baseline gap-1 text-xs text-gray-600 hover:text-black underline-offset-2 hover:underline"
    >
      <span>{label}</span>
      <span className="font-mono text-gray-400">{shortAddress(address)}</span>
      <span aria-hidden>↗</span>
    </a>
  )
}
