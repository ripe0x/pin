# PND v2

Artist-owned auction infrastructure on Ethereum. Rebuild of [ripe0x/pin](https://github.com/ripe0x/pin) around one invariant:

> Token data is stored permanently in Postgres. The web app never refetches on cache miss. The web app never triggers a chain read for storable data. The worker keeps stored data fresh; the web reads.

See `PLAN.md` for the full architectural rationale.

## Topology

Five services, one Railway project:

```
web (Next.js, long-running)
indexer (Ponder, 7 contracts)
worker (Node, per-artist scans + owners + ENS + metadata)
postgres
```

No Netlify, no scheduled functions, no cron config. The worker owns all periodic work.

## Quick start (local)

```bash
# 1. Install
pnpm install

# 2. Postgres in Docker
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:15

# 3. Env (root .env, used by db:migrate; per-app envs for runtimes)
echo "DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres" > .env
cp apps/web/.env.example apps/web/.env.local
cp apps/indexer/.env.example apps/indexer/.env
cp apps/worker/.env.example apps/worker/.env

# 4. Migrate
pnpm db:migrate

# 5. Run each service in a separate terminal
pnpm dev:indexer    # Ponder; takes ~1h for full backfill on first run
pnpm dev:worker     # Node worker; starts head-following after Ponder is ready
pnpm dev:web        # Next.js on :3000
```

## Architecture

### Ponder scope (7 contracts)

State-machine subscriptions:
- `SovereignAuctionHouseFactory` + clones (PND auctions)
- `NFTMarket` (Foundation marketplace)
- `FoundationNFT` shared 1/1
- `SuperRareNFT` shared 1/1
- `Catalog`

Discovery-only (one row per artist-deploys-a-clone, no per-clone events):
- `NFTCollectionFactoryV1/V2` → `fnd_collections`
- `MintFactory` → `mint_creators`
- `TLUniversalDeployer` → `tl_creators`

NOT indexed by Ponder (handled by worker scanners): SR Bazaar marketplace, TL Auction House, Foundation/Mint/TL per-clone Transfer events, Manifold.

### Worker tasks

| Task | Cadence | Reads | Writes |
|---|---|---|---|
| `seed-known-artists` | startup + 1h | Ponder + `artist_seeds` | `known_artists` view |
| `warm-contract-identity` | 10m | new contracts | `contract_identity` |
| `warm-ens` | 10m | known artists, auction winners/buyers | `ens_identities` |
| `warm-metadata` | 1m/5m | new `artist_tokens` rows | `token_metadata` |
| `scan-fnd-collections` | 10m | `fnd_collections`, cursor | `artist_tokens`, cursor |
| `scan-mint-clones` | 10m | `mint_creators`, cursor | `artist_tokens`, cursor |
| `scan-tl-clones` | 10m | `tl_creators`, cursor | `artist_tokens`, cursor |
| `scan-manifold` | 30m | Etherscan + Alchemy NFT API | `artist_tokens` |
| `resolve-new-token-owner` | event-driven | (single `ownerOf` per new mint) | `token_owners` |
| `scan-token-transfers` | 5m | distinct contracts in `artist_tokens`, cursor | `token_owners`, `token_transfers` |
| `ponder-drift-check` | 1h | `pnd_houses` vs `ponder_sync.factory_addresses` | (alerts) |

All scanners gate on `isKnownArtist(addr)`. `known_artists` is the spend ceiling.

### Web app: how reads work

`apps/web/src/lib/reads.ts` is the entire data-fetching surface. Every page hits one or more of those typed SELECTs. No fallback chains; if data isn't there, the page shows an empty state and a worker job has been queued.

`apps/web/src/lib/onchain.ts` is the six functions that genuinely need live state:
- `getActiveAuctionState`, `getBuyPrice`, `getActiveSrV2AuctionMap`, `getActiveTlAuctionMap`, `getCurrentOwner`, `getEnsForFreshAddress`.

Every other reach to chain happens in the worker, off the request path, behind a cursor.

## License

MIT.
