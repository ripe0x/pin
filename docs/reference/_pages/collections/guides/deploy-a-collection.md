---
title: Deploy a collection
description: Call the factory to deploy an owned, immutable Surface clone wired to a canonical minter in one transaction.
---

# Deploy a collection

`SurfaceFactory.createSurface` deploys a sequential collection and its
canonical minter together in one transaction: it clones the `Surface`
implementation via EIP-1167, clones a
[FixedPriceMinter](/docs/collections/contracts/fixed-price-minter) bound to it,
grants the minter, and configures both. Both clones are immutable: no proxy
admin, no upgrade path. What deploys is what runs. After deploy, the artist
(the owner) controls the renderer slot and config on the token and the sale
config on the minter; the clones' code never changes.

```solidity
function createSurface(
    string calldata name,
    string calldata symbol,
    address owner,
    SurfaceConfig calldata cfg,
    SaleConfig calldata sale,
    address[] calldata creators
) external returns (address collection, address minter);
```

- `name` / `symbol`: standard ERC721 metadata
- `owner`: the artist. Taken explicitly so a deploy helper (studio backend,
  multisig) can deploy on an artist's behalf
- `cfg`: the token's `SurfaceConfig` struct, below
- `sale`: the canonical minter's `SaleConfig` struct, below
- `creators`: an optional initial creator listing (the owner's side of
  attribution), seeded on the collection at init. Each listed creator completes
  the handshake by claiming the collection in their own Catalog, after which
  `isConfirmedCreator` reads true. Empty for solo works (`owner()` is the
  creator)

The call returns `(collection, minter)` and emits
`SurfaceCreated(owner, collection, minter, idMode)`, the single event an
indexer needs to discover the collection and its minter binding. It also
records the collection in `isSurface` / `allSurfaces`.

Two sibling entrypoints skip the canonical minter:
`createSurfaceCustom(name, symbol, owner, cfg, initialMinters, creators)`
deploys a sequential collection wired to minters you supply, and
`createPooledSurface(...)` deploys a pooled collection (there is no
canonical-minter form for pooled). Both emit `SurfaceCreated` with `minter`
set to `address(0)`.

## SurfaceConfig (the token)

```solidity
struct SurfaceConfig {
    uint256 supplyCap;       // 0 = open supply
    uint16 royaltyBps;       // EIP-2981, advisory
    address royaltyReceiver; // 0 = owner()
    address renderer;        // 0 at init = factory defaultRenderer
    bool rendererLocked;     // one-way; see lockRenderer
    bool supplyLocked;       // one-way; see lockSupply
}
```

- `supplyCap` bounds mints ever on a sequential collection (burns never free a
  new slot). `0` is uncapped. The cap binds every minter, so no grant can
  exceed it
- `royaltyBps` is capped at 5000 (50%); deploy reverts `RoyaltyTooHigh` above
  that
- `renderer` is the one token slot; `0` at init uses the factory's
  `defaultRenderer`. It is changeable later with `setRenderer` until
  `lockRenderer`
- `rendererLocked` / `supplyLocked` passed `true` initialize the collection
  locked, with no second transaction. Both are one-way

## SaleConfig (the canonical minter)

```solidity
struct SaleConfig {
    uint256 price;          // wei; used when priceStrategy is unset
    address priceStrategy;  // 0 = fixed price
    uint64 mintStart;       // unix seconds; 0 = open immediately
    uint64 mintEnd;         // unix seconds; 0 = open-ended
    address payout;         // 0 = live owner() of the collection at settle
    uint256 maxMints;       // 0 = unlimited; this minter's own sale ceiling
    bytes32 allowlistRoot;  // 0 = open
    uint256 walletCap;      // 0 = unlimited; per-recipient
}
```

The factory fills the minter's `collection` field with the token clone it
creates in the same call, so `SaleConfig` is `FixedPriceMinterInitParams` minus
`collection`. Every field here is live config on the minter after deploy
(`setPrice`, `setPriceStrategy`, `setMintWindow`, `setPayout`, `setMaxMints`,
`setAllowlistRoot`, `setWalletCap`), authorized by the collection's owner or an
admin. See [Mint](/docs/collections/guides/mint) for how these drive a mint.

## Generative works: bring your own renderer

`createSurface` takes no work-config parameter. A generative work ships as its
own renderer: deploy a work-specific `IRenderer` that owns its algorithm and
dependency references (however it chooses to store them), then point the
collection's `renderer` slot at it, either as `cfg.renderer` at deploy or later
with `setRenderer`. Edition presets and Solidity-SVG works leave `cfg.renderer`
at zero (the `DefaultRenderer` fallback) or point it at a self-contained SVG
renderer, where the renderer contract itself is the work. See
[Write a renderer](/docs/collections/guides/write-a-renderer) and the
[Injection convention](/docs/collections/reference/injection-convention).

## Deploying with viem

```ts
import {createWalletClient, createPublicClient, http, parseEther} from 'viem';
import {mainnet} from 'viem/chains';
import {surfaceFactoryAbi} from '@pin/abi';

const FACTORY = '{{addr:surfaceFactory}}';
const ZERO = '0x0000000000000000000000000000000000000000';

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});
const walletClient = createWalletClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});

const cfg = {
  supplyCap: 250n,
  royaltyBps: 500,
  royaltyReceiver: ZERO,
  renderer: ZERO,          // factory default renderer
  rendererLocked: false,
  supplyLocked: false,
};

const sale = {
  price: parseEther('0.02'),
  priceStrategy: ZERO,     // fixed price
  mintStart: 0n,
  mintEnd: 0n,
  payout: ZERO,            // live owner() at settle
  maxMints: 0n,
  allowlistRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
  walletCap: 0n,
};

const hash = await walletClient.writeContract({
  address: FACTORY,
  abi: surfaceFactoryAbi,
  functionName: 'createSurface',
  // (name, symbol, owner, cfg, sale, creators)
  args: ['Field Notes', 'FIELD', artistAddress, cfg, sale, []],
});

const receipt = await publicClient.waitForTransactionReceipt({hash});
```

The new collection and minter addresses are in the `SurfaceCreated` event of
the receipt's logs, and are also the return values of `createSurface` if you
call it through a contract rather than an EOA transaction.

## After deploy

On the token, the owner can still call `setRenderer` and the config setters
until they lock things down with `lockRenderer` and `lockSupply`, and manage
minters with `setMinter` / `lockMinter`. On the minter, the owner (or an admin
they grant on the collection) can change the sale config. Presentation data is
published separately: a generative work lives in the artist's own renderer, and
cover art and captures go to
[RenderAssets](/docs/collections/contracts/render-assets). Nothing about either
clone's code changes; only its slot pointers and stored config do. See:

- [Slots and modules](/docs/collections/concepts/four-slots) for the renderer
  slot, the minter, and the price-strategy slot
- [Mint](/docs/collections/guides/mint) for minting through the canonical
  minter
- [Write a minter](/docs/collections/guides/write-a-minter) for pooled or
  economics-carrying collections
- [Surface](/docs/collections/contracts/surface),
  [SurfaceFactory](/docs/collections/contracts/factory), and
  [FixedPriceMinter](/docs/collections/contracts/fixed-price-minter) for the
  full generated function reference
