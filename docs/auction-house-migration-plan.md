# Auction house migration plan: V2 implementation cut

Migrates the Sovereign Auction House fleet from the v1 implementation
(`0xC70D8a99b915BeDA52C5A952E29FFE152CbfCB34`, factory
`0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f`) to `SovereignAuctionHouseV2`
(PR #303, branch `claude/auction-v2-pull-settlement`), which fixes issue
#289 with pull settlement and adds ERC1155 lots, listing expiry, and a
stuck-lot escape hatch. Clones are immutable, so existing houses cannot be
patched; each owner deploys a fresh house from a new factory and re-lists.

A follow-up implementation, `SovereignAuctionHouseV2_1`, changes how a
failed delivery is resolved; see [V2.1](#v21-binding-settlement-when-only-the-winner-cannot-receive)
below. It is not yet deployed.

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

Remeasured 2026-09-07 (`ponder_v3.pnd_houses` / `pnd_auctions`, post PR #308):
97 V1 houses, 1 V2 house, 132 active V1 listings across 34 owners, 0 active
listings with bids.

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

### Standalone artist-site template

`templates/artist-page` still only ships the V1 auction ABIs
(`lib/abi/sovereignAuctionHouse.ts`, `lib/abi/sovereignAuctionHouseFactory.ts`)
and has no V2 house resolution. Updating the template to resolve a V2 house
(falling back to V1 for existing auctions, matching the `apps/web` pattern)
is in progress in a separate PR, not part of #308.

### Docs / manifest

- Decision (implemented): `contracts/deployments.mainnet.json` keeps the v1
  keys (`auctionHouseFactory`, `auctionHouseImplementation`) unchanged and
  adds `auctionHouseV2Factory` / `auctionHouseV2Implementation` alongside
  them. The originally planned rename to `*V1` keys was dropped: the
  mainnet-deployment drift test
  (`contracts/test/AuctionV2MainnetDeployment.t.sol`) and the docs generator
  already key off the unrenamed v1 names, and renaming them would touch
  both for no behavior change.
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

Phase 1, mainnet deploy: DONE 2026-09-02 from commit `49a5a696`.

1. Implementation `0x88b48793f38EF7370F2e7BC12E2f73DC565C117F` (block
   25901755), factory `0x77aB853543286C9Cdd7dd6c01222A7cC4Ac93d63` (block
   25901772). Fee terms 0 bps, zero recipient, matching v1. The deployer is
   an EIP-7702 delegated account, so the two-tx broadcast needed
   `--resume --slow` after the first attempt landed only the
   implementation; every broadcast from that signer takes `--slow`.
2. Both sources verified on Etherscan under the default profile (solc
   0.8.24, optimizer 200). Implementation code confirmed to be contract
   bytecode, not a delegation indicator.
3. Recorded in `deployments.mainnet.json` (`auctionHouseV2Factory`,
   `auctionHouseV2Implementation`; v1 keys untouched) with the drift guard
   `contracts/test/AuctionV2MainnetDeployment.t.sol`. Indexer start block
   for the V2 factory: 25901772.

Phase 2, indexer: DONE via PR #308 (merged 2026-09-04). Config, schema, and
handlers as above are live. Schema is `ponder_v3` (Railway service
`indexer-v3`); `pnd_houses.version` distinguishes 1 and 2. Backfill for the
v2 factory was tiny, starting at its deploy block.

Phase 3, web: DONE via PR #308 (admin + collector UI for ERC721 and ERC1155,
the V1-to-V2 upgrade flow at `/studio/[address]/migrate`), PR #307
(reference docs), and PR #306 (manifest record). Netlify production deploys
from `main` and is on the merged state.

Phase 4, fleet wind-down (owner-driven, no deadline): IN PROGRESS.

1. DONE 2026-09-07: migrated PND's own house as the dogfood run. V2 house
   `0x2b06e62ea47fa419e83bb7912e9ddb1cfc91cc1f`, tx
   [`0x2827da9d7bd9e98144a7826dd377c429d69f21795d6fa213d72515c65943b369`](https://evm.now/tx/0x2827da9d7bd9e98144a7826dd377c429d69f21795d6fa213d72515c65943b369?chainId=1).
2. The in-app upgrade panel for owners with active listings shipped in
   #308. Outreach to the 34 affected owners is out-of-band (not driven by
   this repo).
3. Tracking query, run against `ponder_v3`:

   ```sql
   select h.version, a.status, count(*)
   from ponder_v3.pnd_auctions a
   join ponder_v3.pnd_houses h on h.house = a.house
   group by 1, 2 order by 1, 2;
   ```

   State measured 2026-09-07: 97 V1 houses, 1 V2 house, 132 active V1
   listings across 34 owners, 0 active listings with bids. Nothing forces
   completion: a v1 house keeps working, and an unbid listing holds no ETH.

Phase 5, deprecation: web no longer offers v1 deploys (done in phase 3, this
change adds the superseded banner to the V1 SovereignAuctionHouse and
SovereignAuctionHouseFactory reference pages), v1 indexing continues
indefinitely.

## V2.1: binding settlement when only the winner cannot receive

Status: implemented on branch `claude/auction-house-v2-1`
(`contracts/src/SovereignAuctionHouseV2_1.sol`,
`SovereignAuctionHouseV2_1Factory.sol`, `ISovereignAuctionHouseV2_1.sol`,
`script/DeployAuctionV2_1.s.sol`). Not deployed. V2 houses are immutable
clones and keep V2 behaviour.

### Behaviour in V2

ERC1155 delivery uses `safeTransferFrom`, which calls the winner's
`onERC1155Received`. When the winner is a contract whose hook rejects the
transfer, `endAuction` defers the lot (`pendingDelivery`) and pays nobody.
`claimLot` by anyone else fails the same way. The winner can later accept
and claim at the hammer price, or leave the lot undelivered until
`PENDING_DELIVERY_TIMEOUT` (30 days), after which `unwindStuckLot` credits
its full bid back and returns the lot to the seller. A winning bid from such
an address therefore does not bind the bidder, while the seller's lot and
the outbid bidders' chance at it are tied up for the period. ERC721 delivery
(`transferFrom`) calls no receiver hook, but a collection whose transfer
rules depend on the recipient (blocklists, ERC-721C receiver levels) gives
the same result.

### What V2.1 changes

When delivery to the winner fails, the house runs a second capped self-call,
`probeTransfer`, which transfers the lot out of escrow to
`DELIVERY_PROBE_RECIPIENT` (a hash-derived address with no code and no known
key), verifies the transfer, and always reverts, so nothing it did persists.
Every token call inside the probe is wrapped in try/catch and the caller
reads at most four bytes of the probe's revert data, so a token cannot
forge the result and large revert payloads cost the outer frame nothing.

| Probe result | Meaning | Outcome |
| --- | --- | --- |
| Transferable | The failure is specific to the winner's address | Sale settles: protocol fee and seller paid (`AuctionEnded`), lot stays escrowed for the winner (`heldForWinner`, `LotHeldForWinner`). The winner claims with `claimLot(id, to)` to any address, with no deadline. No refund path exists. |
| Not transferable | The lot cannot move (paused or locked collection, burned or tampered escrow, transfer above the stipend) | V2 behaviour: `pendingDelivery`, nobody paid, permissionless retry through `claimLot`. |

`unwindStuckLot` can now be called at any time. It retries delivery to the
winner, then re-runs the probe and settles for the winner if the lot has
become transferable. Only when `PENDING_DELIVERY_TIMEOUT` has passed and the
lot still cannot move does it refund the winner in full and attempt to
return the lot to the seller (`LotUnwound`, plus `LotReturnDeferred` when
the return also fails, exactly as in V2).

Other changes:

- Each capped call (delivery, probe, return) has its own `gasleft()`
  headroom guard, so a call without enough gas reverts `InsufficientGas`
  and changes nothing rather than misclassifying a lot. A refused delivery
  now needs room for two capped calls in `endAuction` (about 1.1M gas in
  the worst case, a winner hook that spends its whole stipend;
  `eth_estimateGas` finds it). A delivered lot costs about 2.3k more gas
  than on V2.
- `claimLot` rejects the house itself as recipient.
- Transfer-out code is shared (`_transferOut`); runtime size 21,614 bytes
  (V2: 22,457), covered by an EIP-170 size test.

### Why this design

- **Probe target.** The probe asks whether the lot can reach a fresh,
  codeless address, which is what the winner itself can always supply
  through `claimLot(id, to)`. Probing the seller instead would misjudge
  both ways: a collection that only lets the lot go back to its creator
  would read as transferable while the winner can never receive it, and a
  seller wallet that rejects inbound ERC1155 would read as stuck and
  reopen the refund. Neither the winner nor the seller controls the probe
  recipient.
- **Settle at `endAuction`, not after 30 days.** Once the lot is shown to
  be transferable, settling immediately gives the honest winner exactly
  what a successful delivery would have (the lot is theirs, claimable at
  any time, to any address) and pays the seller at the hammer instead of
  locking proceeds for 30 days. Waiting would only preserve the window in
  which the winner chooses whether to take delivery.
- **Refund only when nothing can move the lot.** The V2 fix for issue #289
  (winner refunded when the collection blocks delivery) is kept for the
  case it was meant for.
- **Uniform for ERC721 and ERC1155.** The same probe and states apply to
  both standards; for ERC721 it covers recipient-dependent transfer rules.

### Product decision: the winning bid binds (2026-11-04)

A winning bid binds. After the hammer the winner, like any token owner,
carries the risk of the token contract's own behaviour. If a collection's
admin pauses, blocklists or upgrades transfers after settlement, the winner
has paid and may be unable to claim. This is the same exposure a buyer has
to an admin who can pause or seize after a normal delivery.

The decision follows established practice. networked.art's
`NetworkedAuctions` (mainnet `0xab48082d28049873ce54f672541d29779a3392ef`,
verified, solc 0.8.36) auctions ERC721, ERC1155 and Punks. Its `settle()`
tries delivery, marks `pendingDelivery` on failure, and pays the seller
unconditionally. The winner claims later with
`claimSettledToken(auctionId, to)`, and there is no refund path.

V2.1 binds the bid the same way, and adds one protection on top: when the
lot cannot move at all at settlement (the token is already paused or
blocked), the winner is refunded instead of paying for an undeliverable
lot.

The rejected alternative, "nobody loses what they put in", is V2's
behaviour. It is what gives an ERC1155 winner the free option. Reviewers
should treat post-settlement token-contract risk as accepted by design, not
as a finding.

### Accepted properties (documented, not changed)

- **Collection control decides the branch.** Whoever controls a
  collection's transfer rules can block every transfer after the hammer,
  wait out the timeout and have the sale unwound: the winner is refunded in
  full but its bid is locked for the period, and the lot returns to the
  seller. This holds for a seller who controls their own collection and is
  indistinguishable on-chain from a real pause (V2 has the same property).
  It is the cost of refunding winners of genuinely stuck lots. A collection
  that admits the probe recipient but blocks every address the winner could
  use is the same trust assumption in the other direction: the sale settles
  and the lot stays held. Recommended UI: badge lots from pausable,
  upgradeable or transfer-restricted collections.
- **Transfers above the 500k stipend** classify as not transferable, as in
  V2 (`claimLot` with full gas still delivers them).
- **A winner that cannot call `claimLot`** (a bare contract) pays for the
  lot, which then stays held indefinitely. The token id stays indexed to
  that auction, so this house cannot relist or recover the same
  `(tokenContract, tokenId)` while the lot is held.

### Indexer and web impact

- ABI, storage layout, `Auction` tuple and every V2 event are unchanged;
  `auctionVersion()` still returns 2, so `onchain.ts` keeps selecting the V2
  ABI. `version()` returns `"2.1.0"` (V2 houses revert on it). The factory
  has the V2 factory's interface and `AuctionHouseCreated` event.
- New event `LotHeldForWinner(auctionId, winner)`, emitted after
  `AuctionEnded` in the same transaction (from `endAuction` or
  `unwindStuckLot`). A V2 handler set marks such a row `settled`; add a
  handler that sets a new status (for example `held`) so the winner still
  sees a claim action. A later `claimLot` on a held lot emits `LotClaimed`
  only (no second `AuctionEnded`), and should move the row to `settled`.
- `pendingDelivery` keeps its V2 meaning (deferred, nobody paid). New view
  `heldForWinner(auctionId)`.
- `DeferredLotCard`: for a held lot show "Sold, awaiting the winner's claim"
  with the claim and redirect actions and no unwind action; for a deferred
  lot the unwind action can be offered before 30 days on V2.1 houses (it
  settles or reverts `UnwindTooEarly`).
- `pnd_houses.version` needs a value for V2.1 (for example 21, or keep 2
  and add a column), with the factory address as the discriminator.

### Migration for houses that list ERC1155 lots

V2 houses cannot be upgraded. Until an owner moves to V2.1, ERC1155 lots on
a V2 house keep V2 behaviour.

1. Pre-bid ERC1155 listings on the V2 house: `cancelAuction` (returns the
   lot to the owner).
2. `createAuctionHouse` on the V2.1 factory (a new address per owner).
3. `setApprovalForAll(v2_1House, true)` on each collection.
4. Re-list with `create1155Auction` (and `createAuction` /
   `bulkCreateAuctions` for ERC721 lots, if moving everything).
5. Listings that already have bids finish on the V2 house.

ERC721-only houses are affected only through recipient-dependent
collections; moving them is optional. Until V2.1 is live, the web can
mitigate on V2 houses by warning ERC1155 sellers and flagging a
`DeliveryDeferred` lot whose winner address has code.

### Deploy steps (not yet run)

1. Review gate on the V2.1 diff (contract change reopens it).
2. Dry run against a mainnet fork, no broadcast:
   `forge script script/DeployAuctionV2_1.s.sol --rpc-url $MAINNET_RPC_URL`
   with `PND_FEE_RECIPIENT` (and `PND_PROTOCOL_FEE_BPS` if nonzero) set to
   the V2 factory's terms (currently 0 bps, zero recipient).
3. Broadcast with `--broadcast --verify --slow` (the deployer is an
   EIP-7702 account; see the V2 phase 1 notes on `--resume --slow`). The
   script asserts the factory wiring and `version() == "2.1.0"`.
4. Confirm Etherscan verification of both addresses under the default
   profile.
5. Record the addresses by hand in `contracts/deployments.mainnet.json`
   (suggested keys `auctionHouseV2_1Factory`,
   `auctionHouseV2_1Implementation`; the V1 and V2 keys stay) and add a
   drift test mirroring `test/AuctionV2MainnetDeployment.t.sol`.
6. Indexer: subscribe the V2.1 factory and its clones (same handlers plus
   `LotHeldForWinner`), with the factory's deploy block as `startBlock`;
   this is a schema-changing release, so follow the `INDEXER_SCHEMA` bump
   procedure in `AGENTS.md`.
7. Web: deploy new houses from the V2.1 factory, resolve V2.1 then V2 then
   V1, regenerate `@pin/abi` and the reference docs.

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
