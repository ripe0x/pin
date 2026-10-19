# anton work — audit scope

The anton work is a **fully generative** onchain Surface collection: everything
about a token derives from its seed. It is also **chain-live** — the render
reads the current owner to drive a wallet-synced animation *timing* (not the
image content). The image evolves over time but is not owner-mutable. Minting,
pricing, and payments use the **stock, already-audited `FixedPriceMinter`**; this
work adds no minter and no per-token storage.

## In scope

`contracts/src/surface/works/anton/`

| Contract | Role | Surface |
| --- | --- | --- |
| `AntonRenderer.sol` | chain-live `ScriptyRenderer` fork | view-only `tokenURI` / `previewURI` |
| `AntonScriptStore.sol` | SSTORE2 store serving `base64(gzip(anton.js))` | immutable, `getContent` |

Plus shared changes, in scope for the diff:

- `contracts/src/surface/templates/ScriptyRenderer.sol` — `_contextJs` and
  `_attributes` changed from `private` to `internal virtual` so a chain-live
  fork can extend them. Additive; base behavior and `ExampleScriptyWork`
  unchanged (full suite green). Confirm no behavioral change to existing
  subclasses.
- `contracts/src/surface/templates/ScriptyRenderer.sol` — a `MetadataText`
  struct (token description, collection description, external URL) added to
  the constructor, stored once with no setter. `tokenURI` includes
  `description`/`external_url` and `contractURI` includes
  `description`/`external_link` only when the corresponding field is
  non-empty. `AntonRenderer` forwards the struct unchanged. Values are read
  from `contracts/script/anton-metadata.json` at deploy time (`AntonDeploy`).
  These constructor values are now the defaults; a per-collection override in
  `RenderAssets` takes precedence when set (next bullet).
- `contracts/src/surface/renderers/RenderAssets.sol` — added per-collection
  metadata copy (`tokenDescriptionOf` / `collectionDescriptionOf` /
  `externalUrlOf`) with an owner-or-admin `setText` setter (`onlySurfaceAdmin`,
  else `NotSurfaceAdmin`) and a `TextSet` event, so the copy is editable after
  deploy. `ScriptyRenderer` reads it through new `internal virtual` resolvers
  (`_resolveTokenDescription` / `_resolveCollectionDescription` /
  `_resolveExternalUrl`) that default to the constructor value; `AntonRenderer`
  overrides them to prefer the `RenderAssets` value when non-empty, else the
  default. `tokenURI` / `contractURI` were restructured to build the JSON
  incrementally with scoped locals (stack limit); output bytes are unchanged
  (full suite green). Confirm the auth is collection owner/admin only and that
  an empty override falls back to the baked default.
  `setText` emits from RenderAssets, not the collection. Token metadata can be
  refreshed through `notifyMetadataUpdate`; the existing Surface core has no
  collection-level notification for later text edits. While the renderer is
  unlocked, setting the same renderer again emits `ContractURIUpdated`; after
  lock, marketplace collection-copy refresh requires marketplace tooling.

## Out of scope

- Surface core / factory / **`FixedPriceMinter`** (separately audited protocol;
  this work uses the stock minter unmodified via `createSurface`).
- ScriptyBuilderV2 (`0xD758…F022`) and EthFS (`0x8FAA…3245`) — external,
  deployed, widely used; trusted dependencies.
- `works/anton/anton.js` — the artwork (client-side render), not a contract.

## Key invariants

1. `AntonRenderer.tokenURI` / `previewURI` never mutate state and never revert
   for a minted token (owner read is try/catch).
2. Palette, Mode and Flow traits are derived from the seed exactly as `anton.js`
   derives them (`palette = seed % 10`, `mode = (seed >> 8) & 1`,
   `flow = (seed >> 16) & 1`) — a mismatch is a correctness bug.
   `tokenURI` attributes are exactly Palette, Mode and Flow; `AntonRenderer`
   overrides the base's Mint Order and Seed provenance traits and does not
   publish them.
3. No field injected into the rendered JSON/HTML can break out of its string
   context. The render-context fields (hash, tokenId, collection, chainId,
   version, context, owner) are numeric or hex. `name` and the artist-supplied
   metadata text (token description, collection description, external URL) are
   `escapeJSON`'d by the base.
4. `AntonScriptStore` is immutable; `getContent` ignores `name` (single file).

## Specific items to review

- **`AntonRenderer`** JSON/HTML assembly for injection safety across all injected
  fields; the seed→trait derivation matching the JS; that `_attributes` emits
  exactly Palette, Mode and Flow; and that the inherited `previewURI` (not faithful
  for this chain-live work) can't mislead — it returns a document with owner
  defaulted to zero for a nonexistent id.
- **`AntonScriptStore`** immutability and correct SSTORE2 round-trip of the
  base64 payload.
- The `ScriptyRenderer` visibility change (additive `virtual`).
- The `ScriptyRenderer` metadata-text constructor addition: escaping of the
  token description, collection description, and external URL; that each
  field is set once with no setter; and that `AntonDeploy` reads them from
  `script/anton-metadata.json` rather than an env var. The current file holds
  artist-supplied defaults; owner/admin can override them through RenderAssets.

## Deployment shape (for context)

`AntonScriptStore` and `AntonRenderer` (wired to scripty + EthFS gunzip, no
deps) use the same `AntonDeploy` helpers in local rehearsal and live deployment:

- `AntonDeploy.sol`, a shared abstract helper, not run directly. Creates
  `AntonScriptStore` from `script/anton.js.gz`, then `AntonRenderer` bound to
  scripty, EthFS gunzip, and a caller-supplied `RenderAssets` address. Metadata
  text (token description, collection description, external URL) is read from
  `script/anton-metadata.json`. It rejects a `RenderAssets` deployment that
  lacks the editable-text getters, before a new renderer can be deployed.
- `DeployAntonStore.s.sol` and `DeployAntonRenderer.s.sol` each broadcast one
  deployment transaction. The artist then creates the collection from their own
  wallet in the studio, pasting the renderer address, then calls `addAdmin`
  for the deployer; the admin configures `RenderAssets` (capturer, cover) and
  locks the renderer.
- `DeployAntonWork.s.sol`, the local/rehearsal path. Deploys the store and
  renderer, then calls `createSurface` directly so a fork or testnet run
  produces a full collection in one step.
- `SwapAntonRenderer.s.sol`, which broadcasts only `setRenderer` for an
  already-deployed renderer on an unlocked collection.
- `SetAntonText.s.sol`, which reads `script/anton-metadata.json` and broadcasts
  one owner/admin `RenderAssets.setText` transaction.

Mainnet sequence: deploy a `RenderAssets` with editable-text getters → deploy
the Anton store → deploy the renderer against both → the artist creates the
collection in the studio with the renderer address → the artist grants the
deployer (or configurer) admin via `addAdmin` → the admin runs
`ConfigureAntonAssets.s.sol` to grant a capturer and set the cover on
`RenderAssets`, then locks the renderer. The earlier build was exercised on a
fork and Sepolia; the current build needs a new rehearsal before release.
