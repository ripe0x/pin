---
contract: GateHook
slug: gate-hook
deploymentsKey: gateHook
title: GateHook
---

# summary

A reference [mint hook](/docs/collections/contracts/i-mint-hook) composing a
Merkle allowlist and a per-wallet cap into ONE hook. The core has a single
mint hook slot, and a real gated drop typically wants both gates at once, an
allowlist without a per-wallet cap invites a listed wallet to sweep the
supply. Each gate is independently optional per collection (root `0` = open,
cap `0` = uncapped), so one deployed instance also covers either single-gate
case; [AllowlistHook](/docs/collections/contracts/allowlist-hook) and
[PerWalletCapHook](/docs/collections/contracts/per-wallet-cap-hook) remain
available as minimal, single-purpose references. See
[four slots](/docs/collections/concepts/four-slots) and
[write a mint hook](/docs/collections/guides/write-a-mint-hook) for how the
hook slot composes with the rest of a collection.

Semantics match the single-purpose hooks exactly: the same OpenZeppelin
standard-merkle-tree leaf format as `AllowlistHook`
(`keccak256(bytes.concat(keccak256(abi.encode(account))))`), the same
`hookData` shape (a `bytes32[]` proof, which only travels through
`mintWithReferral`, plain `mint()` carries no `hookData`, so an
allowlist-gated mint on this hook MUST go through `mintWithReferral`), and
the same error strings as both single-purpose hooks so a UI maps one set of
messages regardless of which hook a collection uses.

Config authority is the collection's owner OR its admins, the same borrow
[GenerativeRenderer](/docs/collections/contracts/generative-renderer) uses
for its work registry, rather than the owner-only gate the other reference
hooks use: a drop is typically operated by the artist's team, not only the
owner key.

The wallet counter is written only while a cap is active, so an uncapped
collection pays no counting SSTORE per mint. Enabling a cap mid-sale
therefore counts only from that point forward; mints that happened before
the cap was set are not retroactively charged against it.

## function setRoot

access: collection owner or admin (`onlyCollectionAdmin`, checked against
the target collection's current `owner()` or `isAdmin(msg.sender)`; reverts
`"SC: not collection owner/admin"` otherwise)

Sets the Merkle root gating mints for `collection`. A root of `bytes32(0)`
means open, no allowlist gate: `beforeMint` skips the proof check entirely.
Setting a new root replaces the previous one immediately; there is no
history kept onchain beyond the `RootSet` event stream. Emits `RootSet`.

## function setCap

access: collection owner or admin (same `onlyCollectionAdmin` gate as
`setRoot`)

Sets the per-wallet mint cap for `collection`. A cap of `0` means uncapped:
`beforeMint` skips the count check and `afterMint` skips the counting write
entirely. Setting a new cap takes effect on the next mint; it does not
retroactively invalidate tokens already minted above a newly-lowered cap.
Emits `CapSet`.

## function afterMint

access: core-only, called by the collection itself as part of its mint flow
(no explicit caller check; the collection is trusted to report accurate mint
counts)

Increments `mintedBy[collection][minter]` by `quantity`, but only while
`capOf[collection]` is nonzero. Runs after the mint has already succeeded
and proceeds have been paid, so the count only advances on a mint that
actually completed; a `beforeMint` revert never reaches this far.

## function beforeMint

Checks both gates for the calling collection in one call, whichever are
active. If `rootOf[msg.sender]` is nonzero, decodes `hookData` as a
`bytes32[]` Merkle proof and verifies it against the leaf
`keccak256(bytes.concat(keccak256(abi.encode(minter))))`, reverting
`"SC: not allowlisted"` if it doesn't verify. If `capOf[msg.sender]` is
nonzero, reverts `"SC: wallet cap"` unless
`mintedBy[msg.sender][minter] + quantity <= cap`. Returns
`IMintHook.beforeMint.selector` once every active check passes. With either
gate at its zero value that check is skipped entirely; with both at zero the
hook is fully open, equivalent to no hook installed.

## function remainingFor

How many more tokens `wallet` may mint from `collection` under the current
cap: `type(uint256).max` when uncapped, otherwise `cap - mintedBy[collection][wallet]`,
saturating at `0` if a cap was lowered below what a wallet already minted.
Gives a UI the quantity clamp for a mint form in a single read.

## function rootOf

The Merkle root currently gating `collection`, or `bytes32(0)` if there's no
allowlist gate set (either never configured, or explicitly cleared via
`setRoot(collection, bytes32(0))`).

## function capOf

The per-wallet mint cap currently set for `collection`, or `0` if uncapped
(either never configured, or explicitly cleared via
`setCap(collection, 0)`).

## function mintedBy

Tokens `wallet` (second key) has minted from `collection` (first key) while
a cap was active. Only advances through `afterMint`, and only while
`capOf[collection]` was nonzero at mint time, so this count reflects mints
taken under a cap, not necessarily every token the wallet has ever minted
from the collection.

## event RootSet

Emitted on every `setRoot` call, including clearing the gate back to
`bytes32(0)`. `collection` is indexed. An indexer watching this event
reconstructs the full root history for any collection that has ever used
this hook.

## event CapSet

Emitted on every `setCap` call, including clearing the cap back to `0`.
`collection` is indexed. An indexer watching this event reconstructs the
full cap history for any collection that has ever used this hook.
