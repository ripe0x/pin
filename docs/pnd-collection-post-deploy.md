# PND Collection System: post-deploy work

> **What this is.** The list of everything deliberately deferred past the
> immutable mainnet deploy, so none of it gets forgotten. Nothing here
> gates the contract deploy — that gate is the external re-audit
> (`pnd-collection-reaudit-notes.md`). Items are ordered by when they
> bite. Written 2026-07-13; check items off or move them to issues as
> they start.

## At deploy (launch mechanics, same day)

- [ ] **Fill `contracts/deployments.mainnet.json`** with the factory and
  singleton addresses, then `pnpm generate:docs` — the generator
  currently flags `collectionFactory` as an unresolved placeholder and
  will stamp the reference docs with real addresses once filled.
- [ ] **Run the launch runbook end-to-end on a fork first**:
  `DeployCollectionSystem.s.sol` → project renderer → collection →
  `mint` → `tokenURI` renders. The studio create wizard exists but is
  unverified; scripts are the launch path.

## Immediately after deploy: discovery indexing

The one product gap that makes minted collections invisible on
pnd.ripe.wtf. It is post-deploy **by necessity, not neglect**: Ponder
subscribes by address, and the factory address only exists once
deployed. Nothing is lost by waiting — `CollectionCreated` events are
permanent, and Ponder backfills the full history from the factory's
deploy block whenever the subscription lands.

- [ ] **Prep before deploy (cheap, do it now-ish):** write the Ponder
  handler with the address parameterized, so enablement on deploy day is
  a two-line config change. This is the blessed fixed-contract Ponder
  case per `AGENTS.md` — one factory, one event, never a long tail.
- [ ] Add the factory to `apps/indexer/ponder.config.ts` (start block =
  deploy block) with a `CollectionCreated` handler writing the
  collections table web reads.
- [ ] Wire the web discovery surfaces to that table (they currently have
  no live source), and the studio's "your collections" list.
- [ ] Worker: nothing new needed at first — collection tokens render
  onchain (`tokenURI` is a view), and the mint surface uses cached live
  reads. Extend per-token enrichment only if a real page needs it.

## Studio follow-ups

- [ ] **Surface the admin list during ownership transfer.** The accepted
  contract behavior (reaudit notes, Change 1) is that `_admins` survives
  `transferOwnership` — the new owner inherits the old operator's keys.
  The agreed mitigation is product-side: any transfer flow shows the
  current admin roster loudly so both parties see who still holds keys.
- [ ] Verify the create wizard end-to-end before opening studio deploys
  to artists (it shipped unverified; launch used scripts).

## First HTML-generative drop (gates that drop, not the SVG launch)

Design: `pnd-collection-thumbnails.md`. The contract side (RenderAssets
cover/captures/template/capturer) is shipped; this is the offchain half.

- [ ] Client-side capture util in the parity render lib: grab the canvas
  from the render iframe, encode PNG per the canonical capture spec,
  hand bytes to the upload flow (Irys→Arweave one-time by default).
- [ ] Studio "capture cover" step at deploy (it is already rendering the
  preview; capture one frame, upload, `setCover`).
- [ ] Mint-surface per-token capture at mint (PND pays the one-time
  upload where it earned the share).
- [ ] Studio backfill page: list capture-less tokens from the indexer →
  render client-side → upload frames → publish manifest → one
  `setCaptureTemplate` tx. Consider a capturer-key flow so automation
  never holds an admin key.
- [ ] Mirror the capture spec into `injection-convention.md` v2.

## Preservation

- [ ] **MURI operator adapter** (`ripe0x/pin#138`). Registration is
  proven against live MURI (`MuriIntegrationFork.t.sol`: the owner
  passes the `isAdmin` gate directly); what remains is the small adapter
  contract MURI calls as operator (supportsInterface + isTokenOwner via
  ERC721 ownerOf + a permissioned forwarder for initializeTokenData /
  addArtworkUris), then grow the fork test into the full green path
  register → initializeTokenData → getThumbnailUris.

## Additive modules (deployable any time, each opt-in per collection)

None of these touch deployed collections — that is the point of the
slot architecture. Each is a small singleton + tests + a studio surface.

- [ ] **HookChain**: compose N mint hooks (allowlist + wallet cap
  together currently needs custom code; the core has one hook slot).
- [ ] **Signed-mint hook**: EIP-712 gate with an artist-held signer, for
  dynamic allowlists with no merkle re-roots. Copy SeaDrop's
  `SignedMintValidationParams` bounds idea so a leaked signer key is
  bounded in what it can authorize.
- [ ] **DropMinter**: stage-rich drops (concurrent phases, per-stage
  price/caps, payer delegation) as ONE stock extension-minter singleton
  serving many collections — the SeaDrop feature set with the trust
  arrow pointing at the artist (decision record:
  `pnd-collection-system.md` §8.5). Must honor the referral share in
  code.
- [ ] **BackedMinter + escrow vault** and **PooledIdMinter +
  ISourceReader** (Phase 5): the genuinely new audit surface — this is
  where external review money goes next. Gated on Homage proving the
  form's demand.
- [ ] Reference companions (lock registry, attestation board) so tier-2
  artists compose instead of writing Solidity.

## Housekeeping

- [ ] Remove the temporary `/Users/dd/foundation-collection` worktree
  once PR #134 (`collection-web-v1` → `main`) merges.
- [ ] After #134 merges, sweep the collection docs' status banners
  (system doc, this file) — several say "pre-deploy" and should say
  where things actually landed.
