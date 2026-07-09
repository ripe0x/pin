---
title: IMintHook
---

# summary

IMintHook is the interface a contract implements to occupy a collection's
hook slot, one of the [four swappable slots](/docs/collections/concepts/four-slots) on
the [SovereignCollection](/docs/collections/contracts/sovereign-collection) core. An
artist-owned mint hook lets an artist gate mints, `beforeMint` reverts or
returns the wrong selector, or record custom data to their own storage,
`afterMint`, without either feature living in the core itself.

Trust in a hook is scoped to the artist who installed it: the core calls
whatever address sits in its `mintHook` slot, and an owner who installs a
malicious or buggy hook is only gating their own collection. Hooks are
non-payable, so a hook can never touch the honest-pricing invariant by
intercepting or redirecting funds. Hooks run on every mint path, the
built-in paid paths and any extension minter's `mintTo`/`mintToAt`, so
gating composes with custom minters instead of being reimplemented inside
each one. See the [write a mint hook guide](/docs/collections/guides/write-a-mint-hook)
for a worked implementation.

## function beforeMint

access: core-only (called by the collection holding this hook in its
`mintHook` slot, as part of a mint transaction; a hook that does not return
the correct selector causes the core to revert `HookRejected`)

Called by the collection immediately before minting, with the minting
`minter` address, `quantity`, the `firstTokenId` about to be assigned, the
`surface` that originated the mint, and any `hookData` forwarded by the
caller. Must return `IMintHook.beforeMint.selector` to authorize the mint;
any other return value causes the core to revert `HookRejected` and the
entire mint transaction to fail. A hook that wants to gate a mint, an
allowlist check, a per-wallet cap, a token-holding requirement, simply
reverts or returns a different value from within this function.

## function afterMint

access: core-only (called by the collection holding this hook in its
`mintHook` slot, after tokens are minted and payment is settled)

Called by the collection after tokens have been minted and proceeds paid,
with the same `minter`, `quantity`, `firstTokenId`, `surface`, and
`hookData` as the preceding `beforeMint` call. Non-payable: the function
cannot receive or move funds, so it is useful only for recording
observations, incrementing a hook's own counters, or emitting events, never
for redirecting mint proceeds.
