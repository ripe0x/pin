---
title: HookChain
---

# summary

Composes mint hooks: a collection has one hook slot, and a HookChain is how
one slot holds several gates. Point the collection's `setMintHook` at a chain
and every mint runs the chain's whole hook list, in order — an allowlist AND
a per-wallet cap, not one or the other.

A chain is **born final**: the collection and the hook list are fixed in the
constructor, with no setters and no owner. To change the gates, deploy a new
chain (cheap) and point the slot at it — the same deploy-and-swap move as
everything else in the slot architecture.

Because the chain is the caller the sub-hooks see (stock hooks key their
config by `msg.sender`), configure each stock hook **against the chain's
address**: `allowlist.setRoot(address(chain), root)`,
`cap.setCap(address(chain), 2)`. Their admin checks still land on the right
people — the chain answers `ICollectionAuth` by forwarding `owner()` /
`isAdmin()` to its collection. One `hookData` payload travels to every hook
in the chain; hooks that ignore it compose freely with one that decodes it,
and two hooks that both decode it must agree on its shape.

## function collection

The collection this chain serves — the only address allowed to call the mint
callbacks. Fixed in the constructor.

## function hooks

The chained hook addresses, in run order. Fixed in the constructor, never
mutated.

## function owner

Forwarded from the chain's collection (`ICollectionAuth`), so configuring a
stock hook keyed by the chain's address checks the same keys as the
collection's own setters.

## function isAdmin

Forwarded from the chain's collection (`ICollectionAuth`); reports the owner
and every granted admin, exactly as the collection itself does.

## function beforeMint

access: the chain's collection only (else `NotCollection`)

Fans out to every chained hook in order; each must return the magic selector
to authorize. A sub-hook's own revert bubbles up with its reason; a sub-hook
answering the wrong selector reverts `ChainedHookRejected` naming it. Returns
the magic selector once every hook has said yes.

## function afterMint

access: the chain's collection only (else `NotCollection`)

Fans out to every chained hook in order, after tokens are minted and proceeds
are settled — this is where recording hooks (per-wallet counters, mint-time
data) do their writing.

## error CollectionRequired

The constructor was given the zero address, or an address with no code, as
the collection.

## error NotCollection

A mint callback was called by someone other than the chain's collection.

## error ZeroHook

The constructor's hook list contains the zero address.

## error HookNotContract

A constructor hook address has no code (carries the offending address).

## error ChainedHookRejected

A chained hook answered `beforeMint` with the wrong selector (carries the
hook's address). A hook that reverts outright bubbles its own reason instead.
