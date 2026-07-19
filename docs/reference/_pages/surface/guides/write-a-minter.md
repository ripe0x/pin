---
title: Write a minter
description: Implement a minter, get authorized via setMinter, and mint through the token's minter-gated mintTo or mintToId.
---

# Write a minter

A minter is any contract the collection owner authorizes to mint tokens. Every
mint goes through one: the token holds no sale logic, so the minter owns price,
window, payment, referral, and gating. The canonical
[FixedPriceMinter](/docs/surface/contracts/fixed-price-minter) covers the
common priced drop and the factory wires it automatically; you write your own
when a work needs economics the canonical minter does not do (dynamic
settlement, ERC20 backing, id draws) or when the collection is pooled, which
has no canonical minter.

## Authorization

The owner grants (or revokes) a minter explicitly, per address, on the token:

```solidity
function setMinter(address minter, bool allowed) external; // owner or admin (owner-only on pooled)
function isMinter(address minter) external view returns (bool);
```

`setMinter` authorizes a minter contract; revoking it withdraws that
authorization (a revoked minter can no longer call `mintTo`/`mintToId`, but
tokens it already minted are unaffected). `lockMinter` freezes the set
permanently.

## The token's mint entrypoints

```solidity
function mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId); // Sequential
function mintToId(address to, uint256 tokenId) external;                                // Pooled
```

Both are non-payable and revert `NotMinter` if `msg.sender` is not authorized.
Which one exists depends on the collection's `idMode`, fixed at deploy:

- **Sequential**: call `mintTo`. The core assigns ids from its mint-order
  counter, mints `quantity` consecutive ids, returns the first, and emits one
  `Minted` event. The sequential form has no `mintToId`; its absence from the
  ABI is the guarantee, not a runtime check
- **Pooled**: call `mintToId`, supplying the id yourself (`tokenId == sourceId`
  is the intended shape: the minter owns whatever pool or source mapping
  decides which id mints next; id `0` is legal). The pooled form has no
  `mintTo`

Both enforce the supply cap (`ExceedsCap`) and write a `tokenSeed` per token. Neither enforces a mint window or runs any external code: the token's
mint path is a pure internal state transition. Your minter owns the schedule,
and the artist's control over it is `setMinter(minter, false)`.

## Value handling is entirely yours

`mintTo` and `mintToId` take no `msg.value` and do no payment accounting. If
your minter is a paid mint, it is responsible for:

- collecting and validating payment (ETH, an ERC20, a swap route, whatever the
  form needs), and refunding or escrowing as needed
- honoring the referral share by convention, not by contract guarantee. The
  canonical minter pays a fixed 10% (`REFERRAL_SHARE_BPS`) out of the price to
  the referrer; nothing on the token enforces it, so a custom minter sets its
  own referral policy
- paying out (or escrowing) proceeds itself, since the token holds no value and
  runs no pull-payment ledger

## The value-facing shape (`IMinter`)

Stock minters present one value-facing ABI so a frontend and indexer see the
same shape regardless of which minter a collection uses:

```solidity
function mint(address to, uint256 quantity, address referrer, bytes calldata data) external payable;
function priceOf(address to, uint256 quantity, bytes calldata data) external view returns (uint256);
```

`to` is the recipient and the address any gate evaluates; `msg.sender` is the
payer, and refunds accrue to the payer. `data` carries caller-supplied gate
input (a Merkle proof). The canonical minter implements exactly this; a custom
minter that adopts it plugs into the same mint surfaces. Per-minter config
(price, window, gates, payout) is each minter's own surface, not part of
`IMinter`.

## Config authority: borrow it from the collection

The canonical minter has no `Ownable` of its own. Its setters check the
collection's `owner()`/`isAdmin`, so one owner and admin set governs both
contracts and an ownership transfer on the collection invalidates delegated
admin access to the minter's config too. Borrowing authority this way is the recommended pattern
for a custom minter.

## Burn semantics differ by id mode

`burn(tokenId)` on the token is mode-gated:

- **Sequential**: standard owner-or-approved burn. Burned ids are never reused
- **Pooled**: only an authorized minter may burn (`NotAuthorized` otherwise).
  A pooled collection's tokens carry backing, pool membership, or other
  minter-owned state that a holder-initiated burn would strand. A pooled minter
  typically wraps its own `redeem()` around `burn`, releasing whatever it owes
  the holder before or as part of the call

A burned pooled id can be minted again via `mintToId` as a brand new instance:
fresh seed, fresh escrow if the minter tracks any. The prior instance's history
stays readable in emitted events and offchain indexing.

## Minimal minter skeleton

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

interface ISurfaceMint {
    function mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId);
}

interface ISurfaceAuth {
    function owner() external view returns (address);
    function isAdmin(address account) external view returns (bool);
}

/// @notice Minimal fixed-price sequential minter: takes exact payment, mints
///         through the collection's minter entrypoint, forwards the referrer
///         share by convention, and pays the artist the rest. One instance
///         bound to one collection.
contract SimpleMinter {
    uint16 constant REFERRAL_SHARE_BPS = 1_000; // 10%
    uint16 constant BPS = 10_000;

    address public immutable collection;
    uint256 public price;

    event PriceSet(uint256 price);

    constructor(address collection_, uint256 price_) {
        collection = collection_;
        price = price_;
    }

    modifier onlySurfaceAdmin() {
        require(
            msg.sender == ISurfaceAuth(collection).owner() || ISurfaceAuth(collection).isAdmin(msg.sender),
            "not collection owner or admin"
        );
        _;
    }

    function setPrice(uint256 price_) external onlySurfaceAdmin {
        price = price_;
        emit PriceSet(price_);
    }

    function mint(address to, uint256 quantity, address referrer) external payable returns (uint256 firstTokenId) {
        uint256 total = price * quantity;
        require(msg.value == total, "wrong payment");

        firstTokenId = ISurfaceMint(collection).mintTo(to, quantity);

        uint256 referralCut = referrer != address(0) ? (total * REFERRAL_SHARE_BPS) / BPS : 0;
        if (referralCut > 0) {
            (bool okR,) = referrer.call{value: referralCut}("");
            require(okR, "referral payout failed");
        }
        uint256 artistCut = total - referralCut;
        if (artistCut > 0) {
            (bool okA,) = ISurfaceAuth(collection).owner().call{value: artistCut}("");
            require(okA, "artist payout failed");
        }
    }
}
```

The canonical `FixedPriceMinter` does the same job with the safer pull-payment
pattern (proceeds accrue and recipients withdraw, so a reverting recipient
cannot block minting), plus a price strategy, a window, a sale ceiling, and
optional allowlist and per-wallet-cap gates. Prefer cloning it over hand-rolling
value handling; write your own only for economics it does not cover. A pooled
minter follows the same shape but calls `mintToId(to, sourceId)` with an id it
owns the logic for, and typically pairs `redeem()`/`burn` with releasing
per-token backing.

## After deploying a minter

```bash
cast send <COLLECTION_ADDRESS> "setMinter(address,bool)" <MINTER_ADDRESS> true \
  --rpc-url https://ethereum-rpc.publicnode.com --private-key $PRIVATE_KEY
```

See [Id modes](/docs/surface/concepts/id-modes) for the sequential/pooled
contract in full, [Mint](/docs/surface/guides/mint) for minting through the
canonical minter, and
[FixedPriceMinter](/docs/surface/contracts/fixed-price-minter) for the
reference implementation.
