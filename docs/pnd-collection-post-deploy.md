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

- [x] **Surface the admin list during ownership transfer** — first cut
  done pre-deploy (2026-07-13): `/studio/[address]/collections` carries
  the admins panel (the grants-survive-transfer warning + an isAdmin
  checker). Full roster enumeration lights up once discovery indexing
  lands (AdminSet events).

## First HTML-generative drop (gates that drop, not the SVG launch)

Design: `pnd-collection-thumbnails.md`. The contract side (RenderAssets
cover/captures/template/capturer) is shipped; this is the offchain half.

- [x] Client-side capture util — done pre-deploy (2026-07-13):
  `apps/web/src/lib/collection-render/capture.ts` (agent-in-sandbox
  postMessage design; the frame stays opaque-origin). Upload rail today
  is BYOK IPFS (the artist's own pinning key, same slot as the MURI
  flow); swaps to Irys→Arweave one-time storage when those rails land.
- [x] Studio "capture cover" step — done pre-deploy (2026-07-13): the
  create wizard's preview step captures the first test seed and uploads
  under the artist's key (`CaptureCover.tsx`).
- [ ] Mint-surface per-token capture at mint (PND pays the one-time
  upload where it earned the share).
- [x] Studio backfill tool — done pre-deploy (2026-07-13):
  `/studio/[address]/collections` (ManageCollectionTool) captures token
  ranges client-side from the renderer's onchain work refs and lands one
  `setCaptures` batch tx, or sets the `{id}` template directly.
  Remaining niceties: indexer-driven capture-less listing (post-
  indexing) and a capturer-key signing flow.
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
