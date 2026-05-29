# MURI integration

PND integrates the [MURI protocol](https://muri.yigitduman.com)
(`github.com/ygtdmn/muri-protocol`) for on-chain media permanence. MURI is
the on-chain endgame of PND's preservation thesis: instead of pinning a
single CID off-chain (what `/preserve` does), a MURI token stores **multiple
fallback artwork URIs + a SHA-256 integrity hash** on-chain, and its default
on-chain HTML viewer fetches each URI in order, verifies the hash, and renders
the first surviving copy.

## Contracts (mainnet)

| Contract | Address | Notes |
|----------|---------|-------|
| `MURIProtocol` (singleton) | `0x0000000000C2A0B63ab4aA971B08B905E5875b01` | Fixed shared registry. Deploy block `23754750`. |
| `MURIProtocolManifoldExtension` | `0x0FFc4A1906157248ae64F28fD259bB7a2790606C` | Manifold Creator Extension PND mints through. |

Same addresses on Base + Sepolia (not yet wired; PND web is mainnet-only).
Addresses live in `packages/addresses`; ABIs in `packages/abi`
(`muriProtocol.ts`, `muriProtocolManifoldExtension.ts`, `manifoldCreatorCore.ts`).

## Two halves

### 1. Read / surface (works for every MURI token)

`MURIProtocol` is a **fixed shared contract**, so it's indexed in Ponder (per
the discovery-vs-scanning rule in `AGENTS.md`), not the worker long tail.

- Subscription + handlers: `apps/indexer/ponder.config.ts`,
  `apps/indexer/src/MURI.ts` → `ponder_v1.muri_tokens` + `muri_contracts`.
  Each data-changing event reads `getArtwork` once to keep URI counts
  authoritative (the `TokenDataInitialized` event carries no count). These are
  the only chain reads, and they're bounded to MURI events.
- Web reads (pure Postgres, no RPC): `getMuriToken`, `getMuriUriCounts`, and
  the `muri` join in `getTokenDetail`/`getArtistTokens` (`apps/web/src/lib/reads.ts`).
  Reads degrade gracefully if `muri_tokens` doesn't exist yet (indexer redeploy
  may lag the web deploy).
- UI: `components/token/MuriBadge.tsx` (token-page section + gallery-tile badge).

### 2. Mint (new work only)

**MURI on Manifold is a mint-time integration, not a retrofit.** The extension
only *mints* new tokens (`mintERC721`/`mintERC1155`) and its `tokenURI` override
only serves tokens it minted; an already-minted token cannot be converted. So
PND offers "mint a new MURI-native piece on your existing Manifold contract,"
never "upgrade existing work."

Flow (`/muri`, `components/muri/MuriMintFlow.tsx`):

1. **Eligibility** — `getMuriEligibleContracts(artist)` reads the indexed
   `manifold_contracts` table (no Manifold Studio OAuth needed; PND already
   indexes these). API: `/api/muri/eligible/[address]`.
2. **One-time setup** (`useMuriSetup`) — admin-gated, with live reads of
   `getExtensions` / `isContractOperator` / `isAdmin`:
   1. `creatorCore.registerExtension(EXT, "")`
   2. `MURIProtocol.registerContract(contract, EXT)`
3. **Upload + hash** — artwork uploaded to IPFS via the Pinata provider's
   `uploadFile` (free-tier `pinFileToIPFS`), SHA-256 computed with
   `sha256Hex` (`@pin/shared`), one CID expanded to N gateway fallback URLs via
   `ipfsCidToFallbackUrls`.
4. **Mint** (`useMuriMint`) — `buildInitConfig` produces a fully off-chain v1
   config (`DisplayMode.HTML`, default on-chain template, off-chain thumbnail,
   full artist permissions, collectors may add fallbacks), then
   `mintERC721`/`mintERC1155` with empty `thumbnailChunks`/`htmlTemplateChunks`.

## Verification

- `apps/web/src/lib/muri/build-init-config.test.ts` encodes the InitConfig
  against the real extension ABI (validates the nested tuple) for both 721/1155.
- The `getArtwork` ABI + `TokenDataInitialized` topic were checked against live
  mainnet MURI tokens.
- End-to-end mint verification needs a Manifold-admin wallet on a mainnet fork
  (the on-chain write path).

## Not done yet

- Indexer redeploy to create + backfill `muri_tokens` (lights up the badges).
- Base support (PND web/worker/indexer are mainnet-only).
- On-chain thumbnails / custom HTML templates (v1 is fully off-chain).
