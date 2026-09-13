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

Plus one shared change, in scope for the diff:

- `contracts/src/surface/templates/ScriptyRenderer.sol` — `_contextJs` and
  `_attributes` changed from `private` to `internal virtual` so a chain-live
  fork can extend them. Additive; base behavior and `ExampleScriptyWork`
  unchanged (full suite green). Confirm no behavioral change to existing
  subclasses.

## Out of scope

- Surface core / factory / **`FixedPriceMinter`** (separately audited protocol;
  this work uses the stock minter unmodified via `createSurface`).
- ScriptyBuilderV2 (`0xD758…F022`) and EthFS (`0x8FAA…3245`) — external,
  deployed, widely used; trusted dependencies.
- `works/anton/anton.js` — the artwork (client-side render), not a contract.

## Key invariants

1. `AntonRenderer.tokenURI` / `previewURI` never mutate state and never revert
   for a minted token (owner read is try/catch).
2. Palette/tone traits are derived from the seed exactly as `anton.js` derives
   them (`palette = seed % 10`, `tone = (seed >> 8) % 2`) — a mismatch is a
   correctness bug (traits disagree with the render), not a security one.
3. No field injected into the rendered JSON/HTML can break out of its string
   context (all injected values are numeric or hex; `name` is `escapeJSON`'d by
   the base).
4. `AntonScriptStore` is immutable; `getContent` ignores `name` (single file).

## Specific items to review

- **`AntonRenderer`** JSON/HTML assembly for injection safety across all injected
  fields; the seed→trait derivation matching the JS; and that the inherited
  `previewURI` (not faithful for this chain-live work) can't mislead — it returns
  a document with owner defaulted to zero for a nonexistent id.
- **`AntonScriptStore`** immutability and correct SSTORE2 round-trip of the
  base64 payload.
- The `ScriptyRenderer` visibility change (additive `virtual`).

## Deployment shape (for context)

`AntonScriptStore` and `AntonRenderer` (wired to scripty + EthFS gunzip, no
deps) share one deploy step, `AntonDeploy.deployAntonRenderer`, used by all
three anton scripts in `contracts/script/`:

- `AntonDeploy.sol`, a shared abstract helper, not run directly. Deploys
  `AntonScriptStore` from `script/anton.js.gz`, then `AntonRenderer` bound to
  scripty, EthFS gunzip, and a caller-supplied `RenderAssets` address.
- `DeployAntonRenderer.s.sol`, the mainnet step. Deploys the store and
  renderer only. The artist then creates the collection from their own
  wallet in the studio, pasting the renderer address, then calls `addAdmin`
  for the deployer; the admin configures `RenderAssets` (capturer, cover) and
  locks the renderer.
- `DeployAntonWork.s.sol`, the local/rehearsal path. Deploys the store and
  renderer, then calls `createSurface` directly so a fork or testnet run
  produces a full collection in one step.
- `SwapAntonRenderer.s.sol`, which repoints an existing collection at a
  freshly deployed store and renderer, for a render-code update after launch.

Mainnet sequence: `DeployRenderModules.s.sol` deploys the `RenderAssets`
singleton once (or reuses an existing one) → `DeployAntonRenderer.s.sol`
deploys the anton store and renderer against it → the artist creates the
collection in the studio with the renderer address → the artist grants the
deployer (or configurer) admin via `addAdmin` → the admin runs
`ConfigureAntonAssets.s.sol` to grant a capturer and set the cover on
`RenderAssets`, then locks the renderer. Proven end to end on a mainnet fork
and on sepolia (`works/anton/DEPLOYMENTS.md`).
