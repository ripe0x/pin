---
title: AllowlistGate
---

# summary

One ownerless singleton gate serving every collection: a Merkle root per
collection, set by that collection's owner. A
[FixedPriceSale](/docs/surface/contracts/fixed-price-sale) with this gate set
asks `check` before each mint. Leaves follow the OpenZeppelin standard Merkle
tree over `abi.encode(address)`, so a list built with
`@openzeppelin/merkle-tree` (`StandardMerkleTree.of(addresses.map(a => [a]),
["address"])`) verifies as is.

An allowlist phase then a public phase is `setGate` to this contract plus
`setRoot`, and later `setGate(0)` on the sale. Deployed at
`{{addr:allowlistGate}}`.

## function setRoot

access: owner-only (the collection's owner, borrowed; `NotAuthorized`)

Sets the root for `collection`. `0` clears it, which makes every check fail.
Emits `RootSet`.

## function check

True when `data` is an abi-encoded `bytes32[]` proof that `to` is in the
collection's list. Empty data or an unset root returns false instead of
reverting. `quantity` is ignored.

## function root

The root for a collection, or zero.

## event RootSet

A collection's root changed.

## error NotAuthorized

`setRoot` from someone other than the collection's owner, including after a
renounce.
