# PND Editions media: upload, metadata, and pinning

> **SUPERSEDED (2026-07-06).** The Editions contract was reworked into the
> SovereignCollection system (OZ ERC721 core, four slots, id modes); see
> docs/pnd-collection-system.md and docs/pnd-collection-contracts-plan.md.
> This document describes the pre-rework ERC721A design; payment-split,
> hook, and graph concepts carry over, token-layer specifics do not.
> Contracts now live in contracts/src/collection/ (src/editions/ was
> removed).

> **Status: design exploration, nothing built.** This is the "what should
> we build and why" for the one piece the shipped Editions feature punts
> on: getting an artist's artwork onto IPFS, generating metadata, and
> keeping it pinned. Today the create flow makes the artist paste an
> `ipfs://` URI by hand (`CreateEditionForm.tsx`), with a copy promise
> ("PND can pin it via Preserve") that nothing yet fulfills.
>
> Read `docs/pnd-editions-README.md` for the feature overview,
> `docs/pnd-editions-spec.md` for the contract surface, and
> `docs/pnd-editions.md` for the product rationale. This doc only covers
> media, metadata, and persistence. It changes no contract that is already
> shipped; where it touches the protocol it is additive and optional.

## The one sentence thesis

A crypto-native, mainnet-only, artist-sovereign edition protocol should
let an artist drop in an image, get a real IPFS CID and onchain-generated
metadata, and **pin it to their own account**, because the point of this
thing is to get artists to take responsibility for their own work. PND
never holds the bytes, never pins on the artist's behalf, and never becomes
the safety net. PND's job is to make sovereign pinning easy and to tell the
artist the honest truth about whether their work is actually retrievable.
It reuses the persistence machinery already built for `/preserve` rather
than inventing a second pinning stack, and it does not bolt on a stablecoin
payment rail that fights the ethos.

Everything below serves that sentence. The load-bearing principle, stated
once: **PND does not pin. The artist does.**

---

## 1. Where this sits today (the gap)

The shipped create flow is one transaction: `createEdition(name, symbol,
owner, cfg)` where `cfg.artworkURI` is a string the artist types in.

- **`apps/web/src/components/editions/CreateEditionForm.tsx`** has a free
  text "Artwork URI" input (`placeholder="ipfs://…"`), a help line that
  already says "ipfs:// recommended ... PND can pin it via Preserve", and
  an `OptimizedImage` preview when the string starts with `ipfs://` or
  `https://`. There is no file picker, no upload, no CID generation, no
  pin, and no persistence check. The promise in the copy is unbacked.
- **`contracts/src/editions/PNDDefaultRenderer.sol`** consumes that
  `artworkURI` as the `image` field of an onchain-generated base64 JSON,
  alongside the token's Mint Mark as provenance attributes. So the string
  the artist pastes is treated as an **image URI, not a metadata URI**.
- **`EditionConfig.artworkURI`** is documented as "CID-backed shared art;
  per-token overridable" (`docs/pnd-editions-spec.md` section 1), and the
  contract exposes `setTokenArtwork` / `setTokenArtworkBatch` for per-token
  CID overrides plus a swappable `renderer`.

Three things are missing, in order of how badly they bite:

1. **No upload.** A crypto-native artist who already has a CID is fine. An
   artist who has a PNG on their desktop is stuck: they must go pin it
   somewhere else first, then come back and paste. That is the exact
   friction that makes "anyone can release an edition" untrue.
2. **No metadata generation story made explicit.** It works (the onchain
   renderer is the generator), but the create flow never says so, and
   there is no path for an artist who wants richer metadata than the
   default renderer emits (video, an `animation_url`, extra attributes).
3. **No persistence signal.** Nothing checks that the pasted CID is
   actually retrievable, and nothing records that the artist pinned it. An
   edition can deploy pointing at a CID that is one lapsed pin away from a
   dead image, and neither the artist nor a collector is told. The fix is
   not for PND to pin it; the fix is for PND to make the artist pin it, and
   to show honestly whether they did.

The rest of this doc closes those three, reusing as much of the existing
`/preserve` machinery as possible.

---

## 2. Two metadata models: pin the image vs pin the JSON

This is the first real fork, because it dictates what gets pinned and
whether the contract needs anything new.

### Model A: pin only the image, let the onchain renderer build the JSON (current)

The artist's media (the image) goes to IPFS and its CID becomes
`artworkURI`. `tokenURI(tokenId)` is computed onchain by
`PNDDefaultRenderer`: it returns a `data:application/json;base64,...` blob
whose `image` is `artworkURI` (or the per-token CID override), whose `name`
is `"<edition name> #<tokenId>"`, and whose `attributes` are the live Mint
Mark (Mint Order, Mint Block, Mint Surface, Status at Mint, First/Final).

**What gets pinned:** one image CID per edition. Plus one CID per token
that uses a `setTokenArtwork` override. Nothing else.

**Pros**

- The metadata JSON never needs pinning, because it is generated onchain
  on every read. There is no second file to lose. This is the smallest
  possible persistence surface, and it is fully content-addressed.
- Mint Marks are **live**: `isFinal` flips when the edition closes,
  `Status at Mint` reflects the snapshot, all resolved from chain state at
  read time. A frozen JSON cannot do this.
- It is the entire ERC721A per-token-identity thesis (`docs/pnd-editions.md`
  section 3) expressed in metadata: provenance is computed, not authored.
- Zero contract change. It is what ships.

**Cons**

- The artist does not control the metadata fields. `name`, `description`,
  and the attribute set are fixed by `PNDDefaultRenderer`. No
  `external_url`, no extra traits, no `animation_url`.
- The default renderer emits only `image`. **Video / HTML / 3D media has
  nowhere to go** in the default path, because there is no `animation_url`.
  An animated edition either needs a renderer change (section 7) or Model B.

### Model B: pin a full metadata JSON, point tokenURI at it

The artist (or PND) builds a standard ERC721 metadata JSON (`name`,
`description`, `image`, optionally `animation_url`, `attributes`, ...),
pins **that**, and `tokenURI` returns the JSON's `ipfs://` URI directly.

The shipped default renderer **cannot do this** (it always wraps
`artworkURI` into a freshly built JSON). Model B therefore requires a
renderer that returns an external metadata URI instead of building one. The
contract already supports swapping the renderer (`setRenderer`, the
`renderer` field in `EditionConfig`), so this is a renderer-level change,
not a core-contract change. See section 7.

**Pros**

- Full artist control of every metadata field, including `animation_url`
  for video / HTML / GLB, and arbitrary attributes.
- It is a plain, boring `ipfs://` tokenURI that every marketplace, wallet,
  and indexer ingests without having to understand a base64 data URI.

**Cons**

- **Mint Marks die in the tokenURI.** A static JSON cannot carry a live,
  per-token, chain-resolved Mint Mark. You would either drop provenance
  attributes from the displayed metadata or freeze them at mint time (and
  then they cannot reflect `isFinal` / status changes). The provenance is
  still readable onchain via `mintMarkOf`, but it leaves the metadata that
  collectors and marketplaces actually see. That guts the headline feature.
- **Bigger pinning surface.** Now the JSON must be pinned too, not just the
  media. If the art is unique per token, that is one JSON per token, plus
  one media file per token. Open editions make this unbounded.
- Needs a custom or second built-in renderer (more contract surface for
  collectors to inspect, more for PND to maintain).

### Recommendation: A by default, B as a swappable escape hatch

Keep **Model A as the default and the recommended path**. It is the honest,
onchain, persistence-minimal expression of the protocol's own thesis, and
it ships today. The upload work in section 3 only needs to produce an
**image CID**; the metadata "generation" is the renderer, already onchain,
already free, already unloseable.

Offer **Model B only through the existing renderer swap**, for the artist
who genuinely needs rich or animated metadata. Concretely, PND can ship one
additional, optional, ownerless built-in renderer (a passthrough that
returns the artist's metadata-JSON CID as the tokenURI) so a non-Solidity
artist can opt in by selecting it in the UI, the same way they would point
at their own renderer. This is additive: the default stays Model A; nobody
is forced onto B; the core edition contract does not change. Section 7 has
the renderer detail.

A third, smaller option worth naming: **extend the default renderer to also
carry an `animation_url`** (section 7) so the common "I have a video"
case is served by Model A without anyone touching external JSON. This buys
most of B's media flexibility while keeping live Mint Marks. It is the
single most valuable optional contract-adjacent change in this doc.

---

## 3. Recommended upload + metadata-generation flow

The create form gains an upload affordance; everything else follows from
Model A.

**The artist sees three ways to set the art, in priority order:**

1. **Upload a file** (the new default). Drop or pick an image. The file is
   uploaded straight from the browser to the artist's own pinning account
   (BYO key, section 4), which returns a CID. The form sets
   `artworkURI = ipfs://<cid>` and shows the preview it already renders.
   Metadata generation is nothing the artist does: the onchain renderer is
   the generator (Model A). There is no JSON to build or pin.
2. **Paste a CID / URI** (the existing input, kept as an escape hatch).
   For artists who already have their art on IPFS or Arweave via their own
   pipeline. This is the current behavior, unchanged, never removed.
3. **A persistence check, not a PND pin** (section 4): whichever of the
   above produced the CID, PND verifies it is actually retrievable and
   records the artist's own pin (signed attestation), then shows the artist
   the honest status. PND never adds its own pin.

**Why upload-then-set-`artworkURI`, not upload-a-metadata-JSON:** in Model
A the only artifact that needs to exist before `createEdition` is the image
CID. The deploy transaction is unchanged: it still passes
`cfg.artworkURI`. The upload is a pre-step in the browser, not a new
onchain step, and not a new trusted server. This keeps the create flow's
"one transaction, you own it" property intact.

**Per-token unique art** stays a post-deploy action (`setTokenArtwork`),
exactly as the contract already models it, and the same upload widget
feeds it. Not a v1 UI priority (the design plan defers per-token art UI),
but the upload primitive built here is what unblocks it later.

**Sketch of the create-flow change** (illustrative, not final):

```
[ Artwork ]
  ( • ) Upload image      -> browser uploads to YOUR account -> ipfs://<cid>
  ( ) I already have a CID -> ipfs://… / ar://… (current input)

  status: pinned to your account (4everland)   <- your pin, never PND's
  status: retrievable via public gateway        <- PND's honest check (s.4)
```

The metadata "generated" is the onchain JSON. The doc-level point to make
in the UI: "Your metadata is built onchain by the edition contract on every
read. There is no JSON file to host or lose; you only host the image."

---

## 4. Pinning: the artist's responsibility, not PND's

The governing decision: **PND does not pin editions media.** The goal of
the protocol is to get artists to take responsibility for their own work,
so the only pinning model is the artist's own pin. PND makes that pin easy,
verifies it, and reports it honestly, and stops there. What follows is the
one model that is in, the option rejected on principle, and the option
rejected on fit.

### The model: artist self-pins (in)

The artist's media goes to **their own** pinning account: Pinata,
4everland, Storacha (web3.storage), or Arweave. The bytes go
browser-to-provider; the credential never touches PND. This is **exactly
the `/preserve` model already in the repo** (`apps/web/src/lib/pinning/*`,
the key "stays in your browser ... never touches our servers"), pointed at
upload instead of re-pin.

- **Sovereignty:** total. The pin lives in the artist's account, under
  their billing and their control, and it is their responsibility to keep.
- **Cost / liability to PND:** zero. PND stores nothing, pays nothing, and
  holds no key and no token.
- **Honest cost to the artist:** for most, **free**. 4everland's free tier
  is 6 GB/month and supports upload; Pinata's free tier supports file
  upload (it is only *pin-by-CID* that Pinata gates behind the $20/month
  Picnic plan, which is a `/preserve` re-pin problem, not an upload
  problem). Uploading new bytes is actually cheaper than re-pinning an
  existing CID.

**Lower the friction without lowering the responsibility.** The one real
cost of this model is onboarding: the artist needs an account and a
credential. Two things soften it without PND ever taking custody.

- **The credential is paste-once-per-browser, not per-upload.** The
  existing pinning layer persists the key in `localStorage`
  (`lib/pinning/types.ts`), so a returning artist re-enters nothing.
- **Storacha UCAN delegation is the sovereign "connect" path.** Storacha
  (the web3.storage successor) supports UCAN delegation: the artist owns
  their own storage space and delegates a **scoped, expiring, upload-only**
  capability to PND's browser agent, instead of pasting a long-lived,
  full-power key. The artist still owns the space, the billing, and the
  responsibility; the delegation is revocable and can do nothing but
  upload. This is a real "log in / connect" experience that does **not**
  make PND a custodian, which is exactly why it fits where a full "Connect
  with Pinata" OAuth token would not (an OAuth token that lets PND act on
  the artist's whole account is a server-side secret with custodial reach,
  the opposite of the principle). Adding Storacha as a provider whose
  "connect" is a UCAN delegation is the recommended way to cut onboarding
  friction. (Storacha's *delegation* API is live; this is distinct from its
  legacy *pinning* API, which is in maintenance and `disabled` in
  `PROVIDER_INFO`.)

### Rejected on principle: PND-hosted or PND-backstop pinning

A "PND pins a redundant backup on its own account" option is technically
cheap (one content-addressed image CID per edition, deduplicated globally,
fractions of a cent each) and would remove all onboarding friction. **It is
rejected anyway, on purpose.** The moment PND holds a pin it becomes the
safety net, the artist stops owning the outcome, and the implicit promise
("PND keeps my art") is one PND has no business making. A backstop also
means PND holds a provider key server-side and carries an open-ended storage
liability. The same reasoning rejects the frictionless Storacha flavor where
*PND* owns the space and the artist uploads into it: convenient, but the
data lives in PND's account, which is custody by another name. If the bytes
are not in the artist's account, the artist has not taken responsibility,
and that is the whole point. PND surfaces the truth instead (section 6): if
an artist does not pin, PND shows the art as not retrievable rather than
quietly papering over it.

### Rejected on fit: x402-paid pinning

This only existed as an option because PND might have sold pinning. Since
PND is not in the pinning business at all, there is nothing to charge for
and x402 is moot. The full analysis (and why a stablecoin-on-Base rail would
fight the mainnet-only ethos even if PND did sell pinning) is kept in
section 5 for the record.

### Recommendation

Artist self-pin is the only pinning model. Ship it as: upload to your own
account (BYO key, with Storacha UCAN delegation as the low-friction
sovereign connect), or bring your own CID. PND verifies retrievability,
records the artist's signed pin attestation, and shows the honest status.
PND never pins, never holds a key or token for the artist, and never
promises permanence on the artist's behalf. The artist owns the work and the
responsibility for keeping it alive.

---

## 5. What an x402 integration would actually require (and why not yet)

Because it will come up, here is the real shape of x402 for this use case,
not a hand-wave. There is **zero** x402 code in the repo today (verified);
this would be greenfield.

**What x402 is.** A revival of HTTP `402 Payment Required`: the client
requests a paid resource, the server answers `402` with a machine-readable
list of payment requirements (amount, asset, recipient, network, scheme),
the client returns a signed payment payload in an `X-PAYMENT` header, and
the server verifies and settles it onchain (directly or through a
**facilitator** service) before serving the resource. Coinbase's
implementation settles **USDC on Base** by default, using EIP-3009
(`transferWithAuthorization`) so the payment itself is gasless for the
payer.

**What PND would have to build / run:**

1. **A real paid pinning endpoint.** A server route that uploads bytes (or
   pins a CID) to a PND-held pinning account and returns the CID. This is
   the thing being sold. It implies PND holds a provider key server-side
   and eats the upstream storage cost, then prices above it.
2. **x402 middleware** wrapping that route: emit the `402` with price,
   pay-to address, asset, and network; parse and verify the `X-PAYMENT`
   header on the retry.
3. **A facilitator.** Either depend on Coinbase's hosted facilitator
   (an external dependency in PND's money path, and a Base/USDC coupling)
   or self-host the `verify` + `settle` services (more infra, a funded
   settlement signer, monitoring).
4. **A settlement asset + chain decision** (the crux, below).
5. **Client-side payment construction** in the create flow: the artist's
   wallet must hold the settlement asset and sign the payment authorization.
   That is a new asset the artist must acquire and a new signing step.

**The mainnet-vs-Base tension, stated plainly.** PND Editions is
mainnet-only "by design" (`docs/pnd-editions.md` section 8) and its pricing
thesis is honest ETH, no hidden fee. x402's canonical settlement is **USDC
on Base**. So:

- **Take x402 as-is (USDC on Base):** you import an L2 and a stablecoin
  into a mainnet-only, ETH-denominated protocol. The artist now needs USDC
  on Base to release a mainnet edition. That is a direct contradiction of
  the "mainnet only" hard line and the honest-ETH framing, for the sake of
  a sub-dollar pin. It would be the most off-ethos dependency in the whole
  system.
- **Bend x402 to mainnet:** the `exact` scheme is chain-parameterized in
  principle, so a custom facilitator could verify and settle on Ethereum
  mainnet. But (a) settling a roughly $0.10 to $1 micro-pin with mainnet
  gas of $1 to $20 is economically absurd, the gas dwarfs the good; and
  (b) the gasless EIP-3009 mechanic is a USDC feature, ETH is not an ERC-20
  and cannot `transferWithAuthorization`, so a mainnet-ETH x402 needs a
  different scheme entirely (a deposit-and-debit channel or a prepaid
  balance), which is a payment-channel project, not a middleware drop-in.

**Verdict.** Moot, and a poor fit even if it were not. It is moot because
PND does not sell pinning (section 4): there is no paid endpoint for x402 to
gate. And even if PND ever did, every honest settlement option either breaks
mainnet-only (USDC on Base) or is uneconomic (mainnet gas dwarfs a
sub-dollar pin, and the gasless EIP-3009 mechanic is USDC-only). Kept here
so the decision is not relitigated. The only future worth a second look is
unrelated to pinning-as-a-service: a "PND credits" prepaid balance funded
once in ETH on mainnet, if PND ever sells any metered service at all, which
is its own exploration.

---

## 6. Reusing the existing Preserve / pinning infrastructure

Do not build a second pinning stack. The `/preserve` feature already
contains almost every piece; editions needs one new provider method and a
candidate-query extension. Here is the map and the verb (reuse / extend) for
each piece.

| Existing piece | Where | Editions does |
|---|---|---|
| Provider abstraction `PinningProvider` | `apps/web/src/lib/pinning/types.ts` | **Extend**: add `pinFile(file)` / `pinJSON(obj)` alongside `pinByCid`. This is the only real new code in the pinning layer. |
| `createProvider(type, key)` + concrete providers | `apps/web/src/lib/pinning/{index,pinata,4everland,web3storage}.ts` | **Extend** each with the upload endpoint (`pinFileToIPFS` / `pinJSONToIPFS` for Pinata; equivalents for 4everland). Reuse retry/error handling verbatim. |
| Provider chooser + key entry + validation UI | `components/preserve/{PinningSetup,ProviderSelect}.tsx` | **Reuse** as-is in the create flow. Same BYO-key UX, same "key stays in your browser" guarantee. |
| Pin progress UI | `components/preserve/PinProgress.tsx` | **Reuse** for the upload/pin step. |
| Signed pin attestation | `POST /api/preserve/writeback` + `lib/preserve-writeback.ts` (`buildWritebackMessage`, `isFreshNonce`, `isValidProvider`) | **Reuse verbatim**: after upload, the artist signs the CID set and PND records it. The route already takes `{artist, cids, provider, signature}` and verifies with viem `verifyMessage` (EOA, no RPC). |
| `token_pins` table | `db/migrations/019_token_pins.sql` | **Reuse**: editions image CIDs land here exactly like catalog token CIDs. No schema change. |
| `cid_availability` global probe cache | `db/migrations/018_cid_availability.sql` + worker `tasks/probe-cid-availability.ts` | **Extend the candidate query** to also pull editions `artworkURI` CIDs (and per-token overrides) once editions are indexed; the probe, gateways, dedup, and 7-day cadence are unchanged. Content addressing means an edition CID already referenced elsewhere is already probed. |
| Preservation read-back | `lib/dependency-check.ts:getPreservationSummary` | **Reuse** the same join (`retrievableCount` / `unretrievableCount` / `unprobedCount` over `cid_availability`, overlaid with `token_pins`) to render a preservation badge on the edition page and token page. |
| CID + gateway helpers | `@pin/shared` (`extractCid`, `extractBareCid`, `ipfsToHttp`, `fetchFromIpfs`, `IPFS_GATEWAYS`) and `lib/metadata-host.ts` (`classifyUrl`) | **Reuse**: classify and normalize the edition's `artworkURI`, resolve it for OG/preview, key it for the availability cache. `pnd-editions.ts` already has a local `ipfsToHttp`; consolidate onto `@pin/shared` rather than keep a second copy. |

**The one genuinely new thing** is `pinFile` on the provider interface.
Everything else is reuse or a query extension. That is the whole point:
the persistence half of this feature is mostly already written, for
`/preserve`, and editions should ride it.

**The two integration seams to get right:**

1. **Probe candidate source.** `probe-cid-availability.ts` pulls CIDs from
   `token_metadata` for known-artists' tokens. Editions media is **not** in
   `token_metadata` (an edition's `tokenURI` is an onchain data URI; the
   image CID lives in the contract's `artworkURI`). So feeding editions
   into the availability signal means: once editions discovery/indexing
   lands (the deploy-gated `pnd_editions_index` table in
   `docs/pnd-editions-integration.md` step 4), `UNION` its `artworkURI`
   CIDs into the probe's candidate CTE. Pre-deploy or pre-index, the create
   flow can seed the new CID directly for an immediate first probe.
2. **Known-artist gating.** The availability probe is gated on
   `known_artists` (the spend ceiling). PND edition deployers already
   auto-promote into `known_artists` via the integration runbook's
   `pnd_editions.owner` UNION, so editions CIDs are in scope for probing
   without widening the ceiling. Good: no new RPC exposure.

---

## 7. Contract / renderer changes

**For the recommended path (Model A + artist self-pin): none required.**
The upload, the artist's own pin, the attestation, and the availability
probe are all off-chain or web/worker work. `artworkURI` is already the
right field; the default renderer already generates metadata;
`setTokenArtwork` already exists for per-token art. The shipped contracts
are sufficient.

**Optional, additive, in rough priority:**

1. **`animation_url` in the default renderer (recommended optional).** Add
   an optional animation/media URI so Model A serves video / HTML / GLB
   without forcing Model B. Two shapes:
   - lightest: a second optional field on `EditionConfig` (e.g.
     `animationURI`) plus a per-token override mirroring `setTokenArtwork`,
     emitted as `animation_url` by `PNDDefaultRenderer`; or
   - renderer-only: a new built-in renderer variant that reads an extra
     media slot. Either keeps live Mint Marks. This is the highest-value
     optional change because "I have a video" is common and the current
     default silently cannot express it.
2. **A passthrough metadata renderer for Model B (optional).** A second
   ownerless built-in `IPNDRenderer` whose `tokenURI(tokenId)` returns the
   artist's external metadata-JSON CID (a single shared
   `ipfs://<cid>`, or a `ipfs://<base>/<tokenId>.json` convention). Lets a
   non-Solidity artist opt into full external metadata by selecting it in
   the UI and calling `setRenderer`, with no bespoke contract. Note loudly
   in the UI that choosing it **drops live Mint Marks from the tokenURI**
   (they remain readable via `mintMarkOf`). Additive; the default is
   untouched.

Neither optional change alters the core `PNDEditions` contract's mint,
split, Mint Mark, graph, or path logic, and neither is required to ship the
upload + pinning flow. They are about *media type breadth*, not about the
pinning architecture this doc is mainly deciding.

---

## 8. RPC and cost discipline

Per PND's standing "minimize RPC" rule, the notable property of this whole
design is that **it adds almost no RPC load**:

- Upload and pin are provider-API calls (Pinata / 4everland HTTP), not RPC.
- The availability probe is gateway HTTP `HEAD`, not RPC, and is a global
  content-addressed cache refreshed every 7 days, shared across all
  artists.
- The pin attestation verifies an EOA signature with viem `verifyMessage`,
  which does not hit an RPC (the route deliberately skips the ERC-1271 path
  to avoid RPC spend).
- The only chain interaction the create flow adds is the `createEdition`
  deploy transaction the user already signs.

So the feature is RPC-light by construction, which is a cost virtue in its
own right.

**Honest cost summary**

- **Artist self-pin:** free for most (4everland 6 GB/month free; Pinata
  free-tier upload; Storacha free tier via UCAN delegation). Paid only if
  they exceed free tiers or want Arweave permanence.
- **PND:** zero pinning cost, because PND does not pin. PND holds no
  provider account for editions media and carries no storage liability.
- **Arweave option:** a one-time permanence fee (historically a few dollars
  per GB) if an artist wants pay-once-store-forever; an artist choice, not
  the default, and it adds a non-IPFS dependency the availability probe
  already understands (`extractArweaveId`, Arweave gateways in the probe).
- **x402 paid pinning:** moot (section 5); PND sells no pinning.

---

## 9. Risks and tradeoffs

1. **The responsibility model excludes the least technical artists, by
   design.** With no PND backstop, an artist who will not set up any pinning
   account cannot persist their work, and PND will not do it for them. This
   is an accepted consequence of "the artist takes responsibility", not a
   bug. Mitigate the friction, never the responsibility: Storacha UCAN
   delegation as a low-friction sovereign connect (section 4), paste-a-CID
   for those with a pipeline, and clear guidance. The honest failure mode is
   that some art will not be persisted; PND's answer is to show that plainly
   (risk 2), not to rescue it.
2. **Some editions will point at art that rots, and that has to be visible,
   not hidden.** Because PND never pins, an artist who lapses their pin ends
   up with a dead image, and PND must not paper over it. The mitigation is
   the honest mirror (section 6): show "not retrievable" when the gateway
   probe fails, and "artist-pinned at X" only when attested, so a collector
   sees the real persistence state before minting. The risk is reputational
   (dead art under a PND-surfaced edition); the only honest defense is
   transparency plus nudging the artist to fix their own pin via
   `/preserve`.
3. **Self-declared pins can lie.** `token_pins` is self-attested (the key
   never leaves the browser, so PND cannot confirm with the provider). This
   is already true in `/preserve` and already mitigated: `cid_availability`
   (worker gateway probe) is the corroborating ground truth. Editions
   inherits both the risk and the existing mitigation unchanged.
4. **Model B guts Mint Marks.** If an artist opts into the passthrough
   renderer for rich metadata, the live provenance leaves the tokenURI.
   Mitigated by making B opt-in, loud about the tradeoff, and never the
   default. The `animation_url` option (section 7) exists precisely so most
   artists never need B.
5. **Open editions multiply per-token media.** If per-token art ever gets a
   UI on an uncapped edition, the pinning and probe surface grows per token.
   The design plan already nudges artists toward capped/time-boxed editions
   (`docs/pnd-editions.md` section 9.2); per-token art should carry the same
   nudge, and the probe's known-artist gating bounds the blast radius.
6. **Gateway upload variance.** Different providers return CIDs with
   different CID versions / wrapping (a directory-wrapped file vs a raw
   file). The upload layer must normalize to the CID that actually
   addresses the bytes the renderer will point at, and verify retrievability
   before the deploy. `extractBareCid` + a single post-upload gateway
   `HEAD` (the same check the probe does) covers this; do it before letting
   the artist deploy.

---

## 10. Open questions

1. **Storacha UCAN delegation in v1, or BYO key only?** UCAN delegation is
   the lowest-friction sovereign connect and the main lever for the
   onboarding problem (risk 1). Decide whether v1 ships it alongside the
   Pinata / 4everland key-paste path or defers it. (It uses Storacha's
   delegation API, which is live, not the legacy pinning API that is in
   maintenance and `disabled` in `PROVIDER_INFO`.)
2. **`animation_url` now or later?** It is the highest-value optional
   contract-adjacent change. Decide whether v1 of this feature is
   images-only (ship upload + pinning, defer video) or includes the default
   renderer's media slot. The pinning work is identical either way; only
   the renderer differs.
3. **Verify-before-deploy hard gate or soft warning?** Should a failed
   post-upload retrievability check *block* `createEdition`, or just warn?
   Recommendation: warn, never block (the artist owns the contract and may
   know something the gateway does not), but make the warning prominent so
   the artist owns the consequence with eyes open.
4. **Per-token art UI scope.** Out of scope for this doc, but the upload
   primitive built here is what unblocks it. Confirm it stays deferred.

---

## 11. Phased build plan

Each phase is independently shippable and verifiable. Nothing here touches
the shipped, tested edition contracts on the critical path.

**Phase 1: upload primitive (web, BYO key).** Add `pinFile` (and
`pinJSON`, for future Model B) to `PinningProvider` and the concrete
providers, reusing their retry/error handling. Unit-test against each
provider's upload endpoint. No UI yet. This is the only substantial new
code.

**Phase 2: create-flow upload UX.** Wire the upload primitive into
`CreateEditionForm`: file picker, BYO-key reuse of `PinningSetup` /
`ProviderSelect`, set `artworkURI` from the returned CID, post-upload
retrievability check (gateway `HEAD` via `fetchFromIpfs`/`extractBareCid`),
keep the paste escape hatch. Verify end to end against the existing
`pnpm dev:editions` fork + the Playwright harness (deploy an edition whose
art was uploaded, assert the tokenURI image resolves).

**Phase 3: attestation reuse.** After a successful upload/pin, have the
create flow sign the CID set and POST to the existing
`/api/preserve/writeback`, recording the pin in `token_pins`. No new route.

**Phase 4: availability + preservation surface (the honest mirror).** Extend
`probe-cid-availability`'s candidate query to include editions CIDs (gated
on the editions discovery table once it exists; seed directly pre-index),
and render the `getPreservationSummary`-based preservation badge on the
edition and token pages: "retrievable via gateway" and "artist-pinned at X"
when attested, "not retrievable" when the probe fails. No "backed up by PND"
line, because PND does not back it up.

**Phase 5 (optional): media breadth.** If decided in open question 2, add
the default renderer's `animation_url` slot (a contract/renderer change, its
own Foundry tests) and/or the passthrough metadata renderer for opt-in
Model B.

Phases 1 to 4 are the feature. Phase 5 is media-type breadth and is gated on
a product decision, not on the pinning architecture.

---

## Appendix: what is reused vs new

**Reused verbatim:** `PinningSetup`, `ProviderSelect`, `PinProgress`,
`POST /api/preserve/writeback`, `lib/preserve-writeback.ts`, `token_pins`
(019), `cid_availability` (018), `getPreservationSummary`, `@pin/shared`
IPFS helpers, `metadata-host.ts` `classifyUrl`.

**Extended:** `PinningProvider` + concrete providers (add `pinFile` /
`pinJSON`, and a Storacha UCAN-delegation provider); `probe-cid-availability`
candidate query (UNION editions CIDs); `CreateEditionForm` (upload affordance
+ honest persistence status).

**New:** (optional) default-renderer `animation_url` slot; (optional)
passthrough metadata renderer. No PND pinning account, no backstop pin, no
PND-held key or token: PND does not pin.

**Declined:** PND-hosted / backstop pinning (rejected on principle: PND is
not the safety net); x402 paid pinning and any USDC/Base settlement
dependency (PND sells no pinning).
