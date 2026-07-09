---
title: Deploy a collection
description: Call the factory to deploy an owned, immutable SovereignCollection clone, and what each config field controls.
---

# Deploy a collection

Every collection is deployed by `SovereignCollectionFactory.createCollection`, which clones the `SovereignCollection` implementation via EIP-1167 and configures it in the same transaction. The clone is immutable: there is no proxy admin and no upgrade path. What deploys is what runs, forever. After deploy, the artist (the collection's owner) controls the four slots and the config setters; nothing about the clone itself can change.

```solidity
function createCollection(
    string calldata name,
    string calldata symbol,
    address owner,
    CollectionConfig calldata cfg,
    WorkConfig calldata workCfg,
    address[] calldata initialMinters,
    address[] calldata artists
) external returns (address collection);
```

- `name` / `symbol`: standard ERC721 metadata
- `owner`: the artist. Taken explicitly so a deploy helper (studio backend, multisig) can deploy on an artist's behalf
- `cfg`: the `CollectionConfig` struct, below
- `workCfg`: the `WorkConfig` struct, below; empty for renderer-native works (a custom `SVGRenderer` subclass) where the renderer contract IS the algorithm
- `initialMinters`: extension minters granted at init, so a pooled or backed collection deploys fully wired in one transaction. Empty for collections that sell through the built-in fixed-price path
- `artists`: an optional collab roster written to the [Attribution](/docs/collections/contracts/attribution) singleton during the collection's own init. Each artist completes the handshake by claiming the collection in their own Catalog. Ignored when empty or when the factory has no attribution set

The factory emits `CollectionCreated(owner, collection)`, the single event an indexer needs for discovery, and records the address in `isCollection` / `allCollections`.

## CollectionConfig fields

```solidity
struct CollectionConfig {
    string artworkURI;      // shared/cover art; per-token overridable
    uint256 price;          // wei; used when priceStrategy is unset. 0 = gas only
    uint256 supplyCap;      // 0 = open supply
    uint64 mintStart;       // unix seconds; 0 = open immediately
    uint64 mintEnd;         // unix seconds; 0 = open-ended
    uint16 royaltyBps;      // EIP-2981
    address royaltyReceiver; // 0 = owner()
    CollectionKind kind;    // graph role; default Standalone
    address payoutAddress;  // artist proceeds; 0 = owner()
    address renderer;       // 0 = default renderer
    address mintHook;       // 0 = none
    address priceStrategy;  // 0 = stored price
    IdMode idMode;
}
```

- `price` is the fixed price used whenever `priceStrategy` is unset. It has no meaning once a price strategy is set; the strategy's `priceOf` return is authoritative
- `supplyCap` bounds differently by `idMode`: in `Sequential` mode it bounds mints ever (burns never free a new slot); in `Pooled` mode it bounds live supply (a redeemed id returns to the pool and can be minted again)
- `mintStart` / `mintEnd` gate the built-in paid mint paths only. Extension minters own their own schedule; the artist's lever over an extension minter is revoking its grant, not the window
- `royaltyBps` is capped at 5000 (50%) by the contract; deploy reverts `RoyaltyTooHigh` above that
- `kind` is a Release Graph role (`Standalone`, `Study`, `Phase`, `Access`, `Source`, `Continuation`), not surfaced in a basic create flow. Default `Standalone` is correct for most collections
- `renderer`, `mintHook`, `priceStrategy` are three of the four slots, set at init and changeable later by the owner (`renderer` only while metadata isn't frozen). See [The four slots](/docs/collections/concepts/four-slots)
- `idMode` is fixed for the life of the collection. `Sequential` is the default form (the core assigns ids, built-in `mint` works). `Pooled` requires selling through an extension minter from the start; see [Id modes](/docs/collections/concepts/id-modes) and [Write a minter](/docs/collections/guides/write-a-minter)

## WorkConfig fields (generative works)

```solidity
struct WorkConfig {
    CodeRef[] code;         // the algorithm, chunked/named in onchain storage
    CodeRef[] deps;         // library files (gzipped p5/three/etc.)
    string codeURI;         // offchain pointer for oversized code; hash-verified
    bytes32 codeHash;       // integrity hash of the assembled script
    Liveness liveness;
    uint8 injectionVersion; // version of the render-context injection convention
    string renderParams;    // renderer-interpreted settings (aspect, versions)
}
```

`workCfg` only matters for collections that point `renderer` at `GenerativeRenderer` (or another work-config-reading renderer). `code` and `deps` are references into onchain storage (scripty v2 / EthFS): each `CodeRef` names a storage contract, a file name, and whether the file is plain or gzipped. `liveness` declares the work's preservation tier (`Pure`, `ChainLive`, `ExternalLive`); see [Injection convention](/docs/collections/reference/injection-convention) for what each tier promises and how the renderer assembles the document. Leave `workCfg` as its zero value for edition presets and Solidity-SVG works, where the renderer contract itself is the work.

## Deploying with viem

```ts
import {createWalletClient, createPublicClient, http, parseEther} from 'viem';
import {mainnet} from 'viem/chains';
import {sovereignCollectionFactoryAbi} from '@pin/abi';

const FACTORY = '{{addr:collectionFactory}}';

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});
const walletClient = createWalletClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});

const cfg = {
  artworkURI: 'ipfs://bafy.../cover.png',
  price: parseEther('0.02'),
  supplyCap: 250n,
  mintStart: 0n,
  mintEnd: 0n,
  royaltyBps: 500,
  royaltyReceiver: '0x0000000000000000000000000000000000000000',
  kind: 0, // Standalone
  payoutAddress: '0x0000000000000000000000000000000000000000',
  renderer: '0x0000000000000000000000000000000000000000', // default renderer
  mintHook: '0x0000000000000000000000000000000000000000',
  priceStrategy: '0x0000000000000000000000000000000000000000',
  idMode: 0, // Sequential
};

const emptyWork = {
  code: [],
  deps: [],
  codeURI: '',
  codeHash: `0x${'00'.repeat(32)}`,
  liveness: 0, // Pure
  injectionVersion: 0,
  renderParams: '',
};

const hash = await walletClient.writeContract({
  address: FACTORY,
  abi: sovereignCollectionFactoryAbi,
  functionName: 'createCollection',
  args: ['Field Notes', 'FIELD', artistAddress, cfg, emptyWork, [], []],
});

const receipt = await publicClient.waitForTransactionReceipt({hash});
```

The new collection's address is in the `CollectionCreated` event of the receipt's logs, and is also the return value of `createCollection` if you call it through a contract rather than an EOA transaction.

## After deploy

The owner can still call the config setters (`setRenderer`, `setMintHook`, `setPriceStrategy`, `setMinter`, `setPayoutAddress`, `setWork`) until they choose to lock things down with `freezeMetadata` and `lockWork`. Nothing about the clone's code changes; only its slot pointers and stored config do. See:

- [The four slots](/docs/collections/concepts/four-slots) for what each slot controls and when it can change
- [Mint](/docs/collections/guides/mint) for the built-in paid mint paths
- [Write a minter](/docs/collections/guides/write-a-minter) for pooled or economics-carrying collections
- [SovereignCollection](/docs/collections/contracts/sovereign-collection) and [SovereignCollectionFactory](/docs/collections/contracts/factory) for the full generated function reference
