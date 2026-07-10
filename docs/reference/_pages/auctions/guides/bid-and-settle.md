---
title: Bid and settle
description: The bidder flow: read the minimum, place a bid, handle being outbid and refunds, and settle a finished auction.
---

# Bid and settle

This is the bidder side of a [SovereignAuctionHouse](/docs/auctions/contracts/sovereign-auction-house).
All examples use an `<AUCTION_HOUSE_ADDRESS>` placeholder, since each house is a
per-owner clone with no single fixed address.

## Read the minimum first

The bid amount is the ETH you send (`msg.value`). It must clear the reserve on the
first bid, and beat the current high bid by at least 5% (`MIN_BID_INCREMENT_BPS`) on
every later bid, with a 1-wei floor. Read the exact next minimum with
`getMinBidAmount`, which mirrors the contract's own logic. It returns an `exists`
flag and the minimum in wei:

```bash
cast call <AUCTION_HOUSE_ADDRESS> "getMinBidAmount(uint256)(bool,uint256)" 0 \
  --rpc-url https://ethereum-rpc.publicnode.com
```

You can also read the whole auction with `auctions(auctionId)` to see the current high
bid, high bidder, reserve, and end time.

## Place a bid

`createBid` is payable: send at least the minimum. If the auction has already started,
your bid must land before the end time (`AuctionExpired` otherwise). A bid below the
reserve reverts `BidBelowReserve`; a bid that does not clear the increment reverts
`BidBelowMinimum`; a zero-value call reverts `BidMustBePositive`.

```bash
# Bid 0.55 ETH on auction 0
cast send <AUCTION_HOUSE_ADDRESS> "createBid(uint256)" 0 \
  --value 550000000000000000 \
  --rpc-url https://ethereum-rpc.publicnode.com --private-key $PRIVATE_KEY
```

The first bid starts the timer; the auction then runs for its `duration`.

## The anti-snipe extension

If your bid lands inside the last 15 minutes (`TIME_BUFFER`) before the end time, the
house pushes the end time out to 15 minutes from now. This gives every bidder time to
respond, so an auction cannot be won by sniping the final block. Your bid emits
`AuctionBid` with its `extended` flag set, and an `AuctionEndTimeUpdated` event carries
the new end time. Watch these events to keep a live clock in sync.

## Being outbid and refunds

When you are outbid, the house returns your ETH. It first tries to push the refund
directly to you. If that push fails (for example your wallet is a contract that reverts
on receive), the amount is credited to a pull-payment balance instead and an
`RefundCredited` event fires. Read your balance with `pendingRefunds`:

```bash
cast call <AUCTION_HOUSE_ADDRESS> "pendingRefunds(address)(uint256)" <YOUR_ADDRESS> \
  --rpc-url https://ethereum-rpc.publicnode.com
```

Claim any credited balance with `withdrawRefund`, which pays out only to the caller:

```bash
cast send <AUCTION_HOUSE_ADDRESS> "withdrawRefund()" \
  --rpc-url https://ethereum-rpc.publicnode.com --private-key $PRIVATE_KEY
```

## Settle a finished auction

Once the end time passes and the auction has at least one bid, anyone can settle it
with `endAuction`, including the winner. Settlement transfers the NFT to the winning
bidder, takes the protocol fee for the fee recipient, and sends the rest to the seller.

```bash
cast send <AUCTION_HOUSE_ADDRESS> "endAuction(uint256)" 0 \
  --rpc-url https://ethereum-rpc.publicnode.com --private-key $PRIVATE_KEY
```

Calling it before the timer runs out reverts `AuctionNotEnded`; calling it on an
auction that never received a bid reverts `AuctionHasNoBids`.

## viem: read the minimum, then bid

```ts
import {createWalletClient, createPublicClient, http} from 'viem';
import {mainnet} from 'viem/chains';
import {sovereignAuctionHouseAbi} from '@pin/abi';

const HOUSE = '<AUCTION_HOUSE_ADDRESS>';
const AUCTION_ID = 0n;

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});
const walletClient = createWalletClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});

// Read the exact minimum next bid
const [exists, minBid] = await publicClient.readContract({
  address: HOUSE,
  abi: sovereignAuctionHouseAbi,
  functionName: 'getMinBidAmount',
  args: [AUCTION_ID],
});
if (!exists) throw new Error('no auction');

// Bid the minimum (or more)
const bidHash = await walletClient.writeContract({
  address: HOUSE,
  abi: sovereignAuctionHouseAbi,
  functionName: 'createBid',
  args: [AUCTION_ID],
  value: minBid,
});
await publicClient.waitForTransactionReceipt({hash: bidHash});
```

## viem: settle and claim a refund

```ts
// After the end time, anyone can settle
const endHash = await walletClient.writeContract({
  address: HOUSE,
  abi: sovereignAuctionHouseAbi,
  functionName: 'endAuction',
  args: [AUCTION_ID],
});
await publicClient.waitForTransactionReceipt({hash: endHash});

// If a refund was credited to you, claim it
const owed = await publicClient.readContract({
  address: HOUSE,
  abi: sovereignAuctionHouseAbi,
  functionName: 'pendingRefunds',
  args: [walletClient.account.address],
});
if (owed > 0n) {
  const withdrawHash = await walletClient.writeContract({
    address: HOUSE,
    abi: sovereignAuctionHouseAbi,
    functionName: 'withdrawRefund',
  });
  await publicClient.waitForTransactionReceipt({hash: withdrawHash});
}
```

## Next

See the full path an auction takes, with the fee and refund math, in
[Auction lifecycle](/docs/auctions/concepts/auction-lifecycle), and the seller side in
[Run an auction](/docs/auctions/guides/run-an-auction).
