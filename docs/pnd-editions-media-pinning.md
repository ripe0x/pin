# PND Editions media: upload, metadata, and pinning

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
metadata without trusting PND with their files or their money, and lean on
the persistence machinery PND already built for `/preserve` rather than
inventing a second pinning stack or bolting on a stablecoin payment rail
that fights the ethos.

Everything below serves that sentence.

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
3. **No persistence guarantee.** Nothing checks that the pasted CID is
   actually retrievable, nothing pins it redundantly, and nothing records
   that it was pinned. An edition can deploy pointing at a CID that is one
   lapsed pin away from a dead image.

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
3. **Pin-on-deploy backstop** (section 4's hybrid): whichever of the above
   produced the CID, PND offers to add a redundant pin on its own account
   and to record the pin, so the art survives a lapsed artist pin.

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
  ( • ) Upload image      -> browser uploads via BYO key -> ipfs://<cid>
  ( ) I already have a CID -> ipfs://… / ar://… (current input)

  [x] Also pin a backup copy on PND (recommended)   <- section 4 hybrid
```

The metadata "generated" is the onchain JSON. The doc-level point to make
in the UI: "Your metadata is built onchain by the edition contract on every
read. There is no JSON file to host or lose; you only host the image."

---

## 4. Pinning and who pays

Three models, evaluated against PND's ethos (sovereignty, mainnet-only,
honest costs) and against what is already built.

### Option 1: Artist self-pins (BYO key, or bring a CID)

The artist supplies their own pinning provider key (Pinata, 4everland,
Storacha/web3.storage, or Arweave), the file goes browser-to-provider, the
key never touches PND. This is **exactly the `/preserve` model already in
the repo** (`apps/web/src/lib/pinning/*`, key "stays in your browser ...
never touches our servers"), just pointed at upload instead of re-pin.

- **Sovereignty:** maximal. The pin lives in the artist's account, under
  their billing, forever theirs.
- **Cost / liability to PND:** zero. PND stores nothing, pays nothing, and
  holds no key.
- **Honest cost to the artist:** for most, **free**. 4everland's free tier
  is 6 GB/month and supports upload; Pinata's free tier supports file
  upload (it is only *pin-by-CID* that Pinata gates behind the $20/month
  Picnic plan, which is a `/preserve` re-pin problem, not an upload
  problem). So the upload path is actually *cheaper* for artists than the
  existing re-pin path: uploading new bytes is on the free tier where
  re-pinning an existing CID often is not.
- **Friction:** the artist needs an account and a key. That is real
  friction for a first-time releaser, and it is the reason Option 1 alone
  is not enough.

### Option 2: x402-paid pinning (PND charges per pin)

PND runs a paid pinning endpoint and the artist pays per-pin over x402 (the
HTTP 402 "Payment Required" protocol, with onchain stablecoin settlement).
Detailed in section 5. Short version: it introduces a stablecoin and, in
its canonical form, an L2 (USDC on Base) into a protocol whose entire
identity is mainnet-only and ETH-honest. It is the wrong tool for this
audience right now. **Recommended against for v1**, documented so the door
stays open.

### Option 3: Hybrid (PND pins a redundant backstop by default; artist always owns the primary)

PND pins the edition's image CID on its **own** pinning account as a
**redundant** copy, in addition to (never instead of) the artist's pin or
CID. The artist's pin is the primary; PND's is a backstop so the art does
not die if the artist's key or plan lapses.

- This is cheap and bounded in a way general media hosting is not, for the
  same reason `cid_availability` is a single global cache (migration 018):
  **content addressing**. One edition is one image CID. The same CID
  referenced by many editions or many artists is pinned once. A redundant
  PND pin of one image per edition, deduplicated globally, is fractions of
  a cent per edition per month on 4everland-class infrastructure. Thousands
  of editions is single-digit dollars per month. PND can absorb this
  without charging, and without an x402 rail.
- It is the same `pinByCid(cid)` call the worker and `/preserve` already
  make, against a PND-held key kept server-side (the one place a key
  legitimately lives server-side, because it is PND's own account, not the
  artist's).
- The pin is recorded the same way `/preserve` records artist pins, so the
  preservation badge (section 6) can show "artist-pinned at X" and
  "also backed up by PND" and "retrievable via public gateway" as three
  independent signals.

### Recommendation: tiered, with hybrid as the default safety net

Ship them as a ladder, not a choice the artist has to understand:

1. **Default:** artist self-pins via BYO key (Option 1), reusing the
   `/preserve` provider stack extended for upload. This is the
   architecturally correct default for a sovereignty-first protocol.
2. **Escape hatch:** bring your own CID (paste), unchanged.
3. **Safety net, on by default, opt-out:** PND adds a redundant backstop
   pin of the image CID on its own account (Option 3) and records it. The
   artist keeps the primary pin; PND guarantees the art does not silently
   vanish. This is the honest version of "PND pins by default": PND is not
   the custodian, it is the backup.
4. **Explicitly not in v1:** x402-paid pinning (Option 2).

This ladder means a first-time artist with no pinning account can still
release (PND's backstop pin carries them, and they can add their own pin
later via `/preserve`), while a sovereignty-maximalist artist can bring
their own CID and decline the PND backup. Both are honest about who holds
what, and neither depends on a stablecoin.

The one liability this creates for PND is the backstop pin's storage cost
and the implied (not promised) durability. Bound it honestly in copy: "a
redundant backup, not a permanence guarantee; pin it yourself for
permanence," and cap/monitor the PND pinning account. The cost analysis
above says the bound is small.

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

**Verdict.** x402 is a poor fit for paying for pins in *this* protocol
*right now*. The audience is small, the per-pin cost is sub-dollar, the
hybrid backstop (section 4) makes paid pinning unnecessary for the common
case, and every honest settlement option either breaks mainnet-only or is
uneconomic. Revisit only if (a) PND wants a real paid storage tier at
volume, and (b) a mainnet-native, ETH-settled, near-gasless micropayment
rail exists, or PND accepts a "PND credits" prepaid balance funded once in
ETH on mainnet and debited off-chain per pin (which is a cleaner fit than
x402 and worth its own exploration if paid pinning ever becomes a goal).

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

**For the recommended path (Model A + self-pin/hybrid): none required.**
The upload, the BYO-key pin, the backstop pin, the attestation, and the
availability probe are all off-chain or web/worker work. `artworkURI` is
already the right field; the default renderer already generates metadata;
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

So the feature is RPC-light by construction, which is both a cost virtue
and a reason the hybrid backstop pin is affordable without a paid rail.

**Honest cost summary**

- **Artist self-pin:** free for most (4everland 6 GB/month free; Pinata
  free-tier upload). Paid only if they exceed free tiers or want Arweave
  permanence.
- **PND backstop pin:** fractions of a cent per edition per month
  (one content-addressed image CID, globally deduplicated). Single-digit
  dollars per month at thousands of editions. No per-pin charge to anyone.
- **Arweave option:** a one-time permanence fee (historically a few dollars
  per GB) if an artist wants pay-once-store-forever; an artist choice, not
  the default, and it adds a non-IPFS dependency the availability probe
  already understands (`extractArweaveId`, Arweave gateways in the probe).
- **x402 paid pinning:** declined (section 5). The cost it would recover is
  smaller than the ethos cost it would impose.

---

## 9. Risks and tradeoffs

1. **BYO-key friction excludes the least technical artists.** Mitigated by
   the hybrid backstop (a keyless artist can still release; PND's pin
   carries the art) and by keeping paste-a-CID for those with a pipeline.
   The residual: an artist who neither has a key nor a CID is leaning
   entirely on PND's backstop, which is a backup, not a guarantee. Say so.
2. **The PND backstop pin is a soft promise.** If PND pins it, artists may
   read that as "PND keeps my art forever." It does not; it is redundancy.
   This is a copy and expectation-management risk more than a technical
   one. Frame it as "backup, not permanence; pin it yourself to be sure,"
   and reuse `/preserve` as the place an artist goes to own their pin.
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

1. **Backstop default on or off?** Recommendation: on by default, opt-out,
   because a silently dead image is the worse failure. Confirm PND is
   willing to hold a pinning account and its (small, bounded) cost.
2. **Which provider does PND's backstop use, and where does its key live?**
   Recommendation: 4everland-class free/cheap tier, key server-side in the
   worker or an API route (PND's own account, the one legitimate
   server-side key). Decide single-provider vs redundant double-pin for the
   backstop itself.
3. **`animation_url` now or later?** It is the highest-value optional
   contract-adjacent change. Decide whether v1 of this feature is
   images-only (ship upload + pinning, defer video) or includes the default
   renderer's media slot. The pinning work is identical either way; only
   the renderer differs.
4. **Verify-before-deploy hard gate or soft warning?** Should a failed
   post-upload retrievability check *block* `createEdition`, or just warn?
   Recommendation: warn, never block (the artist owns the contract and may
   know something the gateway does not), but make the warning prominent.
5. **Per-token art UI scope.** Out of scope for this doc, but the upload
   primitive built here is what unblocks it. Confirm it stays deferred.
6. **Storacha / web3.storage revival.** It is `disabled` in `PROVIDER_INFO`
   (maintenance mode). If/when its API returns, the upload extension should
   cover it; no design change, just a provider implementation.

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

**Phase 4: hybrid backstop pin.** Add the PND-account redundant pin (server
side, PND-held key) of the edition image CID on deploy, opt-out in the UI,
recorded alongside the artist's attestation. Bound and monitor the PND
pinning account.

**Phase 5: availability + preservation surface.** Extend
`probe-cid-availability`'s candidate query to include editions CIDs (gated
on the editions discovery table once it exists; seed directly pre-index),
and render the `getPreservationSummary`-based preservation badge on the
edition and token pages ("retrievable via gateway", "artist-pinned at X",
"backed up by PND").

**Phase 6 (optional): media breadth.** If decided in open question 3, add
the default renderer's `animation_url` slot (a contract/renderer change,
its own Foundry tests) and/or the passthrough metadata renderer for opt-in
Model B.

Phases 1 to 5 are the feature. Phase 6 is media-type breadth and is gated
on a product decision, not on the pinning architecture.

---

## Appendix: what is reused vs new

**Reused verbatim:** `PinningSetup`, `ProviderSelect`, `PinProgress`,
`POST /api/preserve/writeback`, `lib/preserve-writeback.ts`, `token_pins`
(019), `cid_availability` (018), `getPreservationSummary`, `@pin/shared`
IPFS helpers, `metadata-host.ts` `classifyUrl`.

**Extended:** `PinningProvider` + concrete providers (add `pinFile` /
`pinJSON`); `probe-cid-availability` candidate query (UNION editions CIDs);
`CreateEditionForm` (upload affordance).

**New:** the PND backstop-pin server action and its account; (optional)
default-renderer `animation_url` slot; (optional) passthrough metadata
renderer.

**Declined:** x402 paid pinning, and any USDC/Base settlement dependency.
