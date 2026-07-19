---
title: Deploy an auction house
description: Call the factory to deploy your own per-owner auction house, and predict its address ahead of time.
---

# Deploy an auction house

An auction house is deployed per owner. You get your own house by calling
`createAuctionHouse` on the shared
[SovereignAuctionHouseFactory](/docs/auctions/contracts/auction-house-factory). The
new house is owned by you (the caller), initialized with the factory's default fee
terms, and deployed at an address predictable from your address alone.

## One house per owner

Each address can have exactly one house from this factory. A second
`createAuctionHouse` call from the same address reverts `House already exists`. Check
whether you already have one with `houseOf`:

```bash
cast call {{addr:auctionHouseFactory}} "houseOf(address)(address)" \
  <YOUR_ADDRESS> \
  --rpc-url https://ethereum-rpc.publicnode.com
```

A zero address means you have not deployed one yet.

## Predict the address first

The house address is deterministic from the owner address, so you can show or use it
before the deploy transaction lands:

```bash
cast call {{addr:auctionHouseFactory}} "predictHouseAddress(address)(address)" \
  <YOUR_ADDRESS> \
  --rpc-url https://ethereum-rpc.publicnode.com
```

Do not send ETH or NFTs to the predicted address before the house exists: funds sent
there pre-deploy are not recoverable. Deploy the house first, then interact with it.

## The init defaults

Every house this factory deploys is initialized with the factory's own fee terms,
which are fixed at the factory's construction and shared across all its houses:

- `defaultFeeRecipient`: the address that receives the protocol fee at settlement
- `defaultProtocolFeeBps`: the protocol fee in basis points, capped at 500 (5%)

Read them off the factory:

```bash
cast call {{addr:auctionHouseFactory}} "defaultProtocolFeeBps()(uint16)" \
  --rpc-url https://ethereum-rpc.publicnode.com

cast call {{addr:auctionHouseFactory}} "defaultFeeRecipient()(address)" \
  --rpc-url https://ethereum-rpc.publicnode.com
```

These land on your house as `protocolFeeBps` and `feeRecipient` and are locked there;
they never change on a live house. To run under different fee terms you would deploy
against a different factory.

## Deploy with cast

```bash
cast send {{addr:auctionHouseFactory}} "createAuctionHouse()(address)" \
  --rpc-url https://ethereum-rpc.publicnode.com \
  --private-key $PRIVATE_KEY
```

The call returns your house address and emits `AuctionHouseCreated` with your address
and the house both indexed.

## Deploy with viem

```ts
import {createWalletClient, createPublicClient, http} from 'viem';
import {mainnet} from 'viem/chains';
import {sovereignAuctionHouseFactoryAbi} from '@pin/abi';

const FACTORY = '{{addr:auctionHouseFactory}}';

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});
const walletClient = createWalletClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});

// Predict the address up front
const predicted = await publicClient.readContract({
  address: FACTORY,
  abi: sovereignAuctionHouseFactoryAbi,
  functionName: 'predictHouseAddress',
  args: [walletClient.account.address],
});

// Deploy the house
const hash = await walletClient.writeContract({
  address: FACTORY,
  abi: sovereignAuctionHouseFactoryAbi,
  functionName: 'createAuctionHouse',
});

await publicClient.waitForTransactionReceipt({hash});

// Resolve the deployed house (equals `predicted`)
const house = await publicClient.readContract({
  address: FACTORY,
  abi: sovereignAuctionHouseFactoryAbi,
  functionName: 'houseOf',
  args: [walletClient.account.address],
});
```

## Next

With a house deployed, list a token with [Run an auction](/docs/auctions/guides/run-an-auction),
and see how collectors compete and settle in [Bid and settle](/docs/auctions/guides/bid-and-settle).
