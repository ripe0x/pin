---
title: Mint
description: The built-in paid mint paths, price resolution, sale windows, and the reverts to handle.
---

# Mint

Every `Sequential`-mode collection exposes two built-in, payable mint paths on the collection contract itself. Both take exact or sufficient payment, assign the next sequential token ids, and stamp a Mint Mark and entropy per token.

```solidity
function mint(uint256 quantity) external payable;
function mintWithRewards(uint256 quantity, address surface, bytes calldata hookData) external payable;
```

- `mint(quantity)` mints directly to `msg.sender` with `surface = address(0)`. Since a surface share only pays out when a surface is credited, this path sends 100% of the price to the artist
- `mintWithRewards(quantity, surface, hookData)` credits `surface` its share of the price (`SURFACE_SHARE_BPS`, a fixed 10%) via [SovereignCollection](/docs/collections/contracts/sovereign-collection)'s `_settle`. Passing `surface = address(0)` folds the share back to the artist, same as `mint`. `hookData` is forwarded unchanged to the mint hook and, when set, the price strategy

Pooled collections do not expose either path: `PooledSellsViaMinter` reverts any call to `mint` or `mintWithRewards` when `idMode` is `Pooled`. A pooled collection sells exclusively through an authorized extension minter, which owns the id pool. See [Write a minter](/docs/collections/guides/write-a-minter).

## Price resolution

If the collection has no price strategy set (`priceStrategy() == address(0)`), the price is `cfg.price * quantity`, and payment must match exactly: any other `msg.value` reverts `WrongPayment`.

If a price strategy is set, the collection calls `priceOf(collection, minter, quantity, hookData)` on it once and requires `msg.value >= required`; underpayment reverts `Underpayment`. Overpayment does not revert. It accrues to the payer as a pull-refund, claimable via `withdraw(msg.sender)`, since a strategy's quote can move between when a collector reads it and when their transaction lands (for example a basefee-denominated price).

Read the resolved price ahead of a mint with `currentPrice`:

```bash
cast call <COLLECTION_ADDRESS> "currentPrice(address,uint256,bytes)(uint256)" \
  0xYourAddress 1 0x \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## Sale windows and status

`mintStart` / `mintEnd` (unix seconds, both optional) gate the built-in paths only:

- Before `mintStart`: reverts `MintNotStarted`
- At or after `mintEnd` (when set): reverts `MintEnded`

Each minted token's Mint Mark stamps the collection's lifecycle status at that moment (`Open`, `Closing`, or `Closed`), read via `mintMarkOf(tokenId).statusAtMint`. `Closing` is a purely informational flag the artist sets with `setClosing`; it does not block mints. `Closed` on the built-in path is unreachable at mint time, since the window and cap checks already revert before a mint can land once the collection is closed; a mark can only read `Closed` via the extension path (a pooled re-mint after the window, which is a legitimate redeem cycle).

## Supply cap

`ExceedsCap` reverts when a mint would push past `supplyCap` (0 means uncapped). The check differs by `idMode`: `Sequential` bounds total mints ever; `Pooled` bounds live supply, since a redeemed id returns to the pool.

## cast example

```bash
cast send <COLLECTION_ADDRESS> "mint(uint256)" 1 \
  --value 0.02ether \
  --rpc-url https://ethereum-rpc.publicnode.com \
  --private-key $PRIVATE_KEY
```

```bash
cast send <COLLECTION_ADDRESS> "mintWithRewards(uint256,address,bytes)" \
  1 0xYourSurfaceAddress 0x \
  --value 0.02ether \
  --rpc-url https://ethereum-rpc.publicnode.com \
  --private-key $PRIVATE_KEY
```

## viem example

```ts
import {createWalletClient, createPublicClient, http, parseEther} from 'viem';
import {mainnet} from 'viem/chains';
import {sovereignCollectionAbi} from '@pin/abi';

const COLLECTION = '<COLLECTION_ADDRESS>';

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});
const walletClient = createWalletClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});

const price = await publicClient.readContract({
  address: COLLECTION,
  abi: sovereignCollectionAbi,
  functionName: 'currentPrice',
  args: [walletClient.account.address, 1n, '0x'],
});

const hash = await walletClient.writeContract({
  address: COLLECTION,
  abi: sovereignCollectionAbi,
  functionName: 'mintWithRewards',
  args: [1n, surfaceAddress, '0x'],
  value: price,
});

await publicClient.waitForTransactionReceipt({hash});
```

## Reverts to handle

| Error | Cause |
| --- | --- |
| `ZeroQuantity` | `quantity == 0` |
| `MintNotStarted` | before `mintStart` |
| `MintEnded` | at or after `mintEnd` |
| `PooledSellsViaMinter` | called on a `Pooled`-mode collection |
| `WrongPayment` | fixed-price mint, `msg.value != required` |
| `Underpayment` | strategy-priced mint, `msg.value < required` |
| `ExceedsCap` | mint would exceed `supplyCap` |
| `HookRejected` | the collection's mint hook declined the mint |

After a successful mint, claim any accrued balance (artist proceeds, surface share, or your own overpayment refund) with `withdraw(account)`, a permissionless trigger that always pays the owed address, never the caller:

```bash
cast send <COLLECTION_ADDRESS> "withdraw(address)" 0xPayeeAddress \
  --rpc-url https://ethereum-rpc.publicnode.com --private-key $PRIVATE_KEY
```

See [Write a minter](/docs/collections/guides/write-a-minter) for pooled collections and any collection whose economics (backing, dynamic settlement, id draws) need to live outside the built-in path, and [Write a mint hook](/docs/collections/guides/write-a-mint-hook) for gating logic that runs on every mint path.
