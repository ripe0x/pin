---
title: SovereignAuctionHouseV2
---

# summary

An onchain English auction house for ERC721 and ERC1155 tokens, denominated in
ETH. One house is deployed per owner as an immutable EIP-1167 clone by
[the V2 factory](/docs/auctions/contracts/auction-house-v2-factory): the seller
(an artist or a collector) gets their own instance with isolated storage. There
is no proxy admin and no upgrade path: what deploys is what runs. V1 houses stay
on their original implementation and are unaffected by V2; the two systems run
side by side, and an indexer can tell them apart with `auctionVersion`, which V1
houses do not expose.

V2 changes how settlement pays out. `endAuction` no longer moves the NFT and
pays the seller as a single unconditional step. It attempts delivery to the
winner with a fixed gas stipend first, and only pays the protocol fee and the
seller if that delivery succeeds. If delivery fails, for example because the
winning bidder is a contract that reverts on receipt or a paused collection
blocks the transfer, nobody is paid: the winning bid and the lot both stay
escrowed, and delivery becomes retryable by anyone through `claimLot`. A lot
still undelivered `PENDING_DELIVERY_TIMEOUT` (30 days) after that point can be
unwound with `unwindStuckLot`, which refunds the winner and returns the lot to
the seller. The rule this protects: a seller is paid only when the winner holds
the lot, and nobody can lose what they put in.

The house also adds ERC1155 support (`create1155Auction`, one indivisible lot
per auction), a per-auction `fundsRecipient` separate from the seller address,
a creator-adjustable `duration`, and an optional no-bid `listingExpiry` that
lets an owner close a stale, never-bid listing without waiting indefinitely.
Ownership is locked at init exactly as in V1: `transferOwnership` and
`renounceOwnership` revert `OwnershipLocked`. The protocol fee and fee
recipient are written once at init by the factory defaults and never change on
a live house.

# concepts

### Escrow-and-wait settlement

`endAuction` is permissionless, like V1, but its delivery step is now
conditional. It calls a gas-capped internal self-call (`deliverERC721` or
`deliverERC1155`, `DELIVER_GAS_LIMIT` gas) wrapped in a try/catch, so the
outcome cannot depend on how much gas the external caller supplied and a
reverting recipient cannot revert the whole settlement transaction. If that
self-call succeeds, the auction finalizes: state is deleted, the protocol fee
goes to `feeRecipient`, and the remaining proceeds go to the auction's
`fundsRecipient`. If it fails, the auction is marked `pendingDelivery`, the
timestamp is recorded in `deliveryDeferredAt`, and `DeliveryDeferred` fires.
The winning bid and the lot both stay in the contract; no partial payout ever
happens.

### Claiming a deferred lot

Once an auction is `pendingDelivery`, anyone can call `claimLot(auctionId, to)`
with `to` set to the zero address to retry delivery to the recorded winner.
Only the winner may redirect delivery elsewhere by passing a nonzero `to`.
`claimLot` runs the transfer with full gas and no try/catch, so a revert rolls
back the whole call and leaves the claim retryable rather than silently
failing again. The redirect is best-effort: whichever call reaches the chain
first consumes the pending state, so a third party triggering plain delivery
to the winner before the winner redirects forecloses that redirect. The token
still always reaches the winner's own bid address in that case. Settlement
(state cleanup, protocol fee, and seller payout) happens inside the same
`claimLot` call, right after delivery succeeds.

### The 30-day timeout and unwinding

A lot still `pendingDelivery` `PENDING_DELIVERY_TIMEOUT` (30 days) after
`deliveryDeferredAt` becomes eligible for `unwindStuckLot`, callable by
anyone. It first retries delivery to the winner exactly as `endAuction` did,
because a delivery failure can be temporary. If that retry succeeds, the sale
finalizes normally and the seller is paid. If it fails again, the sale
unwinds: the winner's full bid is credited to `pendingRefunds`
unconditionally, before any token movement is attempted, and `LotUnwound`
fires. A capped attempt then returns the lot to the seller. If that return
also succeeds, the auction's storage is cleared. If it fails, the auction is
marked `pendingReturn`, `LotReturnDeferred` fires alongside `LotUnwound`, and
the lot stays locked until `returnUnwoundLot` succeeds. Nobody is paid out of
`unwindStuckLot` unless the winner ends up holding the lot.

### Refunds always reach the recipient eventually

Every ETH payout in this contract (an outbid refund, the seller's proceeds,
the protocol fee, or an unwound sale's refund) either lands directly or is
credited to `pendingRefunds` for a later pull withdrawal. An outbid refund is
pushed with a 30,000 gas stipend and credited on failure. A settlement payout
is different: any recipient with contract code, including an EIP-7702-
delegated account, is credited to `pendingRefunds` and never pushed at all,
because settlement runs after the lot has already moved and no external code
should execute at that point except the payout call itself. An EOA recipient
is still pushed first and only credited if that push fails. Claim a credited
balance with `withdrawRefund` (pays the caller) or `withdrawRefundTo` (pays a
caller-chosen address).

### ERC1155 lots

`create1155Auction` lists one indivisible quantity of an ERC1155 id. Unlike
ERC721, ERC1155 has no per-token `ownerOf` or `getApproved`, so only the house
owner's own held balance can be listed: the caller must hold at least
`quantity` and have approved the house with `isApprovedForAll`. There is no
consignment path for ERC1155 the way ERC721 supports listing an approved
third party's token. The lot is pulled in with `safeTransferFrom`, and the
house's `onERC1155Received` hook checks the incoming transfer against the
exact pull in progress so an unrelated ERC1155 transfer cannot be mistaken for
an auction deposit. `onERC1155BatchReceived` always reverts: batch deposits
are not supported.

### Listing expiry

Every `createAuction` and `create1155Auction` call takes a `listingExpiry_`.
Zero means the listing stays open until its owner cancels it. A nonzero value
must be strictly in the future and closes the listing automatically if no bid
ever lands: `createBid` checks it only while the auction is still pre-bid, so
a bid placed before the expiry starts the normal auction clock and the expiry
stops applying. Anyone can call `expireAuction` once a pre-bid listing's
expiry has passed, returning the lot to its owner. The owner can change or
clear the expiry pre-bid with `setAuctionListingExpiry`, or cancel the listing
outright with `cancelAuction`.

### Live reads

```bash
# Which auction-house version this house is (2 for V2; V1 has no such function)
cast call <AUCTION_HOUSE_V2_ADDRESS> "auctionVersion()(uint8)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# The full stored auction record
cast call <AUCTION_HOUSE_V2_ADDRESS> "getAuction(uint256)((uint256,address,uint64,uint256,uint256,address,address,uint64,address,uint64,uint256,uint8))" 0 \
  --rpc-url https://ethereum-rpc.publicnode.com

# Whether a lot is waiting on a deferred delivery
cast call <AUCTION_HOUSE_V2_ADDRESS> "pendingDelivery(uint256)(bool)" 0 \
  --rpc-url https://ethereum-rpc.publicnode.com

# The protocol fee in bps
cast call <AUCTION_HOUSE_V2_ADDRESS> "protocolFeeBps()(uint16)" \
  --rpc-url https://ethereum-rpc.publicnode.com
```

Each house is a per-owner clone with no single fixed address, so the examples
use an `<AUCTION_HOUSE_V2_ADDRESS>` placeholder; the address lands when the
owner deploys their house through the V2 factory.

## function createAuction

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Registers one ERC721 auction and escrows its token into the house. The house
owner may list a third party's token by consignment: `tokenOwner` is read from
the token itself with `ownerOf`, and the caller must be that owner or
approved for the token (`ownerOf`, `getApproved`, or `isApprovedForAll`, else
`"Not token owner or approved"`), so proceeds go to that owner's
`fundsRecipient`, not the house owner. The token contract must advertise the
ERC721 interface (`"tokenContract is not ERC721"` otherwise), `duration` must
be nonzero and at most `MAX_DURATION` (`"duration zero"` / `"duration too
large"`), `listingExpiry_` must be zero or strictly in the future
(`"expiry must be future"`), and the token must not already have a live
auction on this house (`AuctionAlreadyExistsForToken`). The house transfers
the token in with `transferFrom` and verifies it landed (`EscrowFailed`). The
auction starts with no bids and its timer stopped: `duration` is stored and
consumed on the first bid to compute the end time, and `fundsRecipient` starts
equal to `tokenOwner`. Returns the new `auctionId` and emits `AuctionCreated`.

## function bulkCreateAuctions

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Registers many ERC721 auctions for the same token contract in one
transaction, applying the same `reservePrice`, `duration`, and
`listingExpiry_` to each. It runs the exact same per-token checks and escrow
as `createAuction` for every id, and reverts the whole batch if any single one
fails. Returns the new `auctionId` array aligned with `tokenIds` and emits one
`AuctionCreated` per token.

## function create1155Auction

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Registers one indivisible ERC1155 lot of `quantity` units of `tokenId`. Only
the house owner's own held balance may be listed, there is no consignment
path here: the caller must hold at least `quantity` (`"insufficient
balance"`) and have called `setApprovalForAll` on the house
(`"house not approved"`). The token contract must advertise the ERC1155
interface (`"tokenContract is not ERC1155"`), `quantity` must be nonzero
(`"quantity zero"`), `duration` and `listingExpiry_` are validated exactly as
in `createAuction`, and the token id must not already have a live auction on
this house (`AuctionAlreadyExistsForToken`). The lot is pulled in with
`safeTransferFrom`; `tokenOwner` and `fundsRecipient` are both the caller.
Returns the new `auctionId` and emits `Auction1155Created`.

## function setAuctionReservePrice

access: seller-only (`msg.sender` must be the auction's `tokenOwner`, else the call reverts `"Not token owner"`)

Updates an auction's reserve price. Only the seller who created the auction
may call it, and only before the first bid lands (`AuctionAlreadyStarted`
afterward). Works the same for an ERC721 or ERC1155 lot. Reverts
`AuctionDoesNotExist` for an unknown id. Emits `AuctionReservePriceUpdated`.

## function setAuctionDuration

access: seller-only (`msg.sender` must be the auction's `tokenOwner`, else the call reverts `"Not token owner"`)

Updates an auction's duration before bidding starts. Only the seller may call
it, and only before the first bid lands (`AuctionAlreadyStarted` afterward).
The new value is validated the same way as at creation: nonzero and at most
`MAX_DURATION`. Once a bid lands the duration that produced the current end
time is fixed. Reverts `AuctionDoesNotExist` for an unknown id. Emits
`AuctionDurationUpdated`.

## function setAuctionFundsRecipient

access: seller-only (`msg.sender` must be the auction's `tokenOwner`, else the call reverts `"Not token owner"`)

Redirects an auction's sale proceeds to a different address before bidding
starts. Only the seller (the recorded `tokenOwner`) may call it, so a house
owner who listed a third party's token by consignment cannot redirect that
party's proceeds to themselves. Reverts `FundsRecipientRequired` for a zero
address and `AuctionAlreadyStarted` once a bid has landed. Reverts
`AuctionDoesNotExist` for an unknown id. Emits `AuctionFundsRecipientUpdated`.

## function setAuctionListingExpiry

access: seller-only (`msg.sender` must be the auction's `tokenOwner`, else the call reverts `"Not token owner"`)

Sets or clears an auction's no-bid listing expiry before bidding starts. Only
the seller may call it, and only before the first bid lands
(`AuctionAlreadyStarted` afterward). `expiry` must be zero (no expiry) or
strictly in the future (`"expiry must be future"`). Reverts
`AuctionDoesNotExist` for an unknown id. Emits `AuctionListingExpiryUpdated`.

## function createBid

access: permissionless (payable; any caller may bid, guarded by expiry, reserve, increment, and timer checks)

Places a bid on an auction, where the bid amount is the ETH sent
(`msg.value`). While the auction is still pre-bid, a nonzero, passed
`listingExpiry` blocks any further bid (`AuctionExpired`); once the first bid
lands the expiry no longer applies. The value must be greater than zero
(`BidMustBePositive`). If the auction has already started, it must not be
past its end time (`AuctionExpired`). The first bid must meet the reserve
(`BidBelowReserve`) and starts the timer, setting the end time to now plus
`duration`. Every later bid must beat the current high bid by at least
`MIN_BID_INCREMENT_BPS` (`BidBelowMinimum`). The previously outbid bidder is
refunded: the house pushes their ETH back, or credits `pendingRefunds` and
emits `RefundCredited` if the push fails. If this bid lands inside the last
`TIME_BUFFER`, the end time is pushed out to `block.timestamp + TIME_BUFFER`
and `AuctionEndTimeUpdated` is emitted. Reverts `AuctionDoesNotExist` for an
unknown id. Emits `AuctionBid` with the `firstBid` and `extended` flags.

## function endAuction

access: permissionless (any caller may attempt settlement of an ended auction)

Attempts to settle a finished auction. The auction must have had at least one
bid (`AuctionHasNoBids`), must be past its end time (`AuctionNotEnded`), and
must not already be `pendingDelivery` or `pendingReturn`
(`AuctionAlreadySettled`). The call itself must carry enough gas headroom to
guarantee the delivery stipend is honored in full (`InsufficientGas`
otherwise, since EIP-150 forwards at most 63/64 of remaining gas). The house
then attempts delivery to the winning bidder through a gas-capped try/catch
self-call. If delivery succeeds, the auction finalizes: state is deleted, the
protocol fee (`protocolFeeBps` of the winning bid) is paid to `feeRecipient`,
and the rest goes to the auction's `fundsRecipient`. `AuctionEnded` fires with
the seller proceeds and protocol fee. If delivery fails, nobody is paid: the
auction is marked `pendingDelivery`, `deliveryDeferredAt` is recorded, and
`DeliveryDeferred` fires. Reverts `AuctionDoesNotExist` for an unknown id.

## function deliverERC721

access: self-only (`msg.sender` must be this contract, else `OnlySelf`)

The delivery target `endAuction` and `unwindStuckLot` call through a
gas-capped try/catch self-call when the lot is an ERC721. Transfers the token
with `transferFrom` and verifies with `ownerOf` that it landed at the
recipient (`DeliveryFailed` otherwise). Not meant to be called directly:
external code cannot pass the self-only check.

## function deliverERC1155

access: self-only (`msg.sender` must be this contract, else `OnlySelf`)

The delivery target `endAuction` and `unwindStuckLot` call through a
gas-capped try/catch self-call when the lot is an ERC1155. Transfers with
`safeTransferFrom` and verifies the recipient's balance increased by
`quantity` (`DeliveryFailed` otherwise). Not meant to be called directly:
external code cannot pass the self-only check.

## function claimLot

access: permissionless to trigger delivery to the winner; winner-only to redirect (`to` nonzero from a non-winner reverts `NotWinner`)

Delivers a lot whose delivery was deferred at `endAuction`. Reverts
`NoPendingDelivery` if the auction is not currently deferred. Passing
`to == address(0)` triggers delivery to the recorded winner and can be called
by anyone, which lets a third party rescue a winner that has no way to call
this itself. Only the recorded winner may redirect delivery elsewhere with a
nonzero `to`. Delivery runs with full gas and no try/catch, so a revert rolls
back the whole call and leaves the claim retryable. Settlement (state
cleanup, protocol fee, and seller payout) runs in the same call, right after
delivery succeeds. Emits `LotClaimed` with the winner and the actual
recipient.

## function unwindStuckLot

access: permissionless, but only once `PENDING_DELIVERY_TIMEOUT` has elapsed since deferral (`UnwindTooEarly` otherwise)

Resolves a lot still `pendingDelivery` `PENDING_DELIVERY_TIMEOUT` (30 days)
after `deliveryDeferredAt`. Reverts `NoPendingDelivery` if the auction is not
currently deferred, and requires enough gas headroom for two capped self-calls
(`InsufficientGas` otherwise). It first retries delivery to the recorded
winner exactly as `endAuction` did. If that succeeds, the sale finalizes
normally, the seller is paid, and `LotClaimed` fires. If it fails again, the
sale unwinds: the winner's full bid is credited to `pendingRefunds`
unconditionally, before any token movement is attempted, and `RefundCredited`
fires. A capped attempt then returns the lot to the seller. If that succeeds,
the auction's storage is cleared. If it fails, the auction is marked
`pendingReturn` and `LotReturnDeferred` fires. `LotUnwound` always fires on
the unwind path, carrying the refunded amount and the seller address. Nobody
is paid from this function unless the winner ends up holding the lot.

## function returnUnwoundLot

access: permissionless (any caller may deliver a lot pending return)

Delivers a lot whose return to the seller failed during `unwindStuckLot`.
Reverts `NoPendingReturn` if the auction has no deferred return. Always
delivers to the auction's recorded `tokenOwner`, never to a caller-supplied
address. Runs with full gas and no try/catch, so a revert rolls back the
whole call and leaves the return retryable. On success, clears the auction's
storage and emits `LotReturned`.

## function cancelAuction

access: seller-only (`msg.sender` must be the auction's `tokenOwner`, else the call reverts `"Not token owner"`)

Cancels a pending auction and returns its escrowed lot to the seller. Valid
only before the first bid lands (`AuctionAlreadyStarted` afterward), since a
started auction is a live commitment to its bidders. Works the same for an
ERC721 or ERC1155 lot. Reverts `AuctionDoesNotExist` for an unknown id.
Clears the auction's storage and emits `AuctionCanceled`.

## function expireAuction

access: permissionless (any caller may expire a listing whose expiry has passed)

Closes a pre-bid listing once its owner-set `listingExpiry` has passed,
returning the lot to the seller. Reverts `AuctionNotEnded` if the auction has
already received a bid, has no expiry set, or the expiry has not yet passed.
Reverts `AuctionDoesNotExist` for an unknown id. Clears the auction's storage
and emits `AuctionCanceled`, the same event `cancelAuction` emits.

## function withdrawRefund

access: permissionless (any caller drains only their own credited balance, paid to themselves)

Claims the caller's `pendingRefunds` balance and pays it to the caller.
Reverts `"No refund available"` for a zero balance and `"Withdraw failed"` if
the ETH transfer fails (the balance is restored by the revert). Emits
`RefundWithdrawn`.

## function withdrawRefundTo

access: permissionless (any caller drains only their own credited balance, paid to a chosen address)

Claims the caller's `pendingRefunds` balance and pays it to `recipient`
instead of the caller. Reverts `FundsRecipientRequired` for a zero
`recipient`, `"No refund available"` for a zero balance, and
`"Withdraw failed"` if the transfer fails. Emits `RefundWithdrawn` with the
caller and the recipient.

## function recoverStuckERC721

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Rescues an ERC721 that landed on the house outside the auction flow, for
example a plain `transferFrom` sent directly to the house address. Reverts
`"to required"` for a zero destination, and `AuctionAlreadyExistsForToken` if
the token is currently registered to a live auction. Transfers the token to
`to` and emits `StuckERC721Recovered`.

## function recoverStuckERC1155

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Rescues ERC1155 units that landed on the house outside the auction flow.
Reverts `"to required"` for a zero destination, and
`AuctionAlreadyExistsForToken` if the token id is currently registered to a
live auction. Transfers `quantity` units to `to` with `safeTransferFrom` and
verifies the recipient's balance increased by that amount (`DeliveryFailed`
otherwise). Emits `StuckERC1155Recovered`.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`)

Sets up the clone exactly once with its owner, `feeRecipient`, and
`protocolFeeBps`. Reverts `"owner required"` for a zero owner,
`"fee above cap"` for a fee over 500 bps (5%), and
`"fee recipient required when fee > 0"` when a non-zero fee has no recipient.
The constructor disables initializers on the implementation, so only clones
can be initialized, and only once. Sets the owner (emitting
`OwnershipTransferred` from the zero address). Emits `Initialized`.

## function auctions

The full stored state of an auction by id: `tokenId`, `tokenContract`,
`firstBidTime` (0 before any bid), current high `amount`, `reservePrice`,
seller `tokenOwner`, `fundsRecipient`, `endTime` (0 until the first bid),
current high `bidder`, `duration` in seconds, `quantity` (1 for an ERC721
lot), and `standard` (0 for ERC721, 1 for ERC1155). A zero `tokenOwner` means
no auction exists at that id.

## function getAuction

Returns the same data as `auctions(auctionId)`, decoded as one `Auction`
struct instead of a flat tuple, for callers that want a single decode.

## function getAuctionFor

Resolves a `(tokenContract, tokenId)` to its live auction: returns an
`exists` flag and the `auctionId`. Still resolves to `exists = true` while
the auction is `pendingDelivery` or `pendingReturn`, since the token's index
entry is only cleared once `claimLot`, `unwindStuckLot`, or
`returnUnwoundLot` fully resolves the lot.

## function nextAuctionId

The auction id that the next `createAuction`, `bulkCreateAuctions`, or
`create1155Auction` call will assign.

## function pendingDelivery

True for an auction whose delivery attempt at `endAuction` failed. Neither
the seller nor the protocol fee has been paid. Cleared by `claimLot` on
successful delivery, or by `unwindStuckLot` once the timeout has passed.

## function deliveryDeferredAt

The timestamp an auction entered `pendingDelivery`, set by `endAuction`'s
deferral branch. `unwindStuckLot` reads this to enforce
`PENDING_DELIVERY_TIMEOUT`.

## function pendingReturn

True for an auction that `unwindStuckLot` unwound but whose lot return to the
seller also failed. The winner's bid is already credited to `pendingRefunds`
by this point. Cleared by `returnUnwoundLot`.

## function pendingRefunds

The pull-payment balance in wei currently owed to an address: from an outbid
refund, a settlement payout to a contract-code recipient, or an unwound
sale's refund to the winner. Claimable with `withdrawRefund` or
`withdrawRefundTo`.

## function listingExpiry

The stored no-bid listing expiry for an auction, in Unix seconds. Zero means
no expiry. Checked by `createBid` only while the auction is still pre-bid,
and by `expireAuction`.

## function protocolFeeBps

The protocol fee in basis points taken from each winning bid at settlement,
fixed at init and capped at 500 (5%).

## function feeRecipient

The address that receives the protocol fee at settlement, fixed at init. It
is the zero address only when `protocolFeeBps` is zero.

## function MIN_BID_INCREMENT_BPS

The minimum increment a later bid must add over the current high bid, as a
compile-time constant: 500 bps (5%). Not owner-set.

## function TIME_BUFFER

The anti-snipe window as a compile-time constant: 15 minutes. A bid inside
the last `TIME_BUFFER` before the end time pushes the end time out to
`block.timestamp + TIME_BUFFER`.

## function MAX_DURATION

The upper bound on `duration`, as a compile-time constant: 100 years.
Enforced on `createAuction`, `bulkCreateAuctions`, `create1155Auction`, and
`setAuctionDuration`.

## function PENDING_DELIVERY_TIMEOUT

How long a lot must stay `pendingDelivery` before `unwindStuckLot` may act on
it, as a compile-time constant: 30 days.

## function auctionVersion

Always returns `2`. Lets a caller or indexer tell a V2 house apart from a V1
house, which has no such function, without needing to inspect bytecode.

## function owner

The house owner, fixed at init: the address that creates and cancels
auctions and can recover stuck tokens. Ownership is locked, so this value
never changes.

## function transferOwnership

Disabled: this function is pure and always reverts `OwnershipLocked`.
Ownership is fixed at init so the house can never be reassigned away from its
original owner.

## function renounceOwnership

Disabled: this function is pure and always reverts `OwnershipLocked`.
Renouncing would set the owner to zero and disable every owner-only function,
so it is permanently disabled alongside `transferOwnership`.

## function supportsInterface

ERC165 introspection. Returns true for the `IERC1155Receiver` and `IERC165`
interface ids, and false for anything else, including the ERC721 receiver
interface: ERC721 lots move by plain `transferFrom`, so the house never needs
to accept a `safeTransferFrom`.

## function onERC1155Received

The ERC1155 single-transfer receiver hook. Reverts `EscrowFailed` unless the
incoming transfer's token contract, id, and value exactly match the pull
`create1155Auction` currently has in progress, so an unrelated ERC1155
transfer sent to the house cannot be mistaken for an auction deposit.

## function onERC1155BatchReceived

The ERC1155 batch-transfer receiver hook. Always reverts `EscrowFailed`:
batch deposits into the house are not supported.

## event AuctionCreated

Emitted when an ERC721 auction is registered and its token escrowed. Indexed
by `auctionId`, `tokenId`, and `tokenContract`, and carries `duration`,
`reservePrice`, the seller `tokenOwner`, the initial `fundsRecipient`, and
`listingExpiry`.

## event Auction1155Created

Emitted when an ERC1155 auction is registered and its lot escrowed. Indexed
by `auctionId`, `tokenId`, and `tokenContract`, and carries `quantity`,
`duration`, `reservePrice`, the seller `tokenOwner`, the initial
`fundsRecipient`, and `listingExpiry`.

## event AuctionBid

Emitted on every bid. Indexed by `auctionId` and `bidder`, and carries the
bid `amount`, a `firstBid` flag for the bid that starts the timer, and an
`extended` flag for a bid inside `TIME_BUFFER` that pushed the end time out.

## event AuctionCanceled

Emitted when a pending auction is cancelled by its seller with
`cancelAuction`, or expired by anyone with `expireAuction`, and its lot
returned to the seller. Indexed by `auctionId`.

## event AuctionEnded

Emitted when an auction finalizes, whether directly from `endAuction`,
`claimLot`, or the retry-succeeds path of `unwindStuckLot`. Indexed by
`auctionId`, and carries the seller `tokenOwner`, the `winner`, the
`sellerProceeds`, and the `protocolFee`.

## event AuctionReservePriceUpdated

Emitted when the seller updates the reserve before the first bid lands.
Indexed by `auctionId`, with the new `reservePrice`.

## event AuctionDurationUpdated

Emitted when the seller updates the duration before the first bid lands.
Indexed by `auctionId`, with the new `duration`.

## event AuctionFundsRecipientUpdated

Emitted when the seller redirects the sale proceeds before the first bid
lands. Indexed by `auctionId`, with the new `fundsRecipient`.

## event AuctionListingExpiryUpdated

Emitted when the seller sets or clears the no-bid listing expiry before the
first bid lands. Indexed by `auctionId`, with the new `listingExpiry`.

## event AuctionEndTimeUpdated

Emitted when a late bid pushed the auction end time out. Indexed by
`auctionId`, with the `newEndTime`. Fires alongside the `AuctionBid` whose
`extended` flag is set.

## event DeliveryDeferred

Emitted when `endAuction`'s delivery attempt fails and the lot is deferred.
Indexed by `auctionId` and `winner`. Neither the seller nor the protocol fee
has been paid at this point; the lot is retryable through `claimLot`.

## event LotClaimed

Emitted when `claimLot` or the retry path of `unwindStuckLot` delivers a
previously deferred lot. Indexed by `auctionId` and `winner`, and carries the
actual delivery `recipient`, which can differ from `winner` when the winner
redirected delivery through `claimLot`.

## event LotUnwound

Emitted when `unwindStuckLot`'s retry to the winner still fails after
`PENDING_DELIVERY_TIMEOUT` and the sale unwinds. Indexed by `auctionId` and
`winner`, and carries `refundAmount` (the winner's full bid, already credited
to `pendingRefunds`) and the seller `tokenOwner`. Fires whether or not the
lot's return to the seller in the same call succeeded; if it did not,
`LotReturnDeferred` fires alongside it.

## event LotReturnDeferred

Emitted alongside `LotUnwound` when the attempt to return the lot to
`tokenOwner` fails. Indexed by `auctionId` and `tokenOwner`. The lot stays
locked until `returnUnwoundLot` succeeds.

## event LotReturned

Emitted when `returnUnwoundLot` delivers a previously deferred return to
`tokenOwner`. Indexed by `auctionId` and `tokenOwner`.

## event RefundCredited

Emitted when an ETH amount is credited to a withdrawable `pendingRefunds`
balance instead of being pushed. Indexed by `to`, with the credited `amount`.
Applies to outbid refunds, settlement payouts to contract-code recipients,
and unwound-sale refunds.

## event RefundWithdrawn

Emitted when `withdrawRefund` or `withdrawRefundTo` pays out a credited
balance. Indexed by `account` (whose balance was drained) and `recipient`
(who received the ETH); the two differ only for `withdrawRefundTo`. Carries
the `amount` paid out.

## event StuckERC721Recovered

Emitted when the house owner recovers a misdirected ERC721 with
`recoverStuckERC721`. Indexed by `tokenContract` and `tokenId`, with the `to`
destination.

## event StuckERC1155Recovered

Emitted when the house owner recovers misdirected ERC1155 units with
`recoverStuckERC1155`. Indexed by `tokenContract` and `tokenId`, and carries
the `quantity` and the `to` destination.

## event OwnershipTransferred

Standard OpenZeppelin Ownable event, emitted once at init when the house's
owner is set from the zero address. Ownership is locked afterward, so it
never fires again. Indexed by `previousOwner` and `newOwner`.

## event Initialized

Standard OpenZeppelin Initializable event, emitted once when the clone is
initialized.

## error AuctionAlreadyExistsForToken

A second auction was attempted for a `(tokenContract, tokenId)` that already
has a live one on this house, or a recovery function targeted a token that is
currently registered to an auction. Resolve or clear the first before
retrying.

## error AuctionAlreadySettled

`endAuction` was called on an auction already marked `pendingDelivery` or
`pendingReturn`. Use `claimLot`, `unwindStuckLot`, or `returnUnwoundLot`
instead.

## error AuctionAlreadyStarted

An action that requires a pre-bid auction (`cancelAuction`,
`setAuctionReservePrice`, `setAuctionDuration`, `setAuctionFundsRecipient`, or
`setAuctionListingExpiry`) was attempted after the first bid landed.

## error AuctionDoesNotExist

The given `auctionId` has no live auction in storage: never created, or
already fully resolved.

## error AuctionExpired

Either a bid landed after the auction's end time, or a pre-bid auction's
`listingExpiry` has already passed. In the first case the auction is ready to
settle with `endAuction`; in the second, ready to close with `expireAuction`.

## error AuctionHasNoBids

`endAuction` was called on an auction that never received a bid. An unbid
auction is cancelled by the seller with `cancelAuction`, not ended.

## error AuctionNotEnded

Either `endAuction` was called before the timer ran out, or `expireAuction`
was called on an auction that has already received a bid, has no
`listingExpiry` set, or whose expiry has not yet passed.

## error BidBelowMinimum

A bid did not exceed the current high bid by at least
`MIN_BID_INCREMENT_BPS`.

## error BidBelowReserve

The first bid was below the auction's `reservePrice`.

## error BidMustBePositive

`createBid` was called with a zero `msg.value`.

## error DeliveryFailed

A token transfer's post-transfer balance check disagreed with the expected
result, indicating a malicious or non-standard token contract.

## error EscrowFailed

Either an ERC721 escrow's post-transfer `ownerOf` check disagreed with the
expected owner, or an ERC1155 deposit's `onERC1155Received` hook received a
transfer that did not match the pull currently in progress, or an
`onERC1155BatchReceived` call was attempted at all.

## error FundsRecipientRequired

`setAuctionFundsRecipient` or `withdrawRefundTo` was called with a zero
address.

## error InsufficientGas

`endAuction` or `unwindStuckLot` was called without enough gas headroom to
guarantee the delivery stipend is honored in full.

## error InvalidInitialization

Standard OpenZeppelin Initializable error: `initialize` was called more than
once, or called on the implementation whose initializers are disabled.

## error NoPendingDelivery

`claimLot` or `unwindStuckLot` was called on an auction that is not currently
`pendingDelivery`.

## error NoPendingReturn

`returnUnwoundLot` was called on an auction that is not currently
`pendingReturn`.

## error NotInitializing

Standard OpenZeppelin Initializable error: an `onlyInitializing` step ran
outside an active initialization.

## error NotWinner

`claimLot` was called with a nonzero `to` by an address other than the
auction's recorded winner. Only the winner may redirect delivery.

## error OnlySelf

`deliverERC721` or `deliverERC1155` was called by anything other than this
contract itself. These are internal delivery targets reached only through
`endAuction`'s or `unwindStuckLot`'s try/catch self-calls.

## error OwnableInvalidOwner

Standard OpenZeppelin Ownable error: an invalid owner address (for example
the zero address) was supplied. The initializer rejects a zero owner at
init.

## error OwnableUnauthorizedAccount

Standard OpenZeppelin Ownable error: an owner-gated function was called by a
non-owner. Guards `createAuction`, `bulkCreateAuctions`, `create1155Auction`,
`recoverStuckERC721`, and `recoverStuckERC1155`.

## error OwnershipLocked

`transferOwnership` or `renounceOwnership` was called. Both are permanently
disabled: the house's ownership is fixed at init and cannot be reassigned or
renounced.

## error ReentrancyGuardReentrantCall

Standard OpenZeppelin ReentrancyGuard error: a `nonReentrant` function was
re-entered.

## error UnwindTooEarly

`unwindStuckLot` was called before `PENDING_DELIVERY_TIMEOUT` had elapsed
since the auction entered `pendingDelivery`.

## receive

access: permissionless (payable, but always reverts)

Rejects any direct ETH transfer with `"Direct ETH not accepted"`. Bids must
go through `createBid`, which ties the payment to a specific auction; a bare
transfer has no auction to credit. Forced ETH (selfdestruct, coinbase) is
outside the contract's control and is never accounted for as a bid or
refund.
