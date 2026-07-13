---
contract: AllowlistHook
slug: allowlist-hook
deploymentsKey: allowlistHook
title: AllowlistHook
---

# summary

A reference [mint hook](/docs/collections/contracts/i-mint-hook) gating minting to a
Merkle allowlist, the standard shape for a presale. Like every hook in the
reference set, it's a shared singleton: one deployed instance serves any
number of collections, keyed by `msg.sender` (the calling collection) in
`beforeMint`/`afterMint`, and any collection on or off PND can attach it
via `setMintHook`. Hooks only gate or record; they hold no funds and never
receive value, so attaching one changes who can mint, never where the ETH
goes. See [four slots](/docs/collections/concepts/four-slots) for how the hook slot
fits the rest of a collection's configuration, and
[write a mint hook](/docs/collections/guides/write-a-mint-hook) for building your own.

Leaves use the OpenZeppelin standard-merkle-tree format
(`keccak256(bytes.concat(keccak256(abi.encode(account))))`), so proofs
built with the standard JS tooling (`@openzeppelin/merkle-tree`) verify
against this contract without translation.

## function setRoot

access: owner-only (`onlyCollectionOwner`, checked against the target
collection's current `owner()`; reverts `SC: not collection owner`
otherwise)

Sets the Merkle root gating mints for `collection`. A root of `bytes32(0)`
means no gate: `beforeMint` skips the proof check entirely and any minter
passes. Setting a new root replaces the previous one immediately; there is
no history kept onchain beyond the `RootSet` event stream. Emits
`RootSet`.

## function afterMint

access: core-only, called by the collection itself as part of its mint
flow (no explicit caller check; the effect is a no-op regardless of
caller)

No-op. AllowlistHook gates on `beforeMint` alone and keeps no per-mint
count, so there's nothing to record once a mint succeeds.

## function beforeMint

Verifies the calling collection's current allowlist gate for `minter`. If
`rootOf[msg.sender]` is the zero root, returns the authorizing selector
immediately with no proof check. Otherwise decodes `hookData` as a
`bytes32[]` Merkle proof and verifies it against the leaf
`keccak256(bytes.concat(keccak256(abi.encode(minter))))`; reverts
`SC: not allowlisted` if the proof doesn't verify, and returns
`IMintHook.beforeMint.selector` if it does. A minter without a proof to
submit will revert here rather than at the collection.

## function rootOf

The Merkle root currently gating `collection`, or `bytes32(0)` if the
collection has no allowlist gate set (either never configured, or
explicitly cleared via `setRoot(collection, bytes32(0))`).

## event RootSet

Emitted on every `setRoot` call, including clearing the gate back to
`bytes32(0)`. `collection` is indexed. An indexer watching this event
reconstructs the full root history for any collection that has ever used
this hook.

## error NotAllowlisted

The minter's Merkle proof did not verify against the collection's allowlist
root. Raised in `beforeMint` when a non-zero root is set.

## error NotCollectionAdmin

A hook setter was called by an address that is neither the collection's owner
nor one of its admins. Inherited from HookBase — configuring a hook for a
collection needs the same authority as the collection's own setters.
