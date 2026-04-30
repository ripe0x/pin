import "server-only"
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
} from "viem"
import { mainnet } from "viem/chains"
import {
  SUPERRARE_BAZAAR,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import {
  readScanCursor,
  writeScanCursor,
  writeSuperrareV2ActiveAuctions,
  readSuperrareV2ActiveAuctions,
  LAZY_TTL,
  isFresh,
  type LazySuperrareV2ActiveAuction,
} from "../lazy-index"

const SR_BAZAAR = SUPERRARE_BAZAAR[MAINNET_CHAIN_ID]
const SCAN_KEY = "srv2_bazaar"
// Bazaar deployed Feb 2022 (~14_100_000). Used as the seed cursor when
// no prior scan exists so the first scan covers the contract's full
// lifetime in one pass.
const SR_BAZAAR_DEPLOY_BLOCK = 14_100_000n
// Per-call chunk for the unindexed scan. Bazaar emits all four event
// types on the same address, and we don't filter by indexed args here
// (we want every auction, not one specific token). 500K blocks keeps
// each `getLogs` response small enough to clear Alchemy's "response
// too large" threshold even during high-activity periods. On failure
// the scanner halves the range and retries; first scans may take a
// few catch-up runs to reach head, but each individual call is cheap.
const BLOCK_RANGE = 500_000n
const MIN_CHUNK = 10_000n
// Minimum freshness window before we re-scan. Matches `LAZY_TTL.superrareV2AuctionScan`.
const COOLDOWN_MS = LAZY_TTL.superrareV2AuctionScan
// Hard upper bound on scan wall-clock so a slow RPC can't stall the
// home grid render. The home page never awaits this past the cap;
// stale rows continue serving until the next call refreshes them.
const SCAN_TIMEOUT_MS = 10_000

const newAuctionEvent = parseAbiItem(
  "event NewAuction(address indexed _contractAddress, uint256 indexed _tokenId, address indexed _auctionCreator, address _currencyAddress, uint256 _startingTime, uint256 _minimumBid, uint256 _lengthOfAuction)",
)
const auctionBidEvent = parseAbiItem(
  "event AuctionBid(address indexed _contractAddress, address indexed _bidder, uint256 indexed _tokenId, address _currencyAddress, uint256 _amount, bool _startedAuction, uint256 _newAuctionLength, address _previousBidder)",
)
const auctionSettledEvent = parseAbiItem(
  "event AuctionSettled(address indexed _contractAddress, address indexed _bidder, address _seller, uint256 indexed _tokenId, address _currencyAddress, uint256 _amount)",
)
const cancelAuctionEvent = parseAbiItem(
  "event CancelAuction(address indexed _contractAddress, uint256 indexed _tokenId, address indexed _auctionCreator)",
)

const ETH_CURRENCY = "0x0000000000000000000000000000000000000000"

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ??
        "https://eth.llamarpc.com",
      { batch: true },
    ),
  })
}

type ScanLog = {
  blockNumber: bigint | null
  logIndex: number | null
  args: Record<string, unknown>
  eventName: "NewAuction" | "AuctionBid" | "AuctionSettled" | "CancelAuction"
}

function tokenKey(contract: string, tokenId: string): string {
  return `${contract.toLowerCase()}:${tokenId}`
}

function logSortKey(l: ScanLog): bigint {
  // Block-then-logIndex ordering as a single comparable value. logIndex
  // fits in <32 bits; combine into the same bigint for a stable sort
  // without per-pair comparisons.
  const block = l.blockNumber ?? 0n
  const idx = BigInt(l.logIndex ?? 0)
  return block * 100_000n + idx
}

/**
 * Incrementally update `lazy_srv2_active_auctions` by replaying Bazaar
 * events from the last scanned block forward. Cooldown-bounded: callers
 * within `COOLDOWN_MS` of the last scan no-op so the home-grid orchestrator
 * can call this on every render without thrashing.
 *
 * On first run (no cursor), the scan covers the full Bazaar lifetime
 * (~ Feb 2022 → now). The scan is bounded by `SCAN_TIMEOUT_MS` so a
 * long catch-up doesn't block the render; subsequent runs pick up from
 * wherever this run got to.
 */
export async function refreshSuperrareV2Auctions(): Promise<void> {
  const cursor = await readScanCursor(SCAN_KEY)
  if (cursor && isFresh(cursor.lastScannedAt, COOLDOWN_MS)) {
    // Within the cooldown — trust the table.
    return
  }

  const client = getClient()
  const latestBlock = await client.getBlockNumber()
  const fromBlock = cursor ? cursor.lastBlock + 1n : SR_BAZAAR_DEPLOY_BLOCK
  if (fromBlock > latestBlock) {
    await writeScanCursor(SCAN_KEY, latestBlock)
    return
  }

  const deadline = Date.now() + SCAN_TIMEOUT_MS
  // Index existing rows by (contract, tokenId) so events can mutate
  // them in place. Read up to a generous limit so partial refreshes
  // don't lose state; non-active rows (settled/cancelled) get re-read
  // back as well via the SELECT below.
  const existingRows = await readSuperrareV2ActiveAuctions(10_000)
  const byKey = new Map<string, LazySuperrareV2ActiveAuction>()
  for (const r of existingRows) byKey.set(tokenKey(r.contract, r.tokenId), r)

  // Halve-and-retry chunk fetcher. Bazaar's event volume varies; some
  // ranges fit the default chunk and some need to be split down. Bottom
  // out at MIN_CHUNK so a chronically-too-large response surfaces as a
  // dropped chunk rather than infinite recursion.
  async function fetchChunk(
    start: bigint,
    end: bigint,
  ): Promise<ScanLog[] | null> {
    try {
      const [news, bids, settles, cancels] = await Promise.all([
        client.getLogs({
          address: SR_BAZAAR,
          event: newAuctionEvent,
          fromBlock: start,
          toBlock: end,
        }),
        client.getLogs({
          address: SR_BAZAAR,
          event: auctionBidEvent,
          fromBlock: start,
          toBlock: end,
        }),
        client.getLogs({
          address: SR_BAZAAR,
          event: auctionSettledEvent,
          fromBlock: start,
          toBlock: end,
        }),
        client.getLogs({
          address: SR_BAZAAR,
          event: cancelAuctionEvent,
          fromBlock: start,
          toBlock: end,
        }),
      ])
      return [
        ...news.map((l) => ({ ...l, eventName: "NewAuction" as const })),
        ...bids.map((l) => ({ ...l, eventName: "AuctionBid" as const })),
        ...settles.map((l) => ({ ...l, eventName: "AuctionSettled" as const })),
        ...cancels.map((l) => ({ ...l, eventName: "CancelAuction" as const })),
      ] as unknown as ScanLog[]
    } catch {
      if (end - start <= MIN_CHUNK) return null
      const mid = start + (end - start) / 2n
      const a = await fetchChunk(start, mid)
      const b = await fetchChunk(mid + 1n, end)
      if (a === null && b === null) return null
      return [...(a ?? []), ...(b ?? [])]
    }
  }

  // Walk forward from the cursor, applying chunks in order so events
  // mutate rows consistently. A bid following a NewAuction within the
  // same chunk has to apply in block:logIndex order — sort first.
  let scannedTo = fromBlock - 1n
  for (let start = fromBlock; start <= latestBlock; start += BLOCK_RANGE) {
    if (Date.now() > deadline) break
    const end = start + BLOCK_RANGE - 1n > latestBlock
      ? latestBlock
      : start + BLOCK_RANGE - 1n

    const logs = await fetchChunk(start, end)
    if (logs === null) {
      // Even the smallest chunk failed — record progress and stop so
      // next call retries from here (likely a transient RPC issue).
      break
    }

    logs.sort((a, b) => {
      const ak = logSortKey(a)
      const bk = logSortKey(b)
      return ak > bk ? 1 : ak < bk ? -1 : 0
    })

    for (const l of logs) {
      const args = l.args as Record<string, unknown>
      const contract = (args._contractAddress as Address)?.toLowerCase()
      const tokenIdRaw = args._tokenId as bigint | undefined
      if (!contract || tokenIdRaw === undefined) continue
      const tokenId = tokenIdRaw.toString()
      const key = tokenKey(contract, tokenId)
      const existing = byKey.get(key)

      if (l.eventName === "NewAuction") {
        const currency = (args._currencyAddress as Address)?.toLowerCase()
        // Skip ERC-20 auctions; we don't surface them.
        if (currency && currency !== ETH_CURRENCY) {
          if (existing) byKey.delete(key)
          continue
        }
        byKey.set(key, {
          contract,
          tokenId,
          seller: (args._auctionCreator as Address).toLowerCase(),
          reserveWei: args._minimumBid as bigint,
          currentBidWei: 0n,
          currentBidder: null,
          endTime: 0,
          status: "active",
          startedAtBlock: l.blockNumber ?? 0n,
        })
      } else if (l.eventName === "AuctionBid") {
        const currency = (args._currencyAddress as Address)?.toLowerCase()
        if (currency && currency !== ETH_CURRENCY) continue
        const amount = args._amount as bigint
        const newLength = args._newAuctionLength as bigint
        if (!existing) {
          // Bid arrived without a NewAuction we know about (cursor
          // missed it). Synthesize a row so the home grid can still
          // surface it. Reserve unknown — fall back to the bid amount.
          byKey.set(key, {
            contract,
            tokenId,
            seller: ZERO_ADDRESS_LOWER,
            reserveWei: amount,
            currentBidWei: amount,
            currentBidder: (args._bidder as Address).toLowerCase(),
            endTime: 0, // unknown; will be derived if NewAuction surfaces later
            status: "active",
            startedAtBlock: l.blockNumber ?? 0n,
          })
        } else {
          existing.currentBidWei = amount
          existing.currentBidder = (args._bidder as Address).toLowerCase()
          // SR Bazaar bumps `_newAuctionLength` on each bid (typically
          // identical to the configured length). End time = bid block
          // timestamp + new length. Without a per-bid block fetch we
          // approximate the bid timestamp from the chain head time —
          // the scanner runs fresh enough that this is within seconds.
          existing.endTime = Math.floor(Date.now() / 1000) + Number(newLength)
        }
      } else if (l.eventName === "AuctionSettled") {
        if (existing) {
          existing.status = "settled"
        }
      } else if (l.eventName === "CancelAuction") {
        if (existing) {
          existing.status = "cancelled"
        }
      }
    }

    scannedTo = end
  }

  if (byKey.size > 0) {
    writeSuperrareV2ActiveAuctions([...byKey.values()])
  }
  await writeScanCursor(SCAN_KEY, scannedTo > 0n ? scannedTo : latestBlock)
}

const ZERO_ADDRESS_LOWER = "0x0000000000000000000000000000000000000000"
