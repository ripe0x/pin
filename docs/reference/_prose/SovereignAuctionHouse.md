---
title: SovereignAuctionHouse
---

# summary

An onchain English auction house for ERC721 tokens, denominated in ETH. One
house is deployed per owner as an immutable EIP-1167 clone by
[the factory](/docs/auctions/contracts/auction-house-factory): the seller (an
artist or a collector) gets their own instance with isolated storage. There is
no proxy admin and no upgrade path: what deploys is what runs. The
upgradeable-variant OZ base is used only for the initializer pattern that clones
require.

The house holds ownership, the escrowed NFTs, the live bid state, and the
pull-payment refund balances. The owner creates auctions on their house, which
escrows each NFT into the contract. Bidders call `createBid` (payable) to compete;
each bid must clear the reserve and beat the current high bid by
`MIN_BID_INCREMENT_BPS` (5%). Bids landing inside the final `TIME_BUFFER`
(15 minutes) push the end time out, so no one can win by sniping the last block.
After the timer runs out, anyone can call `endAuction` to settle: the NFT goes to
the winner, the seller receives the proceeds minus `protocolFeeBps`, and the fee
goes to `feeRecipient`. Both fee values are written once at init by the factory
defaults and never change on a live house.

Ownership is locked at init. `transferOwnership` and `renounceOwnership` revert
`OwnershipLocked`, so the house can never be reassigned away from its original
owner and the factory's owner-to-house map stays stable. The owner can call
`recoverStuckERC721` to rescue an NFT that landed on the house outside the auction
flow, but never a token that is currently registered in an active auction.

# concepts

An English auction here runs entirely onchain, in ETH, with a small fixed rule
set:

- Reserve: the first bid must be at least the auction's `reservePrice`, else
  `BidBelowReserve`. The seller can adjust the reserve with
  `setAuctionReservePrice`, but only before the first bid lands
- Minimum increment: every later bid must exceed the current high bid by at least
  `MIN_BID_INCREMENT_BPS` (5%), with a 1-wei floor so a tiny prior bid can't be
  matched exactly. A short bid reverts `BidBelowMinimum`. Read the exact next
  minimum with `getMinBidAmount`
- Timer and time-buffer extension: the auction timer does not start until the
  first bid. From that moment the auction runs for its `duration`. Any bid inside
  the last `TIME_BUFFER` (15 minutes) pushes the end time to `block.timestamp +
  TIME_BUFFER`, guaranteeing every bidder at least that long to respond. This is
  the anti-snipe rule
- Pull-payment refunds: when a bidder is outbid, the house tries to push their ETH
  back immediately. If that push fails (for example a contract wallet that reverts
  on receive), the amount is credited to `pendingRefunds` and the bidder claims it
  later with `withdrawRefund`. The same fallback protects the seller payout and the
  protocol fee at settlement, so one failing recipient never blocks the others
- Protocol fee: at settlement the house takes `protocolFeeBps` of the winning bid
  for `feeRecipient` and sends the rest to the seller. The fee is capped at 5%
  (500 bps) and fixed at init
- NFT escrow: creating an auction transfers the NFT into the house with
  `transferFrom`, after a post-transfer `ownerOf` check (`EscrowFailed` on a
  misbehaving token). The house intentionally does not implement
  `IERC721Receiver`, so a direct `safeTransferFrom` from outside reverts at the
  source. Settlement and cancellation transfer the NFT back out with plain
  `transferFrom`

Each auction is keyed by an incrementing `auctionId` and also indexed by
`(tokenContract, tokenId)`, so a token can have only one live auction on a given
house at a time (`AuctionAlreadyExistsForToken` on a duplicate). Read an auction's
full state with `auctions(auctionId)`, or resolve a token to its auction with
`getAuctionFor` / `hasAuctionFor`.

### Live reads

```bash
# The minimum next bid in wei for an auction (exists flag + amount)
cast call <AUCTION_HOUSE_ADDRESS> "getMinBidAmount(uint256)(bool,uint256)" 0 \
  --rpc-url https://ethereum-rpc.publicnode.com

# The protocol fee in bps (e.g. 250 = 2.5%)
cast call <AUCTION_HOUSE_ADDRESS> "protocolFeeBps()(uint16)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# The fixed minimum bid increment in bps (500 = 5%)
cast call <AUCTION_HOUSE_ADDRESS> "MIN_BID_INCREMENT_BPS()(uint16)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# Whether a token is currently in auction on this house
cast call <AUCTION_HOUSE_ADDRESS> "hasAuctionFor(address,uint256)(bool)" \
  <TOKEN_CONTRACT> 42 \
  --rpc-url https://ethereum-rpc.publicnode.com
```

Each house is a per-owner clone with no single fixed address, so the examples use
an `<AUCTION_HOUSE_ADDRESS>` placeholder; the address lands when the owner deploys
their house through the factory.

## function createAuction

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Registers one auction and escrows its NFT into the house. The caller must be the
house owner, and must also own or be approved for the token: the house checks
`ownerOf`, `getApproved`, and `isApprovedForAll` and reverts `Not token owner or
approved` if none holds. The token contract must advertise the ERC721 interface
(`tokenContract is not ERC721` otherwise), `duration` must be greater than zero and
at most 100 years (`duration zero` / `duration too large`), and the token must not
already have an auction on this house (`AuctionAlreadyExistsForToken`). The house
transfers the NFT in with `transferFrom` and verifies it landed (`EscrowFailed`).
The auction is created with no bids and its timer stopped: `duration` is stored and
consumed on the first bid to compute the end time. Returns the new `auctionId` and
emits `AuctionCreated`.

## function bulkCreateAuctions

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Registers many auctions for the same token contract in one transaction, applying
the same `reservePrice` and `duration` to each. It runs the exact same per-token
checks and escrow as `createAuction` for every id, and reverts the whole batch if
any single one fails (unapproved token, duplicate listing, non-ERC721 contract,
bad duration). Returns the new `auctionId` array aligned with `tokenIds` and emits
one `AuctionCreated` per token.

## function createBid

access: permissionless (payable; any caller may bid, guarded by reserve, increment, and timer checks)

Places a bid on an auction, where the bid amount is the ETH sent (`msg.value`). The
value must be greater than zero (`BidMustBePositive`). If the auction has already
started, it must not be past its end time (`AuctionExpired`). The first bid must
meet the reserve (`BidBelowReserve`) and starts the timer, setting the end time to
now plus `duration`. Every later bid must beat the current high bid by at least
`MIN_BID_INCREMENT_BPS` (`BidBelowMinimum`); read the exact floor with
`getMinBidAmount`. The previously outbid bidder is refunded: the house pushes their
ETH back, or credits `pendingRefunds` and emits `RefundCredited` if the push fails.
If this bid lands inside the last `TIME_BUFFER`, the end time is pushed out to
`block.timestamp + TIME_BUFFER` and `AuctionEndTimeUpdated` is emitted. Reverts
`AuctionDoesNotExist` for an unknown id. Emits `AuctionBid` with the `firstBid` and
`extended` flags.

## function setAuctionReservePrice

access: seller-only (`msg.sender` must be the auction's `tokenOwner`, else the call reverts `Not token owner`)

Updates an auction's reserve price. Only the seller who created the auction may
call it, and only before the first bid lands (`AuctionAlreadyStarted` afterward).
Reverts `AuctionDoesNotExist` for an unknown id. Emits
`AuctionReservePriceUpdated`.

## function cancelAuction

access: seller-only (`msg.sender` must be the auction's `tokenOwner`, else the call reverts `Not token owner`)

Cancels a pending auction and returns the escrowed NFT to the seller. Only valid
before the first bid (`AuctionAlreadyStarted` once a bid has landed), since a
started auction is a live commitment to its bidders. Reverts `AuctionDoesNotExist`
for an unknown id. Clears the token's reverse index and auction state and emits
`AuctionCanceled`.

## function bulkCancelAuctions

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Cancels multiple pending auctions in one transaction. This is gated on the house
owner rather than each auction's seller, so it can cancel an auction the owner
listed on behalf of another holder via ERC721 approval; the NFT always returns to
its real owner, so funds are never at risk. Every auction must still be pre-bid,
and the batch reverts on any already-started auction (`AuctionAlreadyStarted`) or
unknown id (`AuctionDoesNotExist`). Emits one `AuctionCanceled` per auction.

## function endAuction

access: permissionless (any caller may settle an ended auction)

Settles a finished auction. Anyone can call it once the timer has run out. The
auction must have had at least one bid (`AuctionHasNoBids`) and must be past its
end time (`AuctionNotEnded`). The house transfers the NFT to the winning bidder
with plain `transferFrom`, takes `protocolFeeBps` of the winning bid for
`feeRecipient`, and sends the remaining proceeds to the seller. Each payout uses the
send-or-credit fallback, so a recipient that rejects ETH is credited to
`pendingRefunds` (via `RefundCredited`) rather than blocking settlement. Reverts
`AuctionDoesNotExist` for an unknown id. Clears the auction and emits
`AuctionEnded` with the seller proceeds and protocol fee.

## function withdrawRefund

access: permissionless (any caller drains only their own credited balance)

Claims the ETH credited to the caller in `pendingRefunds`, from an outbid refund or
a settlement payout that could not be pushed. Reverts `No refund available` when the
caller has a zero balance. Zeroes the balance before transferring, and reverts
`Withdraw failed` if the ETH transfer fails (the balance is restored by the revert).
Emits `RefundWithdrawn`.

## function recoverStuckERC721

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Rescues an ERC721 that landed on the house outside the auction flow, for example a
holder who did a plain `transferFrom` directly to the house address. Reverts `to
required` for a zero destination, and `AuctionAlreadyExistsForToken` if the token is
currently registered in an active auction, so a live escrowed NFT can never be
pulled out from under its bidders. Transfers the token to `to` and emits
`StuckERC721Recovered`.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`)

Sets up the clone exactly once with its owner, `feeRecipient`, and
`protocolFeeBps`. Reverts `owner required` for a zero owner, `fee above cap` for a
fee over 500 bps (5%), and `fee recipient required when fee > 0` when a non-zero fee
has no recipient. The constructor disables initializers on the implementation, so
only clones can be initialized, and only once. Sets the owner (emitting
`OwnershipTransferred` from the zero address) and warms the reentrancy-guard slot.
Emits `Initialized`.

## function auctions

The full stored state of an auction by id: `tokenId`, `tokenContract`,
`firstBidTime` (0 before any bid), current high `amount`, `reservePrice`, seller
`tokenOwner`, `endTime` (0 until the first bid), current high `bidder`, and
`duration` in seconds. A zero `tokenOwner` means no auction exists at that id.

## function getAuctionFor

Resolves a `(tokenContract, tokenId)` to its live auction: returns an `exists` flag
and the `auctionId`. The tuple shape disambiguates "no auction" from "auction id 0",
which are otherwise indistinguishable.

## function hasAuctionFor

A cheap boolean check for whether a token is currently in an auction on this house,
when the `auctionId` itself is not needed.

## function getMinBidAmount

The minimum next bid in wei for an auction, paired with an `exists` flag so a caller
can tell "no auction" apart from "minimum is zero". Mirrors exactly what `createBid`
enforces: the reserve for the first bid, else the current high bid plus the
`MIN_BID_INCREMENT_BPS` increment with the 1-wei floor.

## function nextAuctionId

The auction id that the next `createAuction` call will assign. Useful for clients
that want to pre-compute the id before broadcasting the transaction.

## function pendingRefunds

The pull-payment balance in wei currently owed to an address, from an outbid refund
or a settlement payout whose push failed. Claimable with `withdrawRefund`.

## function protocolFeeBps

The protocol fee in basis points taken from each winning bid at settlement, fixed at
init and capped at 500 (5%).

## function feeRecipient

The address that receives the protocol fee at settlement, fixed at init. It is the
zero address only when `protocolFeeBps` is zero.

## function MIN_BID_INCREMENT_BPS

The minimum increment a later bid must add over the current high bid, as a
compile-time constant: 500 bps (5%). Not owner-set. A 1-wei floor applies when the
bps math on a tiny bid rounds to zero.

## function TIME_BUFFER

The anti-snipe window as a compile-time constant: 15 minutes. A bid inside the last
`TIME_BUFFER` before the end time pushes the end time out to `block.timestamp +
TIME_BUFFER`.

## function owner

The house owner, fixed at init: the address that creates and cancels auctions and
can recover stuck NFTs. Ownership is locked, so this value never changes.

## function transferOwnership

Disabled: this function is pure and always reverts `OwnershipLocked`. Ownership is
fixed at init so the house can never be reassigned away from its original owner,
which keeps the factory's owner-to-house map stable and prevents a house from being
moved out from under escrowed NFTs.

## function renounceOwnership

Disabled: this function is pure and always reverts `OwnershipLocked`. Renouncing
would orphan the house and strand its owner-only levers, so it is permanently
disabled alongside `transferOwnership`.

## event AuctionCreated

Emitted when an auction is registered and its NFT escrowed. Indexed by `auctionId`,
`tokenId`, and `tokenContract`, and carries the `duration`, `reservePrice`, and
seller `tokenOwner`. This is the event an indexer reads to record a new listing.

## event AuctionBid

Emitted on every bid. Indexed by `auctionId` and `bidder`, and carries the bid
`amount`, a `firstBid` flag for the bid that starts the timer, and an `extended`
flag for a bid inside `TIME_BUFFER` that pushed the end time out.

## event AuctionCanceled

Emitted when a pending auction is cancelled and its NFT returned to the seller.
Indexed by `auctionId`.

## event AuctionEnded

Emitted when an auction settles. Indexed by `auctionId`, and carries the seller
`tokenOwner`, the `winner`, the `sellerProceeds`, and the `protocolFee`, so an
indexer can recover the full payout breakdown without re-running the fee math.

## event AuctionEndTimeUpdated

Emitted when a late bid pushed the auction end time out. Indexed by `auctionId`,
with the `newEndTime`. Fires alongside the `AuctionBid` whose `extended` flag is
set.

## event AuctionReservePriceUpdated

Emitted when the seller updates the reserve before the first bid lands. Indexed by
`auctionId`, with the new `reservePrice`.

## event RefundCredited

Emitted when an ETH push fails and the amount is credited to a withdrawable
`pendingRefunds` balance instead. Indexed by `to`, with the credited `amount`.
Applies to outbid refunds, seller proceeds, and the protocol fee.

## event RefundWithdrawn

Emitted when a recipient claims their credited refund with `withdrawRefund`. Indexed
by `to`, with the `amount` paid out.

## event StuckERC721Recovered

Emitted when the house owner recovers a misdirected ERC721 that landed on the house
outside the auction flow. Indexed by `tokenContract` and `tokenId`, with the `to`
destination.

## event OwnershipTransferred

Standard OpenZeppelin Ownable event, emitted once at init when the house's owner is
set from the zero address. Ownership is locked afterward, so it never fires again.
Indexed by `previousOwner` and `newOwner`.

## event Initialized

Standard OpenZeppelin Initializable event, emitted once when the clone is
initialized.

## error AuctionAlreadyExistsForToken

A second auction was attempted for a `(tokenContract, tokenId)` that already has a
live one on this house, or `recoverStuckERC721` targeted a token that is currently
in an auction. Cancel or settle the first to free the slot.

## error AuctionAlreadyStarted

An action that requires a pre-bid auction (`cancelAuction`, `bulkCancelAuctions`, or
`setAuctionReservePrice`) was attempted after the first bid landed. A started
auction is a live commitment to its bidders.

## error AuctionDoesNotExist

The given `auctionId` has no live auction in storage (never created, or already
settled or cancelled).

## error AuctionExpired

A bid landed after the auction's end time. The auction has closed and is ready to
settle with `endAuction`.

## error AuctionHasNoBids

`endAuction` was called on an auction that never received a bid. An unbid auction is
cancelled by the seller with `cancelAuction`, not ended.

## error AuctionNotEnded

`endAuction` was called before the timer ran out. Wait until `block.timestamp`
reaches the auction's `endTime`.

## error BidBelowMinimum

A bid did not exceed the current high bid by at least `MIN_BID_INCREMENT_BPS` (with
the 1-wei floor). Read the exact minimum with `getMinBidAmount` and bid at least
that.

## error BidBelowReserve

The first bid was below the auction's `reservePrice`. The opening bid must meet the
reserve.

## error BidMustBePositive

`createBid` was called with a zero `msg.value`. A bid must send a positive amount of
ETH.

## error EscrowFailed

The post-transfer `ownerOf` check after escrowing an NFT into the house disagreed
with the expected owner, indicating a malicious or non-standard ERC721. The auction
is not created.

## error InvalidInitialization

Standard OpenZeppelin Initializable error: `initialize` was called more than once,
or called on the implementation whose initializers are disabled.

## error NotInitializing

Standard OpenZeppelin Initializable error: an `onlyInitializing` step ran outside an
active initialization.

## error OwnableInvalidOwner

Standard OpenZeppelin Ownable error: an invalid owner address (for example the zero
address) was supplied. The initializer rejects a zero owner at init.

## error OwnableUnauthorizedAccount

Standard OpenZeppelin Ownable error: an owner-gated function was called by a
non-owner. Guards `createAuction`, `bulkCreateAuctions`, `bulkCancelAuctions`, and
`recoverStuckERC721`.

## error OwnershipLocked

`transferOwnership` or `renounceOwnership` was called. Both are permanently disabled:
the house's ownership is fixed at init and cannot be reassigned or renounced.

## error ReentrancyGuardReentrantCall

Standard OpenZeppelin ReentrancyGuard error: a `nonReentrant` function was
re-entered.

## receive

access: permissionless (payable, but always reverts)

Rejects any direct ETH transfer with `"Direct ETH not accepted"`. Bids must go
through `createBid`, which ties the payment to a specific auction; a bare
transfer has no auction to credit. Forced ETH (selfdestruct, coinbase) is
outside the contract's control and is never accounted for as a bid or refund.
