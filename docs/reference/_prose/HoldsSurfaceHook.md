---
contract: HoldsSurfaceHook
slug: holds-surface-hook
deploymentsKey: holdsSurfaceHook
title: HoldsSurfaceHook
---

# summary

A reference [mint hook](/docs/collections/contracts/i-mint-hook) gating a mint on the
minter holding a token from another collection, typically an earlier
collection by the same artist. This is the continuity primitive: it
rewards conviction (the wallets that took provenance risk on collection A
get access to collection B) without financializing anything, since the
gate is bare token ownership, not a snapshot balance or a price. The
required collection can be any ERC721, including another PND collection or
anything off PND entirely. Like the other reference hooks, it's a shared
singleton keyed by the calling collection; see
[four slots](/docs/collections/concepts/four-slots) and
[write a mint hook](/docs/collections/guides/write-a-mint-hook) for how it composes.

## function setRequired

access: owner-only (`onlySurfaceOwner`, checked against the target
collection's current `owner()`; reverts `SC: not collection owner`
otherwise)

Sets the ERC721 contract address a minter must hold a token from to mint
`collection`. The zero address means no gate: `beforeMint` skips the
balance check entirely. Emits `RequiredSet`.

## function afterMint

access: core-only, called by the collection itself as part of its mint
flow (no explicit caller check; the effect is a no-op regardless of
caller)

No-op. HoldsSurfaceHook gates on `beforeMint` alone and keeps no
per-mint record.

## function beforeMint

Checks the calling collection's current requirement for `minter`. If
`requiredOf[msg.sender]` is the zero address, returns the authorizing
selector immediately with no balance check. Otherwise reverts
`SC: must hold required collection` unless
`IERC721(required).balanceOf(minter) > 0`, then returns
`IMintHook.beforeMint.selector`. The check is a live balance read at mint
time, not a snapshot: a wallet that acquires the required token and mints
in the same block, or sells it immediately after, both pass and fail
exactly as their live balance dictates.

## function requiredOf

The ERC721 collection address currently required to mint `collection`, or
the zero address if there's no continuity gate set (either never
configured, or explicitly cleared via
`setRequired(collection, address(0))`).

## event RequiredSet

Emitted on every `setRequired` call, including clearing the gate back to
the zero address. `collection` is indexed. An indexer watching this event
reconstructs the full requirement history for any collection that has ever
used this hook.

## error MustHoldRequired

The minter holds none of the required collection's tokens. Carries the required
collection address.

## error NotSurfaceAdmin

A hook setter was called by an address that is neither the collection's owner
nor one of its admins. Inherited from HookBase — configuring a hook for a
collection needs the same authority as the collection's own setters.
