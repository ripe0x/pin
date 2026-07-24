---
title: IPriceStrategy
---

# summary

IPriceStrategy is the interface a contract implements to occupy the price
slot inside a collection's minter, the optional pricing module on the
canonical [FixedPriceMinter](/docs/surface/contracts/fixed-price-minter)
(see the [slots and modules](/docs/surface/concepts/four-slots)
overview). A price strategy is a view only: the minter reads the price and
keeps custody of funds itself, so a strategy can never introduce a theft or
reentrancy path. When the minter's price-strategy slot is unset, its stored
fixed price applies instead.

A strategy may read anything available to a view function: `block.basefee`,
companion contract state such as lock counters or attestations, or the
collection itself, since the collection address is passed explicitly. The
reference case is TBAM-shaped dynamic pricing, basefee multiplied by a
function of effective locks. See the
[write a price strategy guide](/docs/surface/guides/write-a-price-strategy) for a
worked implementation.

## function priceOf

view; returns the total price in wei for `quantity` tokens quoted for
`minter` on `collection`. `minter` is the mint recipient the quote is for:
`FixedPriceMinter` passes the mint's `to` address, the same address its gates
evaluate. The collection address is passed explicitly rather than read from
`msg.sender`, so a single strategy instance can serve many collections. There is
no caller-supplied data parameter: the price is a function of `(collection,
minter, quantity)` and chain state only, so caller input cannot steer a quote.
When the minter's `priceStrategy` slot holds this
contract's address, the minter calls `priceOf` on every paid mint and treats
the return value as the total amount owed for the requested quantity, not a
per-token price.
