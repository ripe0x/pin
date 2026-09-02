# Auction house migration plan: V2 implementation cut

Migrates the Sovereign Auction House fleet from the v1 implementation
(`0xC70D8a99b915BeDA52C5A952E29FFE152CbfCB34`, factory
`0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f`) to `SovereignAuctionHouseV2`
(PR #303, branch `claude/auction-v2-pull-settlement`), which fixes issue
#289 with pull settlement and adds ERC1155 lots, listing expiry, and a
stuck-lot escape hatch. Clones are immutable, so existing houses cannot be
patched; each owner deploys a fresh house from a new factory and re-lists.

## Live state (measured 2026-08-21)

Source: `ponder_v2.pnd_houses` / `pnd_auctions` on maglev, plus a one-off
balance sweep of every house.

| Fact | Value |
| --- | --- |
| Houses deployed | 96 (55 ever created an auction) |
| Active auctions | 133, across 34 houses and 54 token contracts |
| Active auctions with bids | **0** |
| ETH held by any house | **0** across all 96 (no live bids, no unclaimed `pendingRefunds`) |
| Historical auctions | 97 settled, 102 cancelled |

Consequences:

- Every active listing is pre-bid, so every one is cancellable by its
  house owner via `cancelAuction`/`bulkCancelAuctions`, which returns the
  escrowed NFT. No ETH is at risk anywhere in the fleet today.
- The migration has no forced-timeline component. The only exposure while
  old listings remain is the original #289 hazard, and it requires a bid
  to land first.
- History (97 + 102 auctions) must stay visible in the web app after
  cutover, which means the old factory stays indexed permanently.

## What changes per component

### Contracts (done on PR #303, settlement rework at `ae11e8f0`)

- `SovereignAuctionHouseV2`: escrow-and-wait settlement. `endAuction`
  attempts delivery through a try/catch self-call with a fixed 500k gas
  stipend behind a `gasleft()` headroom guard; the protocol fee and seller
  are paid only if that delivery succeeds (state cleared first, then
  `_payout`: push to plain wallets, credit contract wallets to
  `pendingRefunds` so no external code runs after the lot moves). On
  failure nobody is paid: the winning bid and the lot both stay escrowed,
  `pendingDelivery` and `deliveryDeferredAt` are set, `DeliveryDeferred`
  is emitted. `claimLot(auctionId, to)` retries delivery for
  `PENDING_DELIVERY_TIMEOUT` (30 days): anyone may call with `to == 0`
  (delivers to the winner), only the winner may redirect (best-effort);
  the seller is paid the moment it lands. After the timeout, permissionless
  `unwindStuckLot` retries the winner once more and otherwise unwinds the
  sale: the winner's full bid is credited to `pendingRefunds` and the lot
  is returned to the seller (`LotUnwound`); if that return fails the lot
  stays locked under `pendingReturn` until `returnUnwoundLot` succeeds.
  Product rule: nobody can lose what they put in. Also in V2: ERC1155 lots
  (`create1155Auction`), per-auction `fundsRecipient`,
  `setAuctionDuration`, creator-set `listingExpiry` plus `expireAuction`,
  `withdrawRefundTo`, a `getAuction()` struct getter, and defense-in-depth
  hardening (setter reentrancy guards, 1155 recovery verification,
  `createBid` checks-effects-interactions). Audit trail: two Codex passes
  and one 12-agent solidity-auditor pass covered the earlier
  pay-seller-always ordering; a fourth Codex pass audited the
  escrow-and-wait settlement at `ae11e8f0` with zero findings.
- `SovereignAuctionHouseV2Factory`: a new instance pointing at the V2
  implementation. Same owner gets a different CREATE2 house address (salt
  is the owner, but the implementation address changes the clone bytecode
  hash), so there is no address collision and `predictHouseAddress` stays
  meaningful per factory.

### Indexer (`apps/indexer`)

- Add a second contract pair to `ponder.config.ts`: the v2 factory address
  with its own `startBlock`, and a second `factory()`-pattern clone
  subscription for v2 houses. The v1 pair stays forever (history plus any
  straggler still using an old house).
- Handle the new lifecycle. On V2 houses `endAuction` emits exactly one
  of two events: `AuctionEnded` (delivery verified and payout ran; status
  `settled`, terminal) or `DeliveryDeferred` (delivery failed, nobody
  paid, bid and lot still escrowed; status `deferred`). A deferred lot
  then ends in exactly one of: `LotClaimed` + `AuctionEnded` in the same
  tx (retry delivered; status `settled`), or `LotUnwound` (sale unwound,
  winner's bid credited for withdrawal; status `unwound`), optionally
  with `LotReturnDeferred` in the same tx (lot still house-held; status
  `unwound_return_pending`) followed later by `LotReturned` (status
  `unwound`). Add handlers for `DeliveryDeferred`, `LotClaimed`,
  `LotUnwound`, `LotReturnDeferred`, `LotReturned`, `Auction1155Created`,
  `AuctionDurationUpdated`, `AuctionFundsRecipientUpdated`,
  `AuctionListingExpiryUpdated`, `StuckERC1155Recovered`; `expireAuction`
  emits `AuctionCanceled`. Schema additions on `pnd_auctions`: `standard`
  (721/1155), `quantity`, `fundsRecipient`, `listingExpiry`,
  `deferredAtTime`, `claimedAtBlock`, `claimedAtTime`, `claimTxHash`,
  `claimRecipient`, `refundAmount`, plus the new status values. v1 rows
  keep their existing semantics (settle and delivery were one event).
- `pnd_houses` gains a `factory` (or `version`) column so the web app can
  distinguish v1 from v2 houses in one query.

### Web (`apps/web`)

- Address constants: add the v2 factory address beside the v1 one. The
  `@pin/abi` snapshot (`sovereignAuctionHouseV2`) is already regenerated on
  the branch; `onchain.ts` distinguishes houses via `auctionVersion()`.
- `DeployHouseCTA` / `useDeployHouse`: deploy from the v2 factory only.
- `useArtistHouse` / `sovereign-house.ts`: resolve v2 house first, fall
  back to v1 for display of existing auctions.
- New claim surface: a deferred v2 lot shows a retry-delivery action
  (anyone may trigger it; the winner additionally gets a redirect field)
  and shows that nobody has been paid yet; after 30 days anyone sees an
  unwind action, and a return-deferred lot shows a return action.
- Migration flow for the 34 owners with active listings, built on the
  existing `MigratePanel` pattern: (1) `bulkCancelAuctions` on the old
  house (NFTs return to the owner), (2) `createAuctionHouse` on the v2
  factory, (3) re-approve collections, (4) `bulkCreateAuctions` to
  re-list. Owners with an empty or unused old house just get the normal
  deploy CTA against the v2 factory.
- Old-house listings remain biddable until their owner migrates; the
  listing page for a v1 house shows a migration notice to the owner only.
  (Suppressing the bid box fleet-wide is an option; not recommended, since
  the hazard needs a bid plus a collection-side refusal, unchanged from
  the risk accepted at v1 launch.)

### Docs / manifest

- `contracts/deployments.mainnet.json`: `auctionHouseFactory` and
  `auctionHouseImplementation` point to the v2 addresses; v1 addresses
  move to explicit `auctionHouseFactoryV1` / `auctionHouseImplementationV1`
  keys so verification pages and history keep resolving.
- Regenerate reference docs (`pnpm generate:docs`) and
  `protocol-manifest.json`; the SovereignAuctionHouse prose must describe
  the two-step settle/claim flow.

## Sequencing

Phase 0, gates (before any deploy):

1. Merge PR #303.
2. Review gate: satisfied. Codex audited the escrow-and-wait settlement
   (range `e363e4a0..d40b3afc`, contracts at `ae11e8f0`) with zero
   findings and an explicit verdict that every payout path follows a
   custody-verified delivery. Any further contract change reopens the gate
   for the changed function.
3. Pre-flight reads on the v1 factory: `defaultProtocolFeeBps` and
   `defaultFeeRecipient`, carried into the v2 factory constructor
   unchanged unless Dave says otherwise.

Phase 1, mainnet deploy (per-broadcast confirm protocol applies):

1. Deploy the `SovereignAuctionHouseV2` implementation, then
   `SovereignAuctionHouseV2Factory` pointing at it
   (`contracts/script/DeployAuctionV2.s.sol`). Deploy-time check: confirm
   the implementation address carries real bytecode, not an EIP-7702
   delegation indicator.
2. Verify both sources on Etherscan under the default profile (the
   profile that byte-matches, per #287).
3. Update `deployments.mainnet.json`, regen docs and ABIs, commit.

Phase 2, indexer: config + schema + handlers as above, deploy to Railway.
Backfill for the v2 factory is tiny (starts at its deploy block).

Phase 3, web: constants, deploy CTA cutover, claim UI, migration flow,
docs regen. Netlify deploys from `main` on merge.

Phase 4, fleet wind-down (owner-driven, no deadline):

1. Migrate PND's own house first as the dogfood run.
2. In-app migration prompt for the 34 owners with active listings; plain
   deploy CTA for the rest.
3. Track progress with an indexer query (active v1 auctions remaining,
   v2 houses created). Nothing forces completion: a v1 house keeps
   working, and an unbid listing holds no ETH.

Phase 5, deprecation: web no longer offers v1 deploys (done in phase 3),
docs mark v1 as superseded, v1 indexing continues indefinitely.

## Open decisions

- Carry v1 fee terms into the v2 factory, or change them (phase 0.3).
- Whether the web should suppress bidding on not-yet-migrated v1 listings
  (default: no, owner-facing notice only).
- Whether anything should auto-call `claimLot` / `unwindStuckLot` for
  deferred lots (a keeper would need a funded tx path PND does not
  currently run; default: UI-only, permissionless retry and unwind cover
  stuck cases).
- Curator economics (native fee, propose/accept consignment) were removed
  from V2 pending a proper consignment design; not part of this cut.
