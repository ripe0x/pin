---
title: IPriceStrategy
---

# summary

IPriceStrategy is the interface a contract implements to occupy a
collection's price slot, one of the
[four swappable slots](/docs/collections/concepts/four-slots) on the
[Surface](/docs/collections/contracts/surface) core. A price
strategy is a view only: the core reads the price and keeps custody of
funds itself, so a strategy can never introduce a theft or reentrancy path.
When a collection's price strategy slot is unset, its stored fixed price
applies instead.

A strategy may read anything available to a view function: `block.basefee`,
companion contract state such as lock counters or attestations, or the
collection itself, since the collection address is passed explicitly. The
reference case is TBAM-shaped dynamic pricing, basefee multiplied by a
function of effective locks. See the
[write a price strategy guide](/docs/collections/guides/write-a-price-strategy) for a
worked implementation.

## function priceOf

view; returns the total price in wei for `quantity` tokens minted by
`minter` on `collection`. The collection address is passed explicitly
rather than read from `msg.sender`, so a single strategy instance can serve
many collections. `data` forwards whatever mint data the caller supplied,
for example a tier selector, and its interpretation is entirely
strategy-defined. When a collection's `priceStrategy` slot holds this
contract's address, the core calls `priceOf` on every paid mint and treats
the return value as the total amount owed for the requested quantity, not a
per-token price.
