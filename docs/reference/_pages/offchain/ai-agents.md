---
title: AI agents
description: Where to start as an agent or integrator: the manifest, llms.txt, per-contract ABIs, and how to discover per-owner clones through each factory.
---

# AI agents

This page is the entry point for automated consumers of the PND onchain protocols: agents, indexers, bots, and retrieval pipelines. Everything below is a public read or a permissionless call; nothing needs an API key.

## Start here

| Surface | URL | What it is |
| --- | --- | --- |
| Protocol manifest | [`/protocol-manifest.json`](/protocol-manifest.json) | Shared-singleton addresses, ABI paths, and docs links, grouped by protocol |
| LLM orientation | [`/llms.txt`](/llms.txt) | A compact map of the whole reference, with absolute links |
| Contract ABIs | `/abis/<ContractName>.json` | One plain ABI array per contract |
| Docs search index | [`/docs-search-index.json`](/docs-search-index.json) | Every docs section as a retrievable record |
| Reference | `/docs` | This documentation, generated from the ABIs plus hand-written prose |

Read [ABIs and the protocol manifest](/docs/offchain/abis-and-manifest) for the full shape of each file.

## The clone model: why there's no fixed instance list

Both protocols deploy per owner. Every artist collection is its own `SovereignCollection` clone from `SovereignCollectionFactory`; every auction house is its own `SovereignAuctionHouse` clone from `SovereignAuctionHouseFactory`. There is no registry of "all instances" beyond each factory itself. Treat every clone address as a first-class contract and read its own state directly.

## Discovering collections

The collection factory emits one event per deploy:

```solidity
event CollectionCreated(address indexed owner, address indexed collection);
```

```ts
import {createPublicClient, webSocket, parseAbiItem} from 'viem';
import {mainnet} from 'viem/chains';

const client = createPublicClient({chain: mainnet, transport: webSocket()});

client.watchEvent({
  address: '{{addr:collectionFactory}}',
  event: parseAbiItem('event CollectionCreated(address indexed owner, address indexed collection)'),
  onLogs: (logs) => {
    for (const log of logs) console.log('new collection', log.args.collection, 'by', log.args.owner);
  },
});
```

For a point-in-time list, read the factory arrays:

```bash
cast call {{addr:collectionFactory}} "totalCollections()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:collectionFactory}} "allCollections(uint256)(address)" 0 --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:collectionFactory}} "isCollection(address)(bool)" 0xSomeAddress --rpc-url https://ethereum-rpc.publicnode.com
```

`isCollection(address)` is the cheap way to confirm an address is a real collection from this factory before trusting anything it returns.

## Discovering auction houses

The auction factory works the same way, with one house per owner:

```solidity
event AuctionHouseCreated(address indexed owner, address indexed house, address feeRecipient, uint16 protocolFeeBps);
```

```bash
cast call {{addr:auctionHouseFactory}} "totalHouses()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:auctionHouseFactory}} "houseOf(address)(address)" 0xOwner --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:auctionHouseFactory}} "isHouse(address)(bool)" 0xSomeAddress --rpc-url https://ethereum-rpc.publicnode.com
```

`predictHouseAddress(owner)` returns the deterministic clone address for an owner before they deploy.

## Reading a clone once you have its address

```bash
cast call <COLLECTION_ADDRESS> "totalSupply()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call <COLLECTION_ADDRESS> "currentPrice(address,uint256,bytes)(uint256)" 0x0000000000000000000000000000000000000000 1 0x --rpc-url https://ethereum-rpc.publicnode.com
cast call <AUCTION_HOUSE_ADDRESS> "getAuctionFor(address,uint256)(bool,uint256)" <COLLECTION_ADDRESS> 1 --rpc-url https://ethereum-rpc.publicnode.com
```

Or via viem with the typed ABI:

```ts
import {createPublicClient, http} from 'viem';
import {mainnet} from 'viem/chains';
import {sovereignCollectionAbi} from '@pin/abi';

const client = createPublicClient({chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com')});

const [cfg, status, minted] = await client.readContract({
  address: '<COLLECTION_ADDRESS>',
  abi: sovereignCollectionAbi,
  functionName: 'config',
});
```

## What to read next depends on what you're building

- Deploying a collection programmatically: [Deploy a collection](/docs/collections/guides/deploy-a-collection)
- Minting against a known collection: [Mint](/docs/collections/guides/mint)
- Watching mint activity: subscribe to `Minted` on the collection itself, documented on [SovereignCollection](/docs/collections/contracts/sovereign-collection)
- Rendering a generative token identically to the onchain output: [Injection convention](/docs/collections/reference/injection-convention)
- Deploying and running an auction house: [Deploy an auction house](/docs/auctions/guides/deploy-an-auction-house) and [Run an auction](/docs/auctions/guides/run-an-auction)
- Watching auction activity: subscribe to `AuctionCreated`, `AuctionBid`, and `AuctionEnded` on the house, documented on [SovereignAuctionHouse](/docs/auctions/contracts/sovereign-auction-house)

## Pre-deploy status

The protocols are pre-deploy: every address above is a placeholder until launch, and `/protocol-manifest.json` carries `null` addresses until then. Contract and interface behavior in this reference reflects the code as written.
