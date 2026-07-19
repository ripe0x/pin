---
title: Conventions
description: How to read examples, addresses, and terms across this reference.
---

# Conventions

## Addresses and transaction links

Every address and transaction link in this reference points at
[evm.now](https://evm.now), a multi-chain explorer:

- Address: `https://evm.now/address/<address>?chainId=1`
- Transaction: `https://evm.now/tx/<hash>?chainId=1`

Shared-singleton addresses (the factory, `DefaultRenderer`, `RenderAssets`)
are written as `{{addr:<key>}}` placeholders in the source of this reference
and substituted with the real mainnet address once each contract is deployed.
A per-artist collection clone has no fixed address; examples use
`<COLLECTION_ADDRESS>` instead.

## Currency and units

The currency label is always **ETH**, never the glyph. Amounts read from the
contracts are wei unless stated otherwise. `bps` means basis points out of
10,000; the referral share, `REFERRAL_SHARE_BPS`, is `1000` (10%).

## Onchain is one word

This reference writes "onchain" as a single word throughout, never hyphenated.

## Pre-deploy examples

The protocols are pre-deploy: no per-owner clone (a collection, an auction
house) exists yet, and the shared singletons are not yet at their mainnet
addresses. Read examples in this reference use `cast` (Foundry) against a
free public RPC, with a placeholder like `<COLLECTION_ADDRESS>` or
`<AUCTION_HOUSE_ADDRESS>` standing in for a clone's address once one exists:

```bash
cast call <COLLECTION_ADDRESS> "totalSupply()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
```

Where an example reads a shared singleton, it uses the `{{addr:...}}` form
so the address resolves automatically once deployed:

```bash
cast call {{addr:surfaceFactory}} "implementation()(address)" --rpc-url https://ethereum-rpc.publicnode.com
```

Write examples use [viem](https://viem.sh). ABIs come from the `@pin/abi`
package or from `/abis/<ContractName>.json`:

```ts
import {fixedPriceMinterAbi} from '@pin/abi';
import {createWalletClient, http} from 'viem';
import {mainnet} from 'viem/chains';

const client = createWalletClient({chain: mainnet, transport: http()});

await client.writeContract({
  address: '<MINTER_ADDRESS>',
  abi: fixedPriceMinterAbi,
  functionName: 'mint',
  // (to, quantity, referrer, data)
  args: [recipient, 1n, referrer, '0x'],
  value: priceWei,
});
```

or, fetching the ABI directly:

```ts
const abi = await fetch('/abis/Surface.json').then((r) => r.json());
```

## Glossary

| Term | Meaning |
| --- | --- |
| Collection | One artist's work, deployed as one `Surface` contract |
| Clone | A collection's contract: an immutable EIP-1167 proxy pointing at the shared implementation |
| Slot | A swappable module: the renderer slot on the token, and the price-strategy slot inside the canonical minter |
| Minter | The mint engine a collection authorizes (`setMinter`); every mint goes through one, and it owns price, window, payment, referral, and gating |
| Referrer | The address credited with hosting a mint (a frontend, a self-hosted page, or none) |
| Referral share | The fixed 10% of the price paid to the referrer by the canonical minter (`REFERRAL_SHARE_BPS`) |
| Provenance | A token's mint order and first/final standing, derived from the id and the live config; the issuing minter and mint index are recorded on the `Minted` event, not in storage |
| Entropy / seed | The per-token `bytes32` stamped at mint (`tokenSeed`), the source of randomness a generative renderer draws from |
| Id mode | Whether a collection assigns ids itself (sequential) or takes minter-supplied ids (pooled), fixed at init |
| Work / work config | The algorithm or asset definition a renderer executes: code refs, dependency refs, render spec, all defined inside the artist's own renderer |
| Lock (permanence) | One-way switches on the collection: `lockRenderer` (pin the renderer pointer, optional) and `lockSupply` (the scarcity promise). A generative work's algorithm permanence comes from the artist's renderer itself (deployed immutable, or with its own one-way lock); pointer lock + an immutable renderer = full presentation permanence |
| Creator / attribution | The owner LISTS creators on the collection (`setCreators`); each confirms by claiming the collection in the Catalog. `isConfirmedCreator` is the live intersection |
