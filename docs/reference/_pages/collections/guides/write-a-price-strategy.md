---
title: Write a price strategy
description: Implement IPriceStrategy's view-only priceOf, install it on the minter with setPriceStrategy, and two worked examples.
---

# Write a price strategy

A price strategy is a swappable module that quotes the price for a mint. It is
the optional price slot inside the canonical
[FixedPriceMinter](/docs/collections/contracts/fixed-price-minter), the one
thing the minter calls to determine `msg.value` requirements when a fixed price
does not fit.

```solidity
interface IPriceStrategy {
    function priceOf(
        address collection,
        address minter,
        uint256 quantity,
        bytes calldata data
    ) external view returns (uint256);
}
```

- `collection`: the collection being minted, passed explicitly so one strategy
  instance can serve many collections
- `minter`: the wallet requesting the mint (the recipient the minter passes)
- `quantity`: tokens requested in this call
- `data`: the same blob the mint call carries, forwarded unchanged;
  strategy-defined (tier selectors, a signed price, whatever the form needs)

The return value is the total price in wei for `quantity` tokens.

## Why it's view-only

`priceOf` is a `view` function: it cannot write state, hold funds, or make an
external call that changes anything. The minter reads the quote once per mint
and keeps custody of the funds itself (it calls `priceOf` a single time and
reuses that value for both the payment check and the settlement split), so a
price strategy can never introduce a theft or reentrancy path, no matter how it
is written. A work whose economics need to hold or move funds (per-token
backing, an ERC20 swap) uses a custom minter instead of a strategy; see
[Write a minter](/docs/collections/guides/write-a-minter).

Because it is a view, a strategy is free to read anything readable:
`block.basefee`, the collection's own state via
[ISurfaceView](/docs/collections/contracts/i-surface-view), companion contracts
(lock counters, attestation boards), or any other onchain data. It just cannot
act on what it reads.

## Installing a strategy

```solidity
function setPriceStrategy(address strategy) external; // on the minter; collection owner or admin
```

`setPriceStrategy` lives on the minter, not the token, and is authorized by the
collection's owner or an admin (the minter borrows that authority). Setting
`address(0)` reverts to the minter's stored fixed `price`. A minter with no
strategy set uses that stored price directly; setting a strategy overrides it
entirely, including for the `priceOf` reads mint surfaces use to display a live
quote.

## Example: fixed price per collection

The simplest useful strategy: a shared singleton that serves a fixed
per-collection price, set by each collection's own owner or an admin (useful
when a factory-level default should apply across many collections).

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IPriceStrategy} from "./interfaces/IPriceStrategy.sol";

interface ISurfaceAuth {
    function owner() external view returns (address);
    function isAdmin(address account) external view returns (bool);
}

contract FixedPriceStrategy is IPriceStrategy {
    mapping(address => uint256) public priceOf_; // collection => wei per token

    event PriceSet(address indexed collection, uint256 price);

    function setPrice(address collection, uint256 price) external {
        require(
            msg.sender == ISurfaceAuth(collection).owner() || ISurfaceAuth(collection).isAdmin(msg.sender),
            "not collection owner or admin"
        );
        priceOf_[collection] = price;
        emit PriceSet(collection, price);
    }

    function priceOf(address collection, address, uint256 quantity, bytes calldata)
        external
        view
        override
        returns (uint256)
    {
        return priceOf_[collection] * quantity;
    }
}
```

## Example: dynamic, reads chain state

A basefee-scaled price, the reference shape for participatory or evolving works
(TBAM-style pricing: `basefee x f(companion state)`). This example scales with
`block.basefee` and a per-collection multiplier the owner or an admin sets,
clamped to a floor:

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IPriceStrategy} from "./interfaces/IPriceStrategy.sol";

interface ISurfaceAuth {
    function owner() external view returns (address);
    function isAdmin(address account) external view returns (bool);
}

contract BasefeeScaledStrategy is IPriceStrategy {
    struct Config {
        uint256 floor;       // wei, minimum price per token
        uint256 multiplier;  // basefee scalar, 18-decimal fixed point
    }

    mapping(address => Config) public configOf;

    event ConfigSet(address indexed collection, uint256 floor, uint256 multiplier);

    function setConfig(address collection, uint256 floor, uint256 multiplier) external {
        require(
            msg.sender == ISurfaceAuth(collection).owner() || ISurfaceAuth(collection).isAdmin(msg.sender),
            "not collection owner or admin"
        );
        configOf[collection] = Config({floor: floor, multiplier: multiplier});
        emit ConfigSet(collection, floor, multiplier);
    }

    function priceOf(address collection, address, uint256 quantity, bytes calldata)
        external
        view
        override
        returns (uint256)
    {
        Config memory c = configOf[collection];
        uint256 perToken = (block.basefee * c.multiplier) / 1e18;
        if (perToken < c.floor) perToken = c.floor;
        return perToken * quantity;
    }
}
```

Because `priceOf` reads `block.basefee` at call time, the quote a collector
sees offchain can move before their transaction lands. The minter handles this
the same way for any strategy: it requires `msg.value >= required` rather than
an exact match, and refunds the excess as a pull payment claimable via
`withdraw`. See [Mint](/docs/collections/guides/mint) for the full
payment-resolution rule.

## Reading the current price

```bash
cast call <MINTER_ADDRESS> "priceOf(address,uint256,bytes)(uint256)" \
  0xRecipientAddress 1 0x \
  --rpc-url https://ethereum-rpc.publicnode.com
```

The minter's `priceOf` resolves through whichever strategy is set (or the
stored price if none is), so callers never need to know which is active.

See [IPriceStrategy](/docs/collections/contracts/i-price-strategy) for the
generated interface reference, and
[Slots and modules](/docs/collections/concepts/four-slots) for how this slot
relates to the renderer and the minter.
