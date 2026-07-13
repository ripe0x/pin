# PND Collection System: post-deploy work

> **What this is.** The list of everything deliberately deferred past the
> **launch**, so none of it gets forgotten. Nothing here gates the
> contract deploy — that gate is the external re-audit
> (`pnd-collection-reaudit-notes.md`) — and nothing here gates the
> launch either: the post-deploy → launch window has its own runbook
> with kickoff prompts, `pnd-collection-prelaunch.md` (addresses,
> source verification, discovery indexing, the launch collection,
> mint surfaces, the pre-announce audit). Items below are ordered by
> when they bite. Written 2026-07-13; check items off or move them to
> issues as they start.

## Studio follow-ups

- [ ] **Surface the admin list during ownership transfer.** The accepted
  contract behavior (reaudit notes, Change 1) is that `_admins` survives
  `transferOwnership` — the new owner inherits the old operator's keys.
  The agreed mitigation is product-side: any transfer flow shows the
  current admin roster loudly so both parties see who still holds keys.

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
- [x] Mirror the capture spec into `injection-convention.md` — done 2026-07-13.

## Preservation

- [x] **MURI operator adapter** (`ripe0x/pin#138`, contract half) —
  DONE pre-deploy (2026-07-13): `contracts/src/collection/muri/
  MuriOperator.sol`, fork-proven against live MURI end to end
  (register → initializeTokenData → getThumbnailUris → addArtworkUris
  as artist and collector). Remaining for #138: deploy the singleton,
  then the PND surface that drives it (mint-into-MURI flow for
  collections, mirroring the Manifold `/muri` flow).

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
