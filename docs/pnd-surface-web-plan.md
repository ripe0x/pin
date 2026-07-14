# Surface System: web/offchain implementation plan

> Companion to `docs/pnd-surface-system.md` (sections 5 and 8.4) and
> `docs/pnd-surface-contracts-plan.md` (the contracts side, built on
> branch `collection-contracts-v1`, PR #133). This plan covers the
> web app, worker, indexer, packages, and artist template. Branch:
> `collection-web-v1`, stacked on the contracts branch; rebase onto
> main after #133 squash-merges.

## Ground truth (recon findings that shape the plan)

- The web app has ZERO references to the new contracts. Everything
  (routes, components, `pnd-editions.ts`, `editions-onchain.ts`,
  `@pin/abi`, `@pin/addresses`, `dev:editions`, the artist template's
  vendored addresses) still targets the deleted PNDEditions pair.
- The editions surfaces are clean 1:1 analogs for the rework:
  `CreateEditionForm` (two-step wagmi write + parseEventLogs),
  `MintEditionCTA`, `editions-onchain.ts` (server-only viem multicall
  reads behind `pgCache`), `lib/pnd-editions.ts` (decoders + env
  override + `getAddressOrNull` gating).
- **The generic mint surface is NOT in this tree.** It lives on the
  unmerged `generic-mint-surface` branch (Homage launch). Descriptor
  integration for collections is DEFERRED until that branch merges;
  the overview doc's "deployed and done" line for it is corrected to
  say so. Collection mint UI ships on its own pages meanwhile.
- The indexer's `factory()` pattern (used for SovereignAuctionHouse)
  is the sanctioned shape for PND-owned factory contracts; the
  collection factory gets the same, deploy-gated on a real address.
- The worker has no image tooling today; capture is a fresh
  capability (sharp for SVG rasterize; headless browser is an infra
  decision, gated).
- `TokenMedia` already renders untrusted `animation_url` HTML in a
  sandboxed iframe (web + template); the preview component follows
  that precedent.

## Deliverables

### D1. Packages: ABI + addresses sync

`scripts/emit-surface-abi.mjs` following the existing emit-script
convention; new `@pin/abi` exports: `collectionAbi`,
`collectionFactoryAbi`, `attributionAbi`,
`generativeRendererAbi`, plus a minimal hand-written
`scriptyStorageAbi` (createContent/addChunkToContent/getContent) for
studio uploads. `@pin/addresses`: `SOVEREIGN_COLLECTION_FACTORY`,
`ATTRIBUTION`, `GENERATIVE_RENDERER`, `DEFAULT_RENDERER` (zero-address
sentinels until mainnet deploy), plus the real mainnet
`SCRIPTY_BUILDER_V2` / `SCRIPTY_STORAGE_V2` / `ETHFS_V2_FILE_STORAGE`
constants. The stale `pndEditions*` ABIs remain until D5 retires their
consumers, then are deleted.

### D2. Local dev harness: `pnpm dev:collections`

Rework of `scripts/dev-editions.sh` (currently broken: it deploys the
deleted `DeployEditions.s.sol`): deploy `DeploySurfaceSystem.s.sol`
on the anvil mainnet fork (chain id 31339; the fork means the REAL
scripty/EthFS contracts are present, so generative preview works
against true onchain deps), parse factory + attribution + renderer
addresses into `.env.development.local`, keep the impersonation flow.
The old script name becomes an alias or is removed.

### D3. Parity render library (the keystone)

`apps/web/src/lib/collection-render/`: a pure implementation of
`docs/injection-convention.md` v1. Builds the token HTML document from
(WorkConfig, tokenData, content resolver): gunzip helper when needed,
deps, `window.tokenData` injection, artist code, identical tag order
to GenerativeRenderer. Content resolvers: raw bytes (studio preview of
not-yet-uploaded scripts) and chain reads (scripty storage
`getContent` via the existing cached public client). Plus
`TokenPreview` component: sandboxed iframe (TokenMedia pattern)
rendering a built document via srcdoc, with a test-seed generator.
Parity is verified in D8 by comparing against the real
`tokenURI` output on the fork.

### D4. Web data layer

`lib/collection.ts` (client-safe: enums, config/mark/work
decoders mirroring `CollectionTypes.sol`, lifecycle + pricing helpers,
factory address resolution with `NEXT_PUBLIC_SOVEREIGN_COLLECTION_FACTORY`
override) and `lib/collection-onchain.ts` (server-only pgCache reads:
getCollection, getCollectionToken incl. tokenSeed + workConfig +
tokenURI, mint history via marks multicall, recent collections via
factory, attribution roster + catalog intersection). Same shape as the
editions libs they replace.

### D5. Public pages + editions retirement

`/collections/[address]` and `/collections/[address]/[tokenId]`:
reworked ports of the editions detail/token pages onto D4, with mint
CTA (`mintWithRewards`, PND surface address), live-price display for
strategy collections, withdraw panel, graph view, attribution roster
display (confirmed = roster AND catalog claim), and token pages
rendering `animation_url` through the sandboxed TokenMedia. `/editions*`
routes become redirects; stale editions components and the e2e
`globalSetup` fixture are reworked; `pndEditions*` ABIs deleted at the
end of this deliverable.

### D6. Studio: create-collection tool

Registry entry (`create`, gated on `getAddressOrNull(FACTORY)` or the
dev env override) + `app/studio/[address]/create/`. A preset wizard:

1. **Edition preset**: port of CreateEditionForm onto the factory
   (config, optional 0xSplits payout, optional collab roster via the
   factory's Attribution wiring).
2. **Generative preset**: adds script upload with chunked
   `ScriptyStorageV2` writes (createContent + addChunkToContent,
   ~16KB chunks), dependency selection (known onchain gzipped libs:
   p5, three + gunzip), work config assembly (CodeRefs, liveness,
   injectionVersion, renderParams), and the D3 test-seed preview
   before deploy.
3. **Renderer-native (SVG) preset**: custom renderer address + empty
   work config.

Deploy via `createCollection` in one tx; parse the event for the
address; route to the new collection page.

### D7. Periphery (each deploy-gated where it touches prod data)

- **Indexer**: `CollectionFactory` entry in
  `ponder.config.ts` using the `factory()` pattern (the
  SovereignAuctionHouse precedent), handlers for
  SurfaceCreated/Minted/Burned into new `ponder` tables; excluded
  from config while the address is the zero sentinel.
- **Capture worker**: new task scaffold; v1 implements the SVG
  rasterize path only (sharp) for `image`-less tokens; the headless
  HTML capture path is scaffolded behind `CAPTURE_HTML=1` WITHOUT
  adding a browser dependency yet; adding playwright/puppeteer to the
  Railway worker image is an explicit infra decision left open.
- **Artist template**: `CollectionMintCard` + token grid reading an
  env-configured collection address, vendored collection ABI + a
  vendored copy of the parity builder, following the template's
  existing vendoring convention and TokenMedia sandbox.

### D8. End-to-end verification

On `pnpm dev:collections` (fork): create an edition and a generative
collection through the studio (real scripty storage writes against the
forked mainnet contracts), mint through the public page, verify the
token page renders the animation, and verify D3 parity: the preview
document and the onchain `tokenURI` document match for the same seed.
Playwright e2e fixtures updated to the new flow.

## Sequencing

D1 and D2 are unblocked and parallel. D3 follows D1. D4 follows D1.
D5 follows D4. D6 follows D2 + D3 + D4. D7 items follow D1
independently. D8 last, gating the PR.

## Deferred, with reasons

- Mint-surface descriptor integration: until `generic-mint-surface`
  merges (avoid forking the Homage launch's in-flight system).
- Headless HTML capture: infra decision (browser in the worker image).
- Prod indexer/worker enablement, Netlify env, template address sync:
  deploy-gated on mainnet addresses.
- Studio Catalog auto-claim batching in the create flow: nice-to-have
  once the base wizard is stable.
