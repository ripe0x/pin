---
title: Auction lifecycle
description: The full path an auction takes: create and escrow, bid, extend, end, or cancel, plus refunds and the fee math.
---

# Auction lifecycle

An auction on a [SovereignAuctionHouse](/docs/auctions/contracts/sovereign-auction-house)
moves through a fixed set of steps. Each step is a single call, gated by who may make
it and by the auction's current state.

## The steps

| Step | Call | Who | When it is valid |
| --- | --- | --- | --- |
| Create | `createAuction` / `bulkCreateAuctions` | house owner | token owned or approved, no existing auction for the token |
| Set reserve | `setAuctionReservePrice` | seller | before the first bid |
| Bid | `createBid` | anyone (payable) | after create, before the end time |
| Extend | (automatic) | (a bid inside `TIME_BUFFER`) | a bid in the last 15 minutes |
| End | `endAuction` | anyone | after the end time, with at least one bid |
| Cancel | `cancelAuction` / `bulkCancelAuctions` | seller / house owner | before the first bid |
| Claim refund | `withdrawRefund` | the credited address | any time a balance is owed |

## Create and escrow

The house owner calls `createAuction` with the token id, its ERC721 contract, a
`duration` in seconds, and a `reservePrice` in wei. The owner must own or be approved
for the token. The house pulls the NFT in with `transferFrom` and holds it in escrow;
the auction is created with no bids and its timer stopped. `bulkCreateAuctions` does
the same for many tokens of one contract in a single transaction, with one shared
reserve and duration, and reverts the whole batch if any token fails.

A token can have only one live auction on a given house at a time. The auction's
`duration` is stored and consumed later: the timer does not start at creation, it
starts on the first bid.

## Bid

A bidder calls `createBid` and sends ETH as the bid (`msg.value`). The rules:

- The first bid must be at least the reserve, and it starts the timer: the end time
  becomes `firstBidTime + duration`
- Every later bid must beat the current high bid by at least
  `MIN_BID_INCREMENT_BPS` (5%), with a 1-wei floor
- The previously outbid bidder is refunded (see below)

Read the exact minimum next bid with `getMinBidAmount`, which mirrors these rules.

## Extend (anti-snipe)

If a bid lands inside the last `TIME_BUFFER` (15 minutes) before the end time, the
house pushes the end time out to `block.timestamp + TIME_BUFFER`. This guarantees
every bidder at least 15 minutes to respond to a late bid, so an auction cannot be
won by sniping the final block. The extending bid emits `AuctionBid` with its
`extended` flag set, and an `AuctionEndTimeUpdated` event carries the new end time.

## End (settle)

Once `block.timestamp` reaches the end time and the auction has at least one bid,
anyone can call `endAuction`. The house:

1. transfers the NFT to the winning bidder
2. takes the protocol fee (`protocolFeeBps` of the winning bid) for `feeRecipient`
3. sends the remaining proceeds to the seller

An auction that never received a bid cannot be ended (`AuctionHasNoBids`); the seller
cancels it instead.

## Cancel

Before the first bid, the seller can `cancelAuction` to pull the escrowed NFT back
out. Once a bid has landed the auction is a live commitment to its bidders and can no
longer be cancelled (`AuctionAlreadyStarted`). The house owner can cancel many
pre-bid auctions at once with `bulkCancelAuctions`.

## Fee and refund math

At settlement, the winning bid is split:

```
protocolFee     = winningBid * protocolFeeBps / 10000
sellerProceeds  = winningBid - protocolFee
```

The protocol fee is fixed at init and capped at 5% (500 bps). With `protocolFeeBps`
of 0, the seller receives the full winning bid. Read the current fee with
`protocolFeeBps` and the recipient with `feeRecipient`.

Every ETH payout (outbid refund, seller proceeds, protocol fee) uses a
send-or-credit fallback. The house tries to push the ETH directly; if that fails (for
example a contract wallet that reverts on receive), the amount is credited to
`pendingRefunds` and an `RefundCredited` event fires. The credited address later pulls
it with `withdrawRefund`. This is why a single failing recipient never blocks a bid or
a settlement: their funds wait in the pull-payment balance instead. Read a pending
balance with `pendingRefunds(address)`.

## The auction record

Read an auction's full state at any point with `auctions(auctionId)`: the token,
`firstBidTime` (0 before any bid), current high `amount`, `reservePrice`, seller
`tokenOwner`, `endTime` (0 until the first bid), current high `bidder`, and
`duration`. Resolve a token to its auction with `getAuctionFor` or `hasAuctionFor`.
The reference for each call is on the
[SovereignAuctionHouse page](/docs/auctions/contracts/sovereign-auction-house).
