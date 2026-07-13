---
contract: PerWalletCapHook
slug: per-wallet-cap-hook
deploymentsKey: perWalletCapHook
title: PerWalletCapHook
---

# summary

A reference [mint hook](/docs/collections/contracts/i-mint-hook) capping how many
tokens any single wallet can mint from a collection, so a capped drop
can't be bought out by one address in a single transaction (or across
several). Like [AllowlistHook](/docs/collections/contracts/allowlist-hook), it's a
shared singleton keyed by the calling collection: any collection can
attach it via `setMintHook`, and state for one collection is fully
isolated from every other collection using the same instance. See
[four slots](/docs/collections/concepts/four-slots) and
[write a mint hook](/docs/collections/guides/write-a-mint-hook) for how the hook slot
composes with the rest of a collection.

The count this hook enforces is cumulative and permanent per wallet: once
minted, a token counts against that wallet's cap forever, even if the
token is later transferred or burned.

## function setCap

access: owner-only (`onlyCollectionOwner`, checked against the target
collection's current `owner()`; reverts `SC: not collection owner`
otherwise)

Sets the per-wallet mint cap for `collection`. A cap of `0` means
unlimited: `beforeMint` skips the count check entirely. Setting a new cap
takes effect on the next mint; it does not retroactively invalidate
tokens already minted above a newly-lowered cap. Emits `CapSet`.

## function afterMint

access: core-only, called by the collection itself as part of its mint
flow (no explicit caller check; the collection is trusted to report
accurate mint counts)

Increments `mintedBy[collection][minter]` by `quantity`. Runs after the
mint has already succeeded and proceeds have been paid, so the count only
advances on a mint that actually completed; a `beforeMint` revert never
reaches this far.

## function beforeMint

Checks the calling collection's current cap for `minter`. If
`capOf[msg.sender]` is `0`, returns the authorizing selector immediately
with no count check. Otherwise reverts `SC: wallet cap` unless
`mintedBy[msg.sender][minter] + quantity <= cap`, then returns
`IMintHook.beforeMint.selector`. A multi-token mint that would cross the
cap reverts as a whole; there's no partial fill.

## function capOf

The per-wallet mint cap currently set for `collection`, or `0` if
uncapped (either never configured, or explicitly cleared via
`setCap(collection, 0)`).

## function mintedBy

Cumulative tokens `minter` has minted from `collection` through this
hook's `afterMint`. Monotonically increasing; never decremented by
transfers or burns.

## event CapSet

Emitted on every `setCap` call, including clearing the cap back to `0`.
`collection` is indexed. An indexer watching this event reconstructs the
full cap history for any collection that has ever used this hook.

## error WalletCapExceeded

The mint would push the wallet's running count for this collection past the
per-wallet cap. Carries the cap and the attempted total.

## error NotCollectionAdmin

A hook setter was called by an address that is neither the collection's owner
nor one of its admins. Inherited from HookBase — configuring a hook for a
collection needs the same authority as the collection's own setters.
