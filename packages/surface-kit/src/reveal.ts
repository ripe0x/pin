import { parseEventLogs, type Abi } from "viem"
import type { RevealLog, RevealSource } from "./types.ts"

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

export function extractRevealTokenId(options: {
  reveal: RevealSource
  logs: readonly RevealLog[]
  collection: string
  abi: Abi
  minter?: string
}): bigint | null {
  const { reveal, logs, collection, abi, minter } = options
  const collectionLower = collection.toLowerCase()

  if (reveal.kind === "transfer-log") {
    let fallback: bigint | null = null
    for (const log of logs) {
      if (log.address.toLowerCase() !== collectionLower) continue
      if (log.topics.length !== 4 || log.topics[0] !== TRANSFER_TOPIC) continue
      if (BigInt(log.topics[1]!) !== 0n) continue
      if (!minter || BigInt(log.topics[2]!) === BigInt(minter)) return BigInt(log.topics[3]!)
      if (fallback === null) fallback = BigInt(log.topics[3]!)
    }
    return fallback
  }

  let parsed: ReturnType<typeof parseEventLogs>
  try {
    parsed = parseEventLogs({
      abi,
      eventName: reveal.abiEvent,
      logs: logs as never,
      strict: false,
    })
  } catch {
    return null
  }
  for (const log of parsed) {
    if (log.address.toLowerCase() !== collectionLower) continue
    const tokenId = pickTokenIdArg((log as { args?: unknown }).args)
    if (tokenId !== null) return tokenId
  }
  return null
}

function pickTokenIdArg(args: unknown): bigint | null {
  if (args === null || typeof args !== "object") return null
  if (Array.isArray(args)) return args.find((value): value is bigint => typeof value === "bigint") ?? null
  const record = args as Record<string, unknown>
  const names = Object.keys(record)
  const exact = names.find((name) => /^(tokenid|punkid|id)$/i.test(name))
  if (exact && typeof record[exact] === "bigint") return record[exact] as bigint
  const suffixed = names.find((name) => /id$/i.test(name) && typeof record[name] === "bigint")
  if (suffixed) return record[suffixed] as bigint
  const firstBigint = names.find((name) => typeof record[name] === "bigint")
  return firstBigint ? (record[firstBigint] as bigint) : null
}
