function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function RecordSuccessorSection({
  artist,
  successorChain,
}: {
  artist: string
  successorChain: string[]
}) {
  // successorChain always starts with the artist's own address; the
  // declared successor (if any) is at index 1+.
  const chain = successorChain.length > 1 ? successorChain : []
  if (chain.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No successor declared. Setting a successor while your key is
        healthy lets indexers follow your record across a wallet
        rotation.
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <ol className="space-y-1.5">
        {chain.map((addr, i) => (
          <li
            key={addr}
            className="flex items-center gap-3 text-sm font-mono"
          >
            <span className="text-xs text-gray-400 w-4 text-right">
              {i}.
            </span>
            <span>{shortAddr(addr)}</span>
            {i === 0 && (
              <span className="text-[11px] text-gray-500 uppercase tracking-wide">
                this record
              </span>
            )}
            {i > 0 && (
              <a
                href={`/record/${addr}`}
                className="text-xs border border-gray-200 px-2 py-0.5 rounded-full hover:border-gray-400 transition-colors"
              >
                view record →
              </a>
            )}
          </li>
        ))}
      </ol>
      {chain.length > 2 && (
        <p className="text-xs text-gray-500">
          Indexers walk this chain forward to aggregate the full record
          across migrations.
        </p>
      )}
    </div>
  )
}
