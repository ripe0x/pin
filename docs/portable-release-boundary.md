# Portable release boundary

> **Status: canonical W1.1 specification**
> **Version: manifest v1 design**
> **Updated: 2026-08-31**

This document defines the boundary shared by PND, an artist-controlled site,
and future release embeds. It is the implementation contract for the planned
`@pin/release-spec`, `@pin/surface-kit`, and `@pin/surface-react` packages.

The boundary exists to make this statement mechanically true:

> Minting, current release state, deterministic rendering, and transaction
> recovery can work without a PND API, database, image proxy, account, or
> authentication service.

Indexed history, prepared media, identity enrichment, and PND editorial context
are useful optional providers. Their absence must reduce context, never break a
release's core render or transaction path.

## 1. Boundary rules

1. The manifest identifies a release and carries artist-authored context. It
   does not serialize mutable chain state as timeless truth.
2. The core provider resolves mutable state from the release's contracts with
   bounded live reads. It never imports PND application code.
3. Historical activity comes from an optional history provider. Independent
   interfaces do not reconstruct wallet or token history on page load.
4. Canonical media URIs remain visible even when a prepared delivery asset is
   unavailable.
5. PND editorial data is a separate overlay. It cannot be signed or presented
   as an artist declaration.
6. Unknown required capabilities fail closed. Unknown optional capabilities
   are ignored and reported as unavailable.
7. A custom minter or renderer is supported only through an explicit adapter.
   Generic UI never guesses a write function or calldata shape.
8. The artist template consumes published shared packages. It does not vendor
   another editable copy of protocol behavior.

## 2. Truth and control classes

The four public truth classes remain the program-wide classes. Manifest control
fields are not public claims and become public only after the relevant provider
resolves them.

| Data | Class | Rule |
| --- | --- | --- |
| Live owner, minter authorization, renderer, supply, price, window, minted count | Protocol fact | Resolve from contracts and attach block context. Never take the current value from the manifest. |
| Mints, sales, bids, ownership history | Indexed observation | Include source, observed time, coverage, finality, and partial state. |
| Title, statement, declared schedule, selected media, optional site URL | Artist declaration | Attribute to the signer. A signature proves endorsement at a time, not permanent control of a site. |
| Featured status, PND essay, homepage order, launch-program label | PND editorial decision | Keep in a separate PND overlay and label it as PND-authored. |

The following manifest fields are machine control data rather than claims:

- schema identifier and version;
- chain namespace and collection locator;
- ABI compatibility identifier;
- required and optional capability identifiers;
- adapter identifiers and declared adapter targets.

A collection locator is not proof that the contract is a Surface collection.
The core provider must validate the factory or compatible interface before a UI
presents Surface-specific facts or enables a transaction.

## 3. Release manifest v1

### 3.1 Shape

All addresses and hashes serialize as lowercase hex. All chain integers and
token quantities serialize as base-10 strings. Times serialize as UTC RFC 3339
strings. Optional keys are omitted rather than written as `null` unless the
schema explicitly defines `null` as a state.

```ts
type ReleaseManifestV1 = {
  spec: "pnd.release"
  version: 1

  release: {
    id: string
    chain: {
      namespace: "eip155"
      reference: string
    }
    collection: `0x${string}`
    protocol: {
      family: "surface"
      abi: string
      factory?: `0x${string}`
    }
  }

  declaration: {
    artist: `0x${string}`
    title: string
    summary?: string
    statement?: string
    process?: string
    announcedSchedule?: {
      opensAt?: string
      closesAt?: string
      note?: string
    }
    media?: {
      cover?: PortableMediaRef
      hero?: PortableMediaRef
      process?: PortableMediaRef[]
      social?: PortableMediaRef[]
    }
    links?: ArtistLink[]
  }

  presentation?: {
    layout?: "default" | "edition" | "generative" | "custom"
    theme?: {
      accent?: string
      background?: string
      foreground?: string
      font?: string
    }
    aspectRatio?: string
  }

  capabilities: {
    required: string[]
    optional?: string[]
    adapters: ReleaseAdapterBinding[]
  }

  extensions?: Record<string, unknown>
  authorship?: ManifestAuthorshipV1
}

type PortableMediaRef = {
  uri: string
  mediaType?: string
  sha256?: string
  width?: number
  height?: number
  alt?: string
}

type ArtistLink = {
  label: string
  url: string
}

type ReleaseAdapterBinding = {
  capability: string
  adapter: string
  target: "collection" | "primary-minter" | "collection-renderer" | `0x${string}`
  config?: Record<string, unknown>
}

type ManifestAuthorshipV1 = {
  scheme: "eip712"
  signer: `0x${string}`
  issuedAt: string
  digest: `0x${string}`
  signature: `0x${string}`
}
```

### 3.2 Field semantics

- `release.id` is a stable portable identifier. For Surface v1 it is
  `pnd:<chainId>:<lowercase collection>:c`.
- `release.chain` is explicit so no consumer guesses mainnet from an address.
- `release.collection` is the token contract, including for a pooled or
  custom-minter release such as Homage.
- `release.protocol.abi` identifies the minimum compatible ABI family, not a
  mutable package version. The initial value is `surface@1`.
- `release.protocol.factory` is optional compatibility evidence. A provider
  may validate it when present, but current collection behavior still comes
  from the collection.
- `declaration` and `presentation` are artist-authored. They are public only
  when signed or when an assembly labels them as an unsigned local draft.
- `announcedSchedule` is communication, not the sale switch. A transaction UI
  always uses the live minter window and calls out any disagreement.
- `PortableMediaRef.uri` is canonical. A provider may prepare a faster asset,
  but must preserve the canonical reference beside it.
- `capabilities.adapters` names executable behavior. An address target from the
  manifest is validated live before use, including `isMinter(target)` for a
  custom Surface minter.
- `extensions` keys must be reverse-domain or package-qualified, for example
  `wtf.ripe.homage`. Core readers preserve unknown extension data but do not
  execute it.
- Secrets, API keys, bearer tokens, private subscriber data, database URLs,
  and PND session material are invalid manifest content.

### 3.3 What is deliberately absent

The manifest does not contain current price, minted count, remaining supply,
ownership, live lifecycle, current renderer, current primary minter, indexed
history, featured status, or PND copy. Those values change independently of an
artist declaration and belong to providers or overlays.

Export bundles may include separate point-in-time artifacts:

- `observed-release.json`, an indexed snapshot with coverage and finality;
- `editorial.json`, a PND-authored overlay;
- prepared media files and social assets;
- deployment configuration with secrets represented only as variable names.

Those artifacts never merge into `release.json` during import.

### 3.4 Serialization and validation

1. Parse as UTF-8 JSON with duplicate keys rejected.
2. Reject unknown top-level keys other than `extensions` for version 1.
3. Normalize addresses and hashes to lowercase before hashing.
4. Reject JSON numbers for chain identifiers, token quantities, prices, block
   numbers, and timestamps. Their schema representation is a decimal or RFC
   3339 string.
5. Sort and deduplicate capability arrays and adapter bindings by capability
   before hashing.
6. Canonicalize with RFC 8785 JSON Canonicalization Scheme.
7. Hash the canonical unsigned manifest with `keccak256`.
8. Preserve the original imported bytes separately when provenance matters;
   consumers operate on the validated normalized object.

`authorship.digest` must equal the digest of the manifest with `authorship`
omitted. A mismatch is invalid, not merely unsigned.

### 3.5 Artist signature

Manifest authorship uses EIP-712 on the manifest's chain:

```text
domain:
  name: PND Portable Release
  version: 1
  chainId: <manifest chain>

ReleaseManifest:
  artist: address
  collection: address
  manifestDigest: bytes32
  issuedAt: uint64
```

The recovered signer must equal `declaration.artist`. A valid signature means
that address endorsed the normalized declaration at `issuedAt`. It does not by
itself prove that the signer owned the collection then or owns it now. The core
provider reports live owner/admin facts separately.

An unsigned manifest is valid only as a private Studio draft or an explicitly
labelled local configuration. PND public artist-authored copy requires a valid
signature or a separately recorded artist-authorized source with equivalent
provenance.

## 4. Artist-provided site declaration

A destination changes more often than release copy, so it is signed separately
and may be revoked without replacing the release manifest.

```ts
type ArtistSiteDeclarationV1 = {
  spec: "pnd.artist-site"
  version: 1
  chain: { namespace: "eip155"; reference: string }
  artist: `0x${string}`
  url: string
  collections?: `0x${string}`[]
  kit?: { name: string; version: string }
  issuedAt: string
  expiresAt?: string
  nonce: string
  signature: `0x${string}`
}
```

Its EIP-712 payload covers artist, URL hash, collections hash, kit hash,
issuedAt, optional expiresAt, and nonce. Public copy says **Artist-provided
site**. A compatibility probe may report only current observations such as
“resolved on 2026-08-31” and “referenced collection 0x…”. It must not say PND
verified ownership, independence, permanence, or continued control.

For v1, `urlHash` is `keccak256(utf8(url))`. `collectionsHash` is the keccak256
of the RFC 8785 canonical JSON array after lowercase address normalization,
deduplication, and sorting. `kitHash` is the keccak256 of the canonical JSON
kit object, or canonical JSON `null` when omitted. `expiresAt` is zero when
omitted; timestamps enter the typed payload as Unix seconds while their full
normalized RFC 3339 values remain in the signed declaration input.

## 5. Capability negotiation

Capability identifiers are lowercase, versioned strings. Initial core IDs are:

```text
surface.state@1
surface.quote@1
surface.mint@1
surface.render.token@1
surface.render.preview@1
surface.reveal@1
surface.referral@1
history.mints@1
history.sales@1
history.bids@1
history.ownership@1
identity.ens@1
media.prepared@1
editorial.pnd@1
```

Adapter IDs are similarly versioned. The first generic adapters are expected
to be `surface.fixed-price@1`, `surface.renderer@1`, and
`surface.transfer-reveal@1`. Custom releases register an explicit adapter ID;
Homage is the required acceptance case for a custom minter that must not be
misrepresented as generic fixed-price support.

Negotiation produces one state per requested capability:

```ts
type CapabilityState =
  | { status: "supported"; adapter: string }
  | { status: "unsupported"; reason: string }
  | { status: "unavailable"; reason: string; retryable: boolean }
  | { status: "partial"; reason: string; available: string[] }
  | { status: "incompatible"; reason: string }
```

Rules:

- Unknown required capability: the release is incompatible; do not enable its
  primary action.
- Unknown optional capability: omit that enhancement and keep the core page.
- Known adapter with failed live validation: unavailable or incompatible, not
  a guessed fallback.
- A higher manifest version may be read only when its declared required
  capabilities are all understood. Otherwise preserve the file and render a
  clear compatibility message.
- A custom adapter may add UI slots, but wallet writes still pass through the
  shared prepared-transaction and error contracts.

## 6. Provider contracts

Every provider returns a typed state rather than `null` with ambiguous meaning.

```ts
type ProviderResult<T> =
  | { status: "available"; value: T; evidence: Evidence }
  | { status: "partial"; value: T; missing: string[]; evidence: Evidence }
  | { status: "unavailable"; reason: string; retryable: boolean }
  | { status: "unsupported"; reason: string }

type Evidence = {
  truth: "protocol" | "indexed" | "artist" | "editorial"
  source: string
  observedAt?: string
  blockNumber?: string
  finalizedThrough?: string
  coverage?: {
    fromBlock?: string
    throughBlock?: string
    complete: boolean
    gaps?: string[]
  }
}
```

### 6.1 Core release provider

```ts
interface CoreReleaseProvider {
  validateRelease(ref: ReleaseRef, signal?: AbortSignal): Promise<ProviderResult<ValidatedRelease>>
  readState(release: ValidatedRelease, account?: Address, signal?: AbortSignal): Promise<ProviderResult<ReleaseState>>
  quoteMint(input: MintQuoteInput, signal?: AbortSignal): Promise<ProviderResult<MintQuote>>
  prepareMint(input: PrepareMintInput, signal?: AbortSignal): Promise<ProviderResult<PreparedTransaction>>
  readToken(input: TokenReadInput, signal?: AbortSignal): Promise<ProviderResult<TokenState>>
  prepareRender(input: RenderInput, signal?: AbortSignal): Promise<ProviderResult<RenderDocument>>
  resolveReveal(input: RevealInput, signal?: AbortSignal): Promise<ProviderResult<RevealResult>>
}
```

This provider owns current collection/minter/renderer reads, lifecycle
derivation, price and quantity calculation, referral validation, transaction
preparation, deterministic render assembly, and post-mint reveal extraction.
Its default implementation uses an injected EVM client. It cannot import a PND
database client, PND route, PND media proxy, or PND authentication module.

`PreparedTransaction` is declarative: chain, target, ABI identifier, function,
arguments, value, and human-readable effects. Wallet libraries remain outside
the kernel. The React layer submits it and maps receipt progress through shared
states.

### 6.2 History provider

```ts
interface ReleaseHistoryProvider {
  listMints(input: HistoryPageInput): Promise<ProviderResult<HistoryPage<MintRecord>>>
  listSales(input: HistoryPageInput): Promise<ProviderResult<HistoryPage<SaleRecord>>>
  listBids(input: HistoryPageInput): Promise<ProviderResult<HistoryPage<BidRecord>>>
  listOwnership(input: OwnershipInput): Promise<ProviderResult<OwnershipRecord>>
}
```

History is optional and cursor-paginated. Results carry source, coverage,
finalized-through block, observed time, and gaps. An independent interface may
use PND's public provider, another indexer, or no history provider. It must not
replace missing history with request-time log scans.

### 6.3 Identity provider

```ts
interface IdentityProvider {
  resolve(address: Address): Promise<ProviderResult<PortableIdentity>>
}
```

Identity is optional presentation context such as ENS and an artist-authored
profile. Wallet role is not inferred. Provider failure falls back to the full
address.

### 6.4 Media provider

```ts
interface MediaProvider {
  resolve(ref: PortableMediaRef): Promise<ProviderResult<ResolvedMedia>>
}
```

The result always preserves the canonical URI. A prepared URL is an optional
delivery asset with its own status, dimensions, media type, integrity, and
expiry. Image, video, HTML, loading, unavailable, and failed states remain
distinct. PND's image proxy is one implementation, never a core requirement.

### 6.5 Editorial provider

```ts
interface EditorialProvider {
  getRelease(releaseId: string): Promise<ProviderResult<EditorialReleaseContext>>
}
```

Editorial context is optional and PND-authored. It may select, order, and add
essays or launch-program context. It cannot override protocol facts, artist
declarations, or the complete permissionless record.

## 7. Refresh and cost contract

The direct-chain core is narrow by design:

- validate a release once per manifest/address change;
- read collection and current minter state through bounded multicalls;
- cache immutable ABI and stored render dependency content;
- refresh visible mutable state no tighter than one Ethereum block and, for
  paid public RPC fallbacks, no tighter than 12 seconds by default;
- re-quote immediately before a write when price can move;
- never poll token history, enumerate wallets, or fetch every token URI;
- page token grids explicitly and render only visible work;
- abort superseded reads and bound transport timeouts;
- allow an assembly to substitute static exported state for first paint, then
  reconcile the small live state required for a transaction.

The package extraction adds no recurring infrastructure. Public npm packages,
repository CI, user-supplied RPC configuration, and existing PND providers fit
the program's $0 target. Any later managed RPC or hosted media addition needs a
measured cost note and remains subject to the $10/month approval ceiling.

## 8. Package boundaries

```text
@pin/abi + @pin/addresses
              ↓
      @pin/release-spec
              ↓
       @pin/surface-kit
              ↓
      @pin/surface-react
              ↓
apps/web | artist template | future embeds
```

### `@pin/release-spec`

Owns schemas, normalized types, canonical serialization, digests, signature
payloads, capability identifiers, and truth-class containers. It imports no
React, wagmi, RPC, database, filesystem, or PND application module.

### `@pin/surface-kit`

Owns pure lifecycle/quote/referral/error behavior, adapter contracts, provider
interfaces, direct-chain core provider, render document assembly, immutable
content caching, transaction preparation, and reveal parsing. It may depend on
`viem` and the lower packages. It imports no React, wagmi, Next.js, Postgres,
PND API client, or PND application alias.

### `@pin/surface-react`

Owns headless hooks and accessible primitives for state, quantity, quote,
wallet readiness, transaction progress, errors, preview loading, and reveal.
It depends on the kit and uses React plus wallet bindings as peer dependencies.
PND and the template may style and compose these primitives differently, but
may not reimplement their state machines.

### Assemblies

`apps/web` provides Postgres history, PND editorial context, prepared media,
PND referral configuration, and venue composition. `templates/artist-page`
provides artist configuration, artist referral defaults, optional independent
providers, and artist styling.

The shared packages are published publicly. The standalone artist-template
repository pins their exact released versions; monorepo CI tests that release
against the workspace source before sync. Editable vendored copies are removed.

## 9. Current source ownership map

| Current source | Future owner | Treatment in W1.2 |
| --- | --- | --- |
| `packages/abi/**`, `packages/addresses/**` | Existing lower packages | Keep; expose only stable protocol identifiers needed above. |
| `apps/web/src/lib/collection.ts` lifecycle, config, referral, error-free helpers | `@pin/surface-kit` | Split pure protocol behavior from PND env, link, and formatting helpers. |
| `apps/web/src/lib/collection-onchain.ts` live state, quote, preview, token reads | Core provider plus PND server adapter | Move bounded direct reads into the provider; keep Postgres/cache assembly in `apps/web`. |
| `apps/web/src/lib/collection-render/{build,resolve,seed,types}.ts` | `@pin/surface-kit` | Make the current Scripty/injection implementation one tested owner. |
| `apps/web/src/lib/collection-render/TokenPreview.tsx` | `@pin/surface-react` | Consume the shared render result and explicit loading/error state. |
| `templates/artist-page/lib/collection-render/**` | Remove | Replace the vendored copy with the published kit. PR #277 is the short-term repair, not the final owner. |
| `apps/web/src/components/collections/MintCollectionCTA.tsx` | Kit state machine + React primitives + PND assembly | Extract lifecycle, quote-before-write, referral, prepared write, receipt, error, and reveal behavior. Keep venue copy and layout in the app. |
| `templates/artist-page/components/CollectionMintCard.tsx` | Shared React primitives + artist assembly | Replace stale direct-collection mint assumptions; default referral to the artist. |
| `templates/artist-page/lib/{surface,collection,mint-transaction}.ts` | Remove or reduce to configuration | Current code targets the removed direct-mint/config shape. The core provider becomes its source of behavior. |
| `apps/web/src/lib/{mint-collections,mint-phases,mint-registries}.ts` and `mint-modules/**` | Release spec adapter declarations plus kit adapter registry | Keep custom behavior explicit; migrate Homage as the acceptance custom adapter. |
| `apps/web/src/components/tx/tx-ui.tsx` | Pure error mapping in kit; accessible progress UI in React package | Keep PND styling and explorer links in the assembly. |
| `apps/web/src/lib/launch-descriptors.ts` | Artist declaration/import input, later manifest-backed | Do not treat deploy-form defaults as live release state. |
| `apps/web/src/content/releases.json` | PND editorial overlay | Keep separate from the portable manifest. |
| `apps/web/src/lib/media.ts` and media routes | PND media provider | Preserve canonical URIs; do not import into the core. |

PRs #277, #280, and #282 modify inputs to this map. W1.2 starts only after
W0.1 selects and integrates the shipping Surface UI work, then resolves these
paths once.

## 10. Required behavior matrices

### 10.1 Parity matrix

The same fixtures run against the PND and artist-template assemblies:

| Scenario | Required result |
| --- | --- |
| Sequential fixed-price Surface | Same lifecycle, quantity, quote, prepared minter call, value, referral split, receipt, and reveal. |
| Gas-only release | Label as gas only; send zero value; never call it free. |
| Dynamic price strategy | Same live quote and immediate pre-write re-quote behavior. |
| Scheduled, open, ended, capped, and sold-out states | Same derived primary-action state and boundary timestamps. |
| Allowlist and wallet cap | Same eligibility result, calldata, and decoded errors. |
| Pooled/custom-minter Homage | Generic fixed-price capability reports unsupported; the explicit Homage adapter supplies the valid quote/write/reveal path. |
| Sequential and pooled token IDs | Never apply sequential enumeration assumptions to pooled releases. |
| Renderer with and without `previewURI` | Same supported or unsupported capability result, never a broken preview. |
| Cached image, video, HTML, missing media | Same loading, ready, unavailable, and failed state semantics. |
| Wrong network, rejected wallet, changed price, cap reached mid-transaction | Same recovery category and next action. |

### 10.2 PND-offline matrix

With DNS/network access to every PND hostname blocked, the artist template must
still:

- validate the configured collection through its RPC;
- show artist-authored release copy from the local manifest;
- read current supply, lifecycle, and price;
- render deterministic work and canonical media without the PND proxy;
- connect a wallet, switch network, quote, prepare, and submit a mint;
- send the configured artist/referrer address;
- show transaction progress, decoded failure, success, and reveal;
- link to the collection and transaction through configurable explorers.

Expected reductions are limited to PND history, PND identity enrichment, PND
prepared media, and PND editorial context. Each renders a quiet typed reduced
state rather than an empty spinner or broken component.

### 10.3 Compatibility matrix

| Input | Result |
| --- | --- |
| v1, all required capabilities known | Full supported path. |
| v1, unknown optional capability | Core path plus an unavailable enhancement. |
| v1, unknown required capability | Incompatible release; no transaction button. |
| Future manifest version, v1-compatible required set | Parse preserved v1 fields and report reduced compatibility. |
| Future manifest version, unknown required set | Preserve file, show incompatibility, do not guess. |
| Valid signature, live owner differs | Show artist declaration by signer and current owner as separate facts. |
| Invalid digest/signature | Reject authorship; never present declaration as signed. |
| Site resolves but lacks expected collection | Report failed compatibility observation only. |
| Optional provider partial or stale | Show coverage/freshness and keep the core path. |

## 11. Acceptance examples

The implementation fixtures use real protocol shapes, not preview dummy data:

1. A live sequential Surface release using the canonical fixed-price minter.
2. Homage to the Punk at
   `0xd938ff57d2c7111880a4ea5c8e6a92796c72a76e`, represented as a pooled
   collection with an explicit custom-minter adapter. The generic fixed-price
   capability must not be claimed for it.
3. A Scripty renderer fixture checked byte-for-byte against the current
   injection convention.
4. The same template release with PND endpoints blocked.

Synthetic addresses remain acceptable inside isolated unit tests. They are not
acceptance evidence for rendering, indexing, media, performance, or cost.

## 12. W1.2 extraction order

After W0.1 resolves the overlapping Surface PRs:

1. create `@pin/release-spec` with v1 validation, canonicalization, signatures,
   capabilities, and fixtures;
2. create the provider result and core adapter contracts in
   `@pin/surface-kit`;
3. move pure lifecycle, quote, referral, error, transaction, reveal, and render
   behavior behind those contracts;
4. add the direct-chain Surface fixed-price adapter and the explicit Homage
   custom adapter fixture;
5. create shared React state primitives without moving final page layouts;
6. make PND consume the shared packages;
7. make the artist template consume the published packages and delete vendored
   behavior;
8. run parity and PND-offline CI before any public activation.

No blocking design question remains for W1.2. Exact package publishing and
standalone-template sync commands belong in the W1.2 work packet because they
depend on the integrated repository state, not on this boundary.
