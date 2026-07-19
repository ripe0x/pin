---
title: Overview
description: The PND Sovereign Auction House: a per-owner, onchain English-auction house for any ERC721.
---

# Overview

The Sovereign Auction House is an onchain English auction house for ERC721 tokens,
denominated in ETH. Every seller (an artist or a collector) runs their own house: it
is deployed per owner as an immutable EIP-1167 clone, with isolated storage and no
shared custody. It auctions any ERC721, including a PND
[Surface](/docs/surface/contracts/surface) token.

The mechanics are a standard English auction with a small fixed rule set:

- Escrow: creating an auction transfers the NFT into the house and holds it until
  the auction settles or is cancelled
- Reserve: the first bid must meet the auction's reserve price
- Minimum increment: every later bid must beat the current high bid by at least 5%
  (`MIN_BID_INCREMENT_BPS`)
- Anti-snipe extension: a bid inside the last 15 minutes (`TIME_BUFFER`) pushes the
  end time out, so a late bid extends the auction rather than closing it
- Pull-payment refunds: an outbid bidder's ETH is returned immediately, or credited
  to a withdrawable balance if the push fails, and claimed later with
  `withdrawRefund`
- Protocol fee: at settlement the house takes a fixed protocol fee (capped at 5%)
  for the fee recipient and sends the rest to the seller
- Permissionless settlement: after the timer runs out, anyone can call `endAuction`
  to transfer the NFT to the winner and pay everyone out

## The two contracts

- [SovereignAuctionHouse](/docs/auctions/contracts/sovereign-auction-house): the
  per-owner clone that holds the escrowed NFTs, runs the auctions, and pays out. Its
  owner is fixed at init and cannot be changed: `transferOwnership` and
  `renounceOwnership` revert. Each house has no single fixed address, so examples use
  an `<AUCTION_HOUSE_ADDRESS>` placeholder
- [SovereignAuctionHouseFactory](/docs/auctions/contracts/auction-house-factory):
  the shared singleton that deploys houses. Anyone can call `createAuctionHouse` to
  get their own house, owned by the caller, at an address predictable from the owner
  alone. The factory sets the fee terms on every house it creates

## Status

The factory is deployed on Ethereum mainnet at `{{addr:auctionHouseFactory}}`.
Each house is a per-owner clone with no fixed address, so its examples use
`<AUCTION_HOUSE_ADDRESS>`. Read examples use `cast` against a free public RPC;
write examples use viem. See [Conventions](/docs/introduction/conventions) for how
to read the examples, addresses, and units.

