# PND Surface: second launch (batch editions) and the reusable release path

The first Surface launch was Homage (surface #1): a pooled collection with a
bespoke minter and a bespoke renderer, wired into the frontend and indexer by
hardcoded per-address entries. That got one project out the door but built no
reusable path.

This is the second launch: an artist ("escape (blue)", working title) shipping
a **sequential collection minted in batches**, each batch a distinct
artwork, every token within a batch sharing that batch's artwork, with a
holder-controlled per-token toggle. The goal here is two things at once:

1. Get this specific release out correctly.
2. Establish the **reusable release path** so launch number three is a config
   entry, not another Homage-style one-off.

Everything below is organized so the reusable pieces are called out as such.

## What the artist is building (confirmed from his contract)

The artist supplied a working renderer contract (`escapeBlue`). Confirmed
properties:

- Implements `tokenURI(address collection, uint256 tokenId)`, the exact
  `IRenderer` signature the Surface core delegates to. Drop-in compatible.
- Returns a standard `data:application/json;base64,...` metadata blob with
  `animation_url` as a `data:text/html;base64,...` document. The generic web
  render path (`getCollectionToken` in `apps/web/src/lib/collection-onchain.ts`)
  reads this with no code changes.
- Audio is already solved onchain: the work bakes an mp3 into EthFS
  (`FileStore`) and serves it as a `data:audio/mp3;base64,...` stem. No external
  asset, no autoplay dependency. Playback is gesture-started (the work has a
  click-to-play `playArea`), so the sandboxed iframe's missing autoplay
  permission does not affect it.
- Holder control: `holderToggleFocMode(tokenId, bool)` flips a per-token mode
  (fully-onchain vs hi-res) behind an `onlyHolder` gate, then calls
  `refreshMetadata` on the token to emit an ERC-4906 refresh.
- His current contract hardcodes a 1..20 token range. For batches this must
  become constructor args (`startId`/`endId`) so each batch's renderer is a fresh
  deployment with its own range, no source edits per batch.

## Architecture: batch editions live entirely in renderer-land

The Surface core has no concept of a "batch". A batch is a range of token ids
that share one renderer. This is consistent with the 2026-07
surface reduction, which moved all presentation data out of the core into
renderer-land. Nothing in the core or factory changes for this launch.

The mechanism is a **render router**: one contract set as the collection's
`cfg.renderer`, holding an ordered list of batches (`startId`, `endId`,
`renderer`, `label`), dispatching each `tokenURI(collection, tokenId)` call to the
renderer whose range contains that id.

```
collection.cfg.renderer = BatchRenderRouter
  batch 0: ids 1..20   -> renderer A (escape blue)
  batch 1: ids 21..40  -> renderer B (next artwork)
  ...
```

### The router is a PND standard contract, deployed per-artist

The artist's original instinct was right: define this once so future artists do
not each invent a different structure. PND authors and reviews one
`BatchRenderRouter` contract; each artist deploys their own instance and owns
it. Renderers stay fully the artist's own code (their art).

Interface the router implements and advertises:

```solidity
interface IBatchRenderRouter /* is IRenderer, IERC165 */ {
    struct Batch { uint256 startId; uint256 endId; address renderer; string label; }

    function addBatch(uint256 startId, uint256 endId, address renderer, string calldata label) external; // owner/admin
    function batchCount() external view returns (uint256);
    function batchAt(uint256 index) external view returns (Batch memory);
    function batchOf(uint256 tokenId) external view returns (Batch memory);

    // tokenURI(address,uint256) from IRenderer: dispatch to batchOf(tokenId).renderer

    // ERC-4906 relay, see gotcha below
    function requestRefresh(uint256 tokenId) external; // registered renderers only
}
```

The router advertises `IBatchRenderRouter` via ERC-165 `supportsInterface`. The
frontend reads a collection's `renderer()`, staticcalls `supportsInterface`, and
if true renders the batch view. No registry, no per-address hardcoding. Any
future batch project lights up automatically.

### Gotcha found in the core: ERC-4906 refresh authority

`SurfaceCore.notifyMetadataUpdate` only accepts calls from `renderer()`,
`owner()`, or an admin (`contracts/src/surface/SurfaceCore.sol:334`). Once the
router is the collection's renderer, a per-batch renderer is **not** `renderer()`,
so the artist's `holderToggleFocMode -> refreshMetadata` path cannot emit the
refresh directly. The router must expose a `requestRefresh(tokenId)` relay,
callable only by its own registered renderers, that forwards to
`ISurfaceCore(collection).notifyMetadataUpdate(tokenId, tokenId)`. Bake this
into the standard router; every batched-renderer project hits the same wall.

## Deploy path: the artist deploys, from a pre-filled site page

Provenance is the artist's throughout. The factory clones the token, so no EOA
is ever the token's direct bytecode deployer (true for Homage too); provenance
is the signer of the create tx plus the `owner` arg plus the `creators` arg. A
site deploy page gives all three while eliminating the struct-transposition risk
that Remix and Etherscan tuple entry carry.

Confirmed: `DeployStep.tsx:134` already calls
`createSurface(name, symbol, address, buildCfg(), buildSale(), creators)` where
`args[2]` is the connected wallet. The artist connects his wallet, so he is the
owner and he signs. `buildCfg`/`buildSale` assemble the structs in TypeScript
with named fields, so there is no positional tuple to transpose.

His case is the RENDERER preset (`cfg.renderer` set to a deployed contract, his
router), which is the working preset. The broken EDITION preset (needs the
mainnet `defaultRenderer`, which is not deployed) is not used.

### Deploy page: editable fields with preset defaults

Not fully hardcoded. A launch descriptor supplies defaults; the artist can edit
any field in the UI before signing.

- **Descriptor** (reviewed object in code, per launch): default name, symbol,
  supply cap, royalty bps, price, mint window, wallet cap, router address,
  creators. Dave fills these from the artist's answers, or leaves site defaults.
- **Form**, grouped: Identity (name, symbol) / Supply (cap) / Economics (price,
  start, end, wallet cap, payout) / Royalty (bps, receiver) / Renderer (router
  address, advanced) / Attribution (creators) / Locks (rendererLocked,
  supplyLocked, advanced, default false).
- **Owner** is not a free field. It is the connected wallet, shown read-only
  ("You will own this collection: 0x..."), with an advanced override only if the
  artist wants a Safe as owner. This is the provenance guarantee; do not let it
  be fat-fingered.
- **Validation** before Deploy enables: renderer address checksum plus a soft
  `code.length > 0` check (the one edit that silently bricks the collection,
  keep it behind an advanced disclosure pre-filled with the router); royalty bps
  <= 5000 (the core's ceiling); ETH-to-wei price parse; start < end.
- **Review card** in plain language before signing: price, quantity and window,
  royalty and receiver, renderer, owner.

This reuses the existing wizard: `ConfigStep` collects most of it, `buildCfg`/
`buildSale` assemble the structs, `DeployStep` signs with the connected wallet.
The work is seeding the form from a descriptor, scoping to the RENDERER preset,
tightening validation, and shipping it as a standalone route. It also clears
prelaunch item T10 (prove the wizard produces a correct, fully wired collection)
for the RENDERER path, so it is progress on the real studio wizard rather than a
throwaway.

## Frontend display: batch view and edition mint layout

Two new pieces, both generic (interface-driven, not per-address hardcoded):

1. **Batch view.** When a collection's renderer advertises
   `IBatchRenderRouter`, show a grid of batch cards (one per batch: its label
   plus that batch's shared artwork, rendered from the batch's `startId`
   tokenURI) instead of the default grid of visually identical tokens. A card
   links to a filtered token list for that batch's id range. Reads the router's
   `batchCount`/`batchAt`/`batchOf`; no new storage.
2. **Edition mint layout.** Homage's page is registry-gated and specific to a
   generative reveal; wrong shape for one-artwork-many-mints. Build a generic
   "edition mint" layout from the existing auction page structure and elements.
   Select it via a light config lookup (collection -> layout kind), not baked
   into the component tree the way `detectHomageMinter` is. The token render
   itself already works through the renderer-agnostic `getCollectionToken` read.

Audio note: the four iframe render spots (`TokenMedia.tsx`,
the collection live route, `TokenPreview.tsx`, `CollectionMosaic.tsx`) use
`sandbox="allow-scripts"` with no `allow="autoplay"`. His work is gesture-started
so this is fine as-is. Only add `allow="autoplay"` (a small uniform change) if a
future work needs sound before a user interaction, and expect the browser to
still gate unmuted autoplay.

## Indexing: canonical minter means zero indexer work

Confirmed in `apps/indexer/ponder.config.ts`: the factory's `SurfaceCreated`
event drives Ponder's `factory(...)` binding, so every collection clone and
every canonical `FixedPriceMinter` clone is indexed automatically, with no
per-collection config. Because this launch uses the canonical `FixedPriceMinter`
(the batching is artwork, not mint economics), it needs **no indexer changes**.

A bespoke minter (Homage's path) would need a hardcoded Ponder entry. Not used
here. Keep it that way unless the artist genuinely needs per-batch pricing that
`FixedPriceMinter`'s owner-settable `setPrice`/`setMintWindow`/`setMaxMints`
cannot express.

## Batches are a mint-economics axis the artist drives himself

One collection, one `createSurface` call. Batching the mint is separate from
batching the artwork:

- Open batch 1 by setting `maxMints` to the batch size (say 20) on the minter.
- When batch 1 sells out, the artist raises `maxMints` for batch 2, deploys the
  next renderer, and calls `addBatch` on his router. All owner transactions from
  his own wallet, from Remix or the site.

## Sepolia: one-time infra, and the deploy rehearsal

No Surface factory exists on any testnet today. Deploy one, once. It is reusable
for every future launch and it is the artist's dress rehearsal.

- Deploy `SurfaceFactory` plus the Sequential/Pooled/`FixedPriceMinter` impls to
  Sepolia (same deploy script, Sepolia RPC, faucet ETH). Skip `DefaultRenderer`
  and `RenderAssets`; not needed for this path.
- Verify on `sepolia.etherscan.io`.
- Add a Sepolia chain entry to `packages/addresses` (currently mainnet only,
  bounded one-file change).
- The deploy page's chain switch points at Sepolia. The artist runs the
  identical create flow on Sepolia first, both parties confirm the collection is
  correctly wired (renderer is the router, owner is the artist, cap is right),
  then flips to mainnet and runs the same flow. Same page, same code path, real
  rehearsal.

This is deliberately not a separate testnet site. It is the production deploy
page pointed at a testnet chain, reached through Netlify's existing PR
deploy-preview.

## Testing: two tracks

1. **Mainnet-fork, engineering verification (free, local).** The artist's
   dependency contracts (his `hiRes`/`foc` engines and the EthFS FileStore) are
   already live on mainnet. Run `anvil --fork-url <public mainnet RPC>` and
   exercise the real router plus renderers plus collection stack against his actual
   live contracts. Zero cost, no real ETH. This is the end-to-end confidence
   check before any real broadcast. Pin a fork block so the RPC cache compounds
   across reruns.
2. **Sepolia plus deploy-preview, artist-facing.** The artist clicks through the
   real wallet-connect and mint UX on a real chain and a real URL. This is what
   "not just running on my local machine" actually requires.

Fork testing proves the bytes work; Sepolia proves the UI works. Do both.

## Mainnet prerequisites (verify before launch day)

- **Factory is paused.** `SurfaceFactory._checkCreatable` gates every create
  path on `paused` (`contracts/src/surface/SurfaceFactory.sol:352`), deployer-
  only to flip. Confirm live state with `cast call <factory> "paused()(bool)"`.
  If still paused, unpausing is a Dave mainnet broadcast under the standing
  mainnet protocol (pre-flight read, decoded confirm, post-flight read), its own
  single confirmation.
- **Factory verified on Etherscan** (mainnet) so the deploy page's ABI and any
  manual fallback work; also on `sepolia.etherscan.io` for the rehearsal. This
  is an existing prelaunch checklist item; confirm it is done.

## Ownership split

- **Artist (his EOA, Remix or Foundry):** deploys his renderer contracts (his art,
  real bytecode) and his router instance; signs `createSurface` from the deploy
  page (owner is his wallet); runs all post-deploy wiring and future batches.
- **PND engineering:** authors and reviews the standard `BatchRenderRouter`;
  builds the Sepolia infra, the seeded deploy page, the batch view, and the
  edition mint layout; writes the fork tests; reviews the artist's contracts.
- **Dave (mainnet broadcasts only):** unpause the factory if needed. Nothing
  else requires Dave's key; the artist signs his own deploy.

## Launch sequence (mainnet, ordered)

Each mainnet broadcast is its own decoded confirmation; nothing is bundled.

1. (Prereq) Factory unpaused and verified on Etherscan.
2. Artist deploys his router instance (his EOA).
3. Artist deploys batch-1 renderer with its `startId`/`endId` (his EOA).
4. Artist calls `addBatch` on the router for batch 1.
5. Artist connects wallet on the deploy page, reviews, and calls `createSurface`
   with `cfg.renderer` = his router. Collection address exists after this,
   owned by him.
6. Post-deploy wiring: the renderer's `setTokenContract(collection)` so the
   holder-toggle refresh path works (easy to forget, it depends on the
   collection address that only exists after step 5). Optional cover image.
7. Open the mint (`setMintWindow` or already open) and do one test mint.
8. Later batches: artist deploys the next renderer, `addBatch` on the router,
   raises `maxMints` on the minter. All his own transactions.

## Still need from the artist

- Final renderer code and audio payload per batch, and dependency list.
- Whether flat price plus window plus wallet cap is sufficient, or per-batch
  pricing is needed (the latter would mean a bespoke minter and indexer work;
  avoid if possible).
- Collection name and symbol, supply cap (open, or a fixed total), first batch
  size. His renderer's current range is ids 1..12.
- Price, royalty bps, royalty and payout addresses.
- Owner wallet address (for the deploy) and creator credit addresses.
- Confirmation the work is gesture-started for audio (his current one is), so no
  iframe autoplay change is needed.

## Reusable outcomes (what launch three inherits)

- `BatchRenderRouter` standard contract plus the `IBatchRenderRouter` interface.
- The seeded, validated deploy page (RENDERER preset), driven by a launch
  descriptor: launch three is a new descriptor entry.
- The interface-driven batch view (any router-backed collection lights up).
- The generic edition mint layout.
- A Sepolia Surface factory for every future rehearsal.
- Progress on prelaunch item T10 (the studio wizard's real launch path).
