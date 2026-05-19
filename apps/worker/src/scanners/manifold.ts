/**
 * Per-artist Manifold scanner. drpc-only — no Etherscan, no Alchemy NFT
 * API. Contract discovery uses `trace_filter`; mint enumeration uses
 * chunked `eth_getLogs(Transfer, from=0x0)`.
 *
 * Flow:
 *   1. trace_filter from MANIFOLD_FIRST_BLOCK → head, filtered by the
 *      artist's address as fromAddress. Returns every CREATE / CREATE2
 *      that the artist initiated, including ones via Manifold Studio's
 *      CREATE2 factory (the factory's call frame is part of the trace).
 *   2. Multicall supportsInterface(0x28f10a21) on the discovered
 *      contracts. Result cached per (artist, contract) in
 *      manifold_contracts so we only probe new deploys.
 *   3. Per Manifold core, chunked eth_getLogs(Transfer, from=0x0,
 *      to=anyone) and TransferSingle/Batch for 1155, in 10K-block
 *      chunks. Capped to MAX_LOG_CHUNKS_PER_TICK per task tick — cursor
 *      advances per tick so multiple ticks catch a fresh artist up.
 *   4. UPSERT mints to artist_tokens (platform='manifold').
 *
 * Block-range constraints (drpc free tier):
 *   - eth_getLogs: 10K blocks per call
 *   - trace_filter: tested working at 50K+ (cap unclear; we chunk at
 *     50K to be safe)
 *
 * The contract classification cache (manifold_contracts) means
 * subsequent refreshes skip the trace_filter walk for every previously-
 * seen contract; only the trace range from last_block forward is
 * re-walked, which is cheap.
 */
import { sql as workerSql } from "../db.ts"
import { client as viemClient, traceClient } from "../rpc.ts"
import { throttleRpc } from "../throttle.ts"
import {
  getAddress, parseAbiItem, type Address, type PublicClient,
} from "viem"
import { resolveNewTokenOwner } from "./resolve-owner.ts"

const CREATOR_CORE_V1_INTERFACE = "0x28f10a21" as const
const ERC721_INTERFACE = "0x80ac58cd" as const
const ERC1155_INTERFACE = "0xd9b67a26" as const
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
const MANIFOLD_FIRST_BLOCK = 13_500_000n
const LOG_CHUNK = 10_000n
const TRACE_CHUNK = 50_000n
// Per-artist scan cap. With Alchemy in the fallback chain as the
// last-resort backstop, failed drpc calls succeed via Alchemy instead
// of being silently swallowed. Bumping the cap so refresh-artist
// invocations make meaningful progress per call rather than nudging
// cursors by 200K blocks at a time.
const MAX_LOG_CHUNKS_PER_TICK = 100
const MAX_TRACE_CHUNKS_PER_TICK = 200
const TASK_NAME = "scan-manifold"

const erc165Abi = [{
  type: "function" as const, name: "supportsInterface", stateMutability: "view" as const,
  inputs: [{ name: "interfaceId", type: "bytes4" as const }],
  outputs: [{ type: "bool" as const }],
}] as const
const nameAbi = [{
  type: "function" as const, name: "name", stateMutability: "view" as const,
  inputs: [], outputs: [{ type: "string" as const }],
}] as const
const tokenUriAbi = [{
  type: "function" as const, name: "tokenURI", stateMutability: "view" as const,
  inputs: [{ name: "tokenId", type: "uint256" as const }],
  outputs: [{ type: "string" as const }],
}] as const
const uriAbi = [{
  type: "function" as const, name: "uri", stateMutability: "view" as const,
  inputs: [{ name: "id", type: "uint256" as const }],
  outputs: [{ type: "string" as const }],
}] as const

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)
const transferSingleEvent = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
)
const transferBatchEvent = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
)

export type ManifoldScanResult = {
  rpcCalls: number
  rowsWritten: number
}

// ─── Public entry ─────────────────────────────────────────────────────────

export async function scanManifoldArtistTokens(
  artistAddress: string,
): Promise<ManifoldScanResult> {
  if (!workerSql) return { rpcCalls: 0, rowsWritten: 0 }
  const artist = artistAddress.toLowerCase() as Address

  const knownRows = (await workerSql`
    SELECT 1 FROM known_artists WHERE address = ${artist} LIMIT 1
  `) as Array<{ "?column?": number }>
  if (knownRows.length === 0) return { rpcCalls: 0, rowsWritten: 0 }

  let rpcCalls = 0
  let rowsWritten = 0

  // Discovery path A: find contracts the artist deployed via trace_filter.
  // Catches own Creator Core deployments.
  const discoverResult = await discoverDeployedContracts(artist, traceClient)
  rpcCalls += discoverResult.rpcCalls
  const deployed = discoverResult.contracts

  // Discovery path B: find tokens minted TO the artist on contracts the
  // artist did NOT deploy (collab contracts, shared platforms, contracts
  // a deployer-contract created on the artist's behalf). Catches everything
  // path A misses. Alchemy-only — falls back to the trace path when
  // Alchemy isn't configured.
  const mintsResult = await discoverMintsToArtist({ artist })
  if (mintsResult) {
    rpcCalls += mintsResult.rpcCalls
    rowsWritten += mintsResult.rowsWritten
  }

  const cached = (await workerSql`
    SELECT lower(contract) AS contract, is_creator_core, is_erc721, is_erc1155, collection_name
    FROM manifold_contracts WHERE artist = ${artist}
  `) as Array<{
    contract: string; is_creator_core: boolean; is_erc721: boolean;
    is_erc1155: boolean; collection_name: string | null
  }>
  const known = new Map(cached.map((r) => [r.contract, r]))
  const unclassified = deployed.filter((addr) => !known.has(addr.toLowerCase()))

  if (unclassified.length > 0) {
    const probed = await classifyContracts(viemClient, unclassified)
    rpcCalls += Math.ceil(unclassified.length * 6 / 250)

    const probedByAddr = new Map(probed.map((p) => [p.address.toLowerCase(), p]))
    for (const addr of unclassified) {
      const lower = addr.toLowerCase()
      const hit = probedByAddr.get(lower)
      // `hit` only exists if the contract is recognized as Creator Core,
      // ERC-721, or ERC-1155 (by ERC-165 OR by tokenURI/uri probe). For
      // anything else (proxies, safes, non-NFT contracts the artist
      // happened to deploy) write the all-false sentinel so we don't
      // re-probe on every cycle.
      const row = hit ?? { isCore: false, is721: false, is1155: false, name: null }
      await workerSql`
        INSERT INTO manifold_contracts
          (artist, contract, is_creator_core, is_erc721, is_erc1155, collection_name, classified_at)
        VALUES (${artist}, ${lower}, ${row.isCore}, ${row.is721}, ${row.is1155}, ${row.name}, NOW())
        ON CONFLICT (artist, contract) DO UPDATE SET
          is_creator_core = EXCLUDED.is_creator_core,
          is_erc721 = EXCLUDED.is_erc721,
          is_erc1155 = EXCLUDED.is_erc1155,
          collection_name = EXCLUDED.collection_name,
          classified_at = NOW()
      `
      known.set(lower, {
        contract: lower,
        is_creator_core: row.isCore,
        is_erc721: row.is721,
        is_erc1155: row.is1155,
        collection_name: row.name,
      })
    }
  }

  // Scan any contract we recognized as Creator Core OR plain ERC-721 OR
  // ERC-1155. Older Manifold deploys often skip ERC-165 entirely; the
  // tokenURI/uri probe in `classifyContracts` catches them.
  const scannable = Array.from(known.values()).filter(
    (r) => r.is_creator_core || r.is_erc721 || r.is_erc1155,
  )
  if (scannable.length === 0) return { rpcCalls, rowsWritten }

  for (const c of scannable) {
    const scope = `${artist}:${c.contract}`
    const cursorRow = (await workerSql`
      SELECT last_block::text AS last_block FROM worker_cursors
      WHERE task = ${TASK_NAME} AND scope = ${scope} LIMIT 1
    `) as Array<{ last_block: string }>
    const fromBlock = cursorRow[0]
      ? BigInt(cursorRow[0].last_block) + 1n
      : MANIFOLD_FIRST_BLOCK

    const head = await viemClient.getBlockNumber()
    rpcCalls += 1
    if (fromBlock > head) continue

    // Backfill mode: if the cursor is more than 100K blocks behind head,
    // try the Alchemy NFT API fast path before falling back to chunked
    // getLogs. One paginated call returns every token in the contract
    // with metadata + ownership, vs. ~1,160 chunks scanning empty space.
    // Skipped for incremental updates (cursor within 100K of head) since
    // chunked getLogs is cheap then.
    const isBackfill = head - fromBlock > 100_000n
    let result: { rpcCalls: number; rowsWritten: number; scannedTo: bigint } | null = null

    if (isBackfill) {
      result = await tryAlchemyFastBackfill({
        artist, contract: c.contract as Address, head,
      })
    }

    if (!result) {
      result = await scanMintsForContract(
        artist, c.contract as Address, c.is_erc721, c.is_erc1155, fromBlock, head,
      )
    }
    rpcCalls += result.rpcCalls
    rowsWritten += result.rowsWritten

    await workerSql`
      INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
      VALUES (${TASK_NAME}, ${scope}, ${result.scannedTo.toString()}::bigint, NOW())
      ON CONFLICT (task, scope) DO UPDATE SET
        last_block = EXCLUDED.last_block, last_run_at = NOW()
    `
  }

  return { rpcCalls, rowsWritten }
}

// ─── Phase 1: contract discovery via trace_filter ─────────────────────────

async function discoverDeployedContracts(
  artist: Address, client: PublicClient,
): Promise<{ contracts: Address[]; rpcCalls: number }> {
  if (!workerSql) return { contracts: [], rpcCalls: 0 }

  const scope = `${artist}:trace`
  const cursorRow = (await workerSql`
    SELECT last_block::text AS last_block FROM worker_cursors
    WHERE task = ${TASK_NAME} AND scope = ${scope} LIMIT 1
  `) as Array<{ last_block: string }>
  let cursor = cursorRow[0]
    ? BigInt(cursorRow[0].last_block) + 1n
    : MANIFOLD_FIRST_BLOCK

  const head = await client.getBlockNumber()
  let rpcCalls = 1
  if (cursor > head) {
    return { contracts: [], rpcCalls }
  }

  const contracts = new Set<string>()
  let chunks = 0
  while (cursor <= head && chunks < MAX_TRACE_CHUNKS_PER_TICK) {
    const toBlock = cursor + TRACE_CHUNK - 1n > head ? head : cursor + TRACE_CHUNK - 1n
    type TraceRow = {
      action?: { from?: string }
      result?: { address?: string }
      type: string
    }
    let rows: TraceRow[] = []
    try {
      rows = (await client.request({
        method: "trace_filter" as never,
        params: [{
          fromBlock: `0x${cursor.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          fromAddress: [artist],
        }] as never,
      })) as TraceRow[]
    } catch (err) {
      console.error(`[${TASK_NAME}.trace] ${artist} ${cursor}-${toBlock}:`, err)
    }
    rpcCalls += 1

    for (const r of rows) {
      if (r.type === "create" && r.result?.address) {
        contracts.add(r.result.address.toLowerCase())
      }
    }

    cursor = toBlock + 1n
    chunks++
  }

  await workerSql`
    INSERT INTO worker_cursors (task, scope, last_block, last_run_at)
    VALUES (${TASK_NAME}, ${scope}, ${(cursor - 1n).toString()}::bigint, NOW())
    ON CONFLICT (task, scope) DO UPDATE SET
      last_block = EXCLUDED.last_block, last_run_at = NOW()
  `

  const previouslySeen = (await workerSql`
    SELECT lower(contract) AS contract FROM manifold_contracts
    WHERE artist = ${artist}
  `) as Array<{ contract: string }>
  for (const p of previouslySeen) contracts.add(p.contract)

  return {
    contracts: Array.from(contracts).map((c) => getAddress(c) as Address),
    rpcCalls,
  }
}

// ─── Phase 2: supportsInterface classification ────────────────────────────

async function classifyContracts(
  client: PublicClient, addresses: Address[],
): Promise<Array<{
  address: Address; isCore: boolean; is721: boolean; is1155: boolean; name: string | null
}>> {
  if (addresses.length === 0) return []

  // Probe six things per contract. The first three are the "well-behaved"
  // ERC-165 path. The last two (tokenURI/uri) are the fallback for older
  // Manifold deploys that skipped ERC-165 entirely — they still return a
  // tokenURI for token id 1 if you ask. `name` is for display.
  const calls = addresses.flatMap((addr) => [
    {
      address: addr, abi: erc165Abi, functionName: "supportsInterface" as const,
      args: [CREATOR_CORE_V1_INTERFACE],
    },
    {
      address: addr, abi: erc165Abi, functionName: "supportsInterface" as const,
      args: [ERC721_INTERFACE],
    },
    {
      address: addr, abi: erc165Abi, functionName: "supportsInterface" as const,
      args: [ERC1155_INTERFACE],
    },
    { address: addr, abi: nameAbi, functionName: "name" as const },
    { address: addr, abi: tokenUriAbi, functionName: "tokenURI" as const, args: [1n] },
    { address: addr, abi: uriAbi, functionName: "uri" as const, args: [1n] },
  ])

  const results = (await client.multicall({
    contracts: calls,
    allowFailure: true,
  })) as Array<{ status: "success"; result: unknown } | { status: "failure" }>

  const out: Array<{
    address: Address; isCore: boolean; is721: boolean; is1155: boolean; name: string | null
  }> = []
  for (let i = 0; i < addresses.length; i++) {
    const base = i * 6
    const coreRes    = results[base]
    const is721Res   = results[base + 1]
    const is1155Res  = results[base + 2]
    const nameRes    = results[base + 3]
    const tokenUriRes = results[base + 4]
    const uriRes      = results[base + 5]

    const isCore  = coreRes.status === "success" && coreRes.result === true
    const erc165Says721  = is721Res.status === "success" && is721Res.result === true
    const erc165Says1155 = is1155Res.status === "success" && is1155Res.result === true

    // Probe fallback: a contract that returns a tokenURI for id 1 is
    // ERC-721 even if it doesn't implement ERC-165. Same for uri →
    // ERC-1155. Required for older Manifold deploys that skipped
    // ERC-165.
    const probeSays721  = tokenUriRes.status === "success"
    const probeSays1155 = uriRes.status === "success"

    const is721  = erc165Says721  || (probeSays721 && !probeSays1155)
    const is1155 = erc165Says1155 || (probeSays1155 && !probeSays721)

    // Only emit contracts we actually recognize as scannable. Random
    // non-NFT contracts the artist deployed (gnosis safes, proxies,
    // utility contracts) get skipped here AND get a sentinel row
    // written by the caller so we don't re-probe them.
    if (!isCore && !is721 && !is1155) continue

    out.push({
      address: addresses[i],
      isCore,
      is721,
      is1155,
      name: nameRes.status === "success" ? (nameRes.result as string) : null,
    })
  }
  return out
}

// ─── Phase 3: per-contract mint enumeration via chunked eth_getLogs ──────

async function scanMintsForContract(
  artist: Address, contract: Address, is721: boolean, is1155: boolean,
  fromBlock: bigint, head: bigint,
): Promise<{ rpcCalls: number; rowsWritten: number; scannedTo: bigint }> {
  if (!workerSql) return { rpcCalls: 0, rowsWritten: 0, scannedTo: fromBlock }

  let cursor = fromBlock
  let rpcCalls = 0
  let rowsWritten = 0
  let chunks = 0

  while (cursor <= head && chunks < MAX_LOG_CHUNKS_PER_TICK) {
    const toBlock = cursor + LOG_CHUNK - 1n > head ? head : cursor + LOG_CHUNK - 1n

    if (is721) {
      await throttleRpc()
      const logs = await viemClient.getLogs({
        address: contract,
        event: transferEvent,
        args: { from: ZERO_ADDRESS as `0x${string}` },
        fromBlock: cursor,
        toBlock,
      }).catch(() => [])
      rpcCalls += 1
      for (const log of logs) {
        if (log.args.tokenId === undefined) continue
        const tokenId = log.args.tokenId.toString()
        await insertToken(artist, contract, tokenId, log.blockNumber!, log.logIndex!)
        rowsWritten++
      }
    }

    if (is1155) {
      await throttleRpc()
      const singles = await viemClient.getLogs({
        address: contract,
        event: transferSingleEvent,
        args: { from: ZERO_ADDRESS as `0x${string}` },
        fromBlock: cursor,
        toBlock,
      }).catch(() => [])
      rpcCalls += 1
      for (const log of singles) {
        if (log.args.id === undefined) continue
        const tokenId = log.args.id.toString()
        await insertToken(artist, contract, tokenId, log.blockNumber!, log.logIndex!)
        rowsWritten++
      }

      await throttleRpc()
      const batches = await viemClient.getLogs({
        address: contract,
        event: transferBatchEvent,
        args: { from: ZERO_ADDRESS as `0x${string}` },
        fromBlock: cursor,
        toBlock,
      }).catch(() => [])
      rpcCalls += 1
      for (const log of batches) {
        const ids = (log.args.ids ?? []) as readonly bigint[]
        for (const id of ids) {
          await insertToken(artist, contract, id.toString(), log.blockNumber!, log.logIndex!)
          rowsWritten++
        }
      }
    }

    cursor = toBlock + 1n
    chunks++
  }

  return { rpcCalls, rowsWritten, scannedTo: cursor - 1n }
}

// ─── Phase 3-fast: Alchemy NFT API backfill ───────────────────────────────
//
// `alchemy_getNFTsForContract` (NFT API v3, REST endpoint, not JSON-RPC)
// returns every token in a contract with name/description/image/owner/
// mint-block in one paginated call. Avoids the chunked getLogs walk that
// scans ~1,160 mostly-empty 10K-block ranges per contract.
//
// Returns null if ALCHEMY_API_KEY isn't set or the API call fails;
// caller falls back to chunked getLogs. Sets cursor to `head` on success
// so subsequent ticks go straight to incremental mode.

const ALCHEMY_NFT_BASE = "https://eth-mainnet.g.alchemy.com/nft/v3"
const ALCHEMY_NFT_MAX_PAGES = 100 // safety cap: ~10,000 tokens/contract

type AlchemyNftPage = {
  nfts?: Array<{
    tokenId?: string
    name?: string | null
    description?: string | null
    image?: { cachedUrl?: string | null; originalUrl?: string | null } | null
    animation?: { cachedUrl?: string | null; originalUrl?: string | null } | null
    tokenUri?: string | null
    mint?: { blockNumber?: number | string | null } | null
    owners?: string[] | null
  }>
  pageKey?: string
}

async function tryAlchemyFastBackfill(args: {
  artist: Address; contract: Address; head: bigint
}): Promise<{ rpcCalls: number; rowsWritten: number; scannedTo: bigint } | null> {
  if (!workerSql) return null
  const key = process.env.ALCHEMY_API_KEY
  if (!key || key.startsWith("set-")) return null

  const { artist, contract, head } = args
  let pageKey: string | undefined
  let rpcCalls = 0
  let rowsWritten = 0
  let pages = 0

  do {
    const url = new URL(`${ALCHEMY_NFT_BASE}/${key}/getNFTsForContract`)
    url.searchParams.set("contractAddress", contract)
    url.searchParams.set("withMetadata", "true")
    url.searchParams.set("limit", "100")
    if (pageKey) url.searchParams.set("pageKey", pageKey)

    let data: AlchemyNftPage
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        console.warn(`[manifold-fast] ${contract}: NFT API ${res.status} ${await res.text().catch(() => "")}`)
        return null
      }
      data = (await res.json()) as AlchemyNftPage
    } catch (err) {
      console.warn(`[manifold-fast] ${contract}: fetch error ${err}`)
      return null
    }
    rpcCalls++

    for (const nft of data.nfts ?? []) {
      if (!nft.tokenId) continue
      const tokenId = nft.tokenId
      const imageUrl =
        nft.image?.cachedUrl ?? nft.image?.originalUrl ?? null
      const animationUrl =
        nft.animation?.cachedUrl ?? nft.animation?.originalUrl ?? null
      const mintBlock = nft.mint?.blockNumber
        ? BigInt(nft.mint.blockNumber)
        : 0n
      const owner = nft.owners?.[0]?.toLowerCase() ?? null

      try {
        await workerSql.begin(async (tx) => {
          await tx`
            INSERT INTO artist_tokens
              (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
            VALUES
              (${artist}, ${contract}, ${tokenId}, 'manifold',
               ${mintBlock.toString()}::bigint, 0, NOW())
            ON CONFLICT (contract, token_id) DO NOTHING
          `
          // Persist metadata if present. Always write a row (even if all-null)
          // so warm-metadata doesn't redundantly re-resolve.
          await tx`
            INSERT INTO token_metadata
              (contract, token_id, name, description, image_url, animation_url, raw_uri, fetched_at)
            VALUES
              (${contract}, ${tokenId},
               ${nft.name ?? null}, ${nft.description ?? null},
               ${imageUrl}, ${animationUrl}, ${nft.tokenUri ?? null}, NOW())
            ON CONFLICT (contract, token_id) DO UPDATE SET
              name = COALESCE(EXCLUDED.name, token_metadata.name),
              description = COALESCE(EXCLUDED.description, token_metadata.description),
              image_url = COALESCE(EXCLUDED.image_url, token_metadata.image_url),
              animation_url = COALESCE(EXCLUDED.animation_url, token_metadata.animation_url),
              raw_uri = COALESCE(EXCLUDED.raw_uri, token_metadata.raw_uri),
              fetched_at = NOW()
          `
          if (owner) {
            await tx`
              INSERT INTO token_owners
                (contract, token_id, owner, transferred_at_block, transferred_at_time, tx_hash)
              VALUES
                (${contract}, ${tokenId}, ${owner},
                 ${mintBlock.toString()}::bigint, 0::bigint, '')
              ON CONFLICT (contract, token_id) DO UPDATE SET
                owner = EXCLUDED.owner,
                transferred_at_block = GREATEST(token_owners.transferred_at_block, EXCLUDED.transferred_at_block)
            `
          }
        })
        rowsWritten++
      } catch (err) {
        console.warn(`[manifold-fast] ${contract}/${tokenId}: insert error ${err}`)
      }
    }

    pageKey = data.pageKey
    pages++
    if (pages >= ALCHEMY_NFT_MAX_PAGES) {
      console.warn(`[manifold-fast] ${contract}: hit ${ALCHEMY_NFT_MAX_PAGES}-page cap`)
      break
    }
  } while (pageKey)

  // Cursor jumps to head: future ticks go straight to incremental getLogs
  // for any new mints after this point.
  return { rpcCalls, rowsWritten, scannedTo: head }
}

// ─── Discovery path B: mints TO the artist (Alchemy-only) ─────────────────
//
// trace_filter discovery only finds contracts the artist DEPLOYED. Artists
// also mint on contracts they didn't deploy: collaboration contracts,
// shared-platform contracts (Manifold studio shared, OpenSea shared),
// contracts that a deployer contract created for them via CREATE2.
//
// `alchemy_getAssetTransfers` filtered to `fromAddress=0x0, toAddress=artist`
// returns every NFT mint where the artist was the original recipient — the
// universal "this token is by this artist" signal. Then for each unique
// (contract, tokenId) pair, batch fetch metadata.
//
// Cost: ~1 getAssetTransfers call (paginated, ~1000 per page) + 1 call per
// 100 tokens via getNFTMetadataBatch. For a typical artist with <500 mints:
// 5-6 Alchemy calls total. Tiny.

const ALCHEMY_RPC_BASE = "https://eth-mainnet.g.alchemy.com/v2"
type AlchemyTransfer = {
  blockNum?: string
  hash?: string
  rawContract?: { address?: string }
  tokenId?: string | null
  erc1155Metadata?: Array<{ tokenId?: string }>
  category?: string
}

async function discoverMintsToArtist(args: {
  artist: Address
}): Promise<{ rpcCalls: number; rowsWritten: number } | null> {
  if (!workerSql) return null
  const key = process.env.ALCHEMY_API_KEY
  if (!key || key.startsWith("set-")) return null

  const { artist } = args

  // Page through all NFT mints to the artist.
  type MintRef = { contract: string; tokenId: string; blockNum: bigint }
  const mints: MintRef[] = []
  let pageKey: string | undefined
  let rpcCalls = 0
  const MAX_PAGES = 50 // ~50K mints max — way beyond any realistic artist

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{
        fromAddress: "0x0000000000000000000000000000000000000000",
        toAddress: artist,
        category: ["erc721", "erc1155"],
        maxCount: "0x3e8", // 1000 per page
        withMetadata: false,
        order: "asc",
        ...(pageKey ? { pageKey } : {}),
      }],
    }

    let data: { result?: { transfers?: AlchemyTransfer[]; pageKey?: string } }
    try {
      const res = await fetch(`${ALCHEMY_RPC_BASE}/${key}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        console.warn(`[manifold-mints-to] ${artist}: ${res.status}`)
        return null
      }
      data = (await res.json()) as typeof data
    } catch (err) {
      console.warn(`[manifold-mints-to] ${artist}: ${err}`)
      return null
    }
    rpcCalls++

    const transfers = data.result?.transfers ?? []
    for (const t of transfers) {
      const contract = t.rawContract?.address?.toLowerCase()
      if (!contract) continue
      const blockNum = t.blockNum ? BigInt(t.blockNum) : 0n

      if (t.category === "erc1155") {
        for (const m of t.erc1155Metadata ?? []) {
          if (m.tokenId) mints.push({ contract, tokenId: BigInt(m.tokenId).toString(), blockNum })
        }
      } else if (t.tokenId) {
        mints.push({ contract, tokenId: BigInt(t.tokenId).toString(), blockNum })
      }
    }

    pageKey = data.result?.pageKey
    if (!pageKey) break
  }

  if (mints.length === 0) return { rpcCalls, rowsWritten: 0 }

  // Batch metadata: getNFTMetadataBatch takes up to 100 tokens per call.
  type AlchemyMeta = {
    contract?: { address?: string }
    tokenId?: string
    name?: string | null
    description?: string | null
    image?: { cachedUrl?: string | null; originalUrl?: string | null } | null
    animation?: { cachedUrl?: string | null; originalUrl?: string | null } | null
    tokenUri?: string | null
  }

  const metadataByKey = new Map<string, AlchemyMeta>()
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100).map((m) => ({
      contractAddress: m.contract,
      tokenId: m.tokenId,
    }))
    try {
      const res = await fetch(
        `https://eth-mainnet.g.alchemy.com/nft/v3/${key}/getNFTMetadataBatch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tokens: batch, refreshCache: false }),
          signal: AbortSignal.timeout(30_000),
        },
      )
      if (res.ok) {
        const data = (await res.json()) as { nfts?: AlchemyMeta[] }
        for (const nft of data.nfts ?? []) {
          const c = nft.contract?.address?.toLowerCase()
          const t = nft.tokenId
          if (c && t) metadataByKey.set(`${c}:${t}`, nft)
        }
      }
    } catch (err) {
      console.warn(`[manifold-mints-to] metadata batch error: ${err}`)
    }
    rpcCalls++
  }

  // Insert. Use platform='manifold' as a catch-all for artist-minted-via-Alchemy
  // discovery. Steady-state log scans on contracts the artist deployed will
  // still write platform='manifold' for the same tokens; ON CONFLICT dedupes.
  let rowsWritten = 0
  for (const m of mints) {
    const meta = metadataByKey.get(`${m.contract}:${m.tokenId}`)
    try {
      await workerSql.begin(async (tx) => {
        await tx`
          INSERT INTO artist_tokens
            (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
          VALUES
            (${artist}, ${m.contract}, ${m.tokenId}, 'manifold',
             ${m.blockNum.toString()}::bigint, 0, NOW())
          ON CONFLICT (contract, token_id) DO NOTHING
        `
        if (meta) {
          const imageUrl = meta.image?.cachedUrl ?? meta.image?.originalUrl ?? null
          const animationUrl = meta.animation?.cachedUrl ?? meta.animation?.originalUrl ?? null
          await tx`
            INSERT INTO token_metadata
              (contract, token_id, name, description, image_url, animation_url, raw_uri, fetched_at)
            VALUES
              (${m.contract}, ${m.tokenId},
               ${meta.name ?? null}, ${meta.description ?? null},
               ${imageUrl}, ${animationUrl}, ${meta.tokenUri ?? null}, NOW())
            ON CONFLICT (contract, token_id) DO UPDATE SET
              name = COALESCE(EXCLUDED.name, token_metadata.name),
              description = COALESCE(EXCLUDED.description, token_metadata.description),
              image_url = COALESCE(EXCLUDED.image_url, token_metadata.image_url),
              animation_url = COALESCE(EXCLUDED.animation_url, token_metadata.animation_url),
              raw_uri = COALESCE(EXCLUDED.raw_uri, token_metadata.raw_uri),
              fetched_at = NOW()
          `
        }
      })
      rowsWritten++
    } catch (err) {
      console.warn(`[manifold-mints-to] ${m.contract}/${m.tokenId}: ${err}`)
    }
  }

  return { rpcCalls, rowsWritten }
}

async function insertToken(
  artist: Address, contract: Address, tokenId: string,
  blockNumber: bigint, logIndex: number,
): Promise<void> {
  if (!workerSql) return
  await workerSql`
    INSERT INTO artist_tokens
      (artist, contract, token_id, platform, mint_block, mint_log_index, first_seen_at)
    VALUES
      (${artist.toLowerCase()}, ${contract.toLowerCase()}, ${tokenId}, 'manifold',
       ${blockNumber.toString()}::bigint, ${logIndex}, NOW())
    ON CONFLICT (contract, token_id) DO NOTHING
  `
  await resolveNewTokenOwner({
    sql: workerSql, client: viemClient,
    contract: contract.toLowerCase(), tokenId,
  }).catch(() => undefined)
}
