# Surface v2 internal audit, 2026-09-14

Scope: the five v2 files at commit `bacfcfcd`: `contracts/src/surface/v2/SurfaceV2.sol`,
`contracts/src/surface/v2/SurfaceFactoryV2.sol`,
`contracts/src/surface/v2/minters/FixedPriceMinterV2.sol`,
`contracts/src/surface/v2/interfaces/ISurfaceV2.sol`,
`contracts/src/surface/v2/interfaces/ISeedSourceV2.sol`.

Method: a single-pass manual review applying the solidity-auditor skill's
mental-tool protocol (Feynman, Socratic, inversion) and its access-control,
economic-security, invariant, numerical-gap and trust-gap lenses. Two proof
of concept tests were written to confirm the findings below, run once, then
deleted; the working tree stayed clean throughout. The review compared v2
against its design record (`docs/pnd-surface-v2-plan.md`) and against v1's
audited baseline (`docs/pnd-surface-audit-scope.md`).

## Summary

| Severity | Title | Status |
|---|---|---|
| Medium | Wallet cap does not bound a wallet's true total once the wallet minted during an unlimited window | Resolved, commit `2ac736b9` |
| Low | `lockRoyalty()` can lock a live indirection instead of a fixed address | Resolved, commit `2ac736b9` |
| Lead | `seedSource` has no functional check and no recovery path if it reverts permanently | Accepted design tradeoff |
| Lead | `mintToSeeded` permits duplicate seeds across tokens | Accepted design tradeoff |

## Findings

### Medium: wallet cap does not bound a wallet's true total once the wallet minted during an unlimited window

Location: `FixedPriceMinterV2.sol`, `_executeMint`.

`mintedBy[to]` was written only inside `if (cap != 0)`, while `totalMinted`
was written unconditionally in the same function. A collector who minted
during a `walletCap == 0` window, then continued minting after the owner
raised `walletCap` above 0, got the new cap applied on top of an unaccounted
prior balance instead of as a true ceiling. Launching uncapped and applying
a per-wallet cap once the drop is live is an ordinary operational sequence,
and every step that produces the gap is an unprivileged mint call.

A PoC minted 50 tokens to one wallet during an unlimited window
(`mintedBy` stayed 0), set `walletCap` to 5, and minted 5 more from the same
wallet: the mint succeeded and `mintedBy` read 5, while `totalMinted` for
that wallet was actually 55.

Resolution, commit `2ac736b9`: `mintedBy[to]` is now written unconditionally,
the same way `totalMinted` already was. A wallet cap now bounds a wallet's
lifetime mints through the minter regardless of whether earlier mints
happened during an uncapped window.

### Low: `lockRoyalty()` could lock a live indirection instead of a fixed address

Location: `SurfaceV2.sol`, `lockRoyalty`, `seal`, `royaltyInfo`.

`royaltyInfo` resolves a zero `royaltyReceiver` to the live `owner()`.
`lockRoyalty()`'s NatSpec stated it locks the royalty receiver permanently,
but it only set `_royaltyLocked = true`; it never resolved a zero receiver
to a concrete address. An owner who locked royalty while the receiver was
still zero, then performed an ordinary ownership transfer unrelated to
`seal()`, changed the effective royalty payee on a collection that markets
its lock as permanent.

A PoC set a 500 bps royalty with a zero receiver, called `lockRoyalty()`,
and read `royaltyInfo` (receiver resolved to the artist, the live owner at
that time). After `transferOwnership`/`acceptOwnership` to a buyer,
`royaltyInfo` resolved to the buyer under the same lock.

Resolution, commit `2ac736b9`: `lockRoyalty()` and `seal()` now route
through a shared `_engageRoyaltyLock()`. When `royaltyReceiver` is still
zero at lock time, it snapshots the current `owner()` into
`_cfg.royaltyReceiver` and emits `RoyaltySet` before setting
`_royaltyLocked = true`. The locked payee is a fixed address from that
point on, and stays at that address across any later ownership transfer.

## Residual notes

Two leads surfaced during the review that do not meet the audit's exploit
gates (no unprivileged amplifier; the only actor able to trigger the
behavior is the collection's own owner or a minter that owner explicitly
granted). Both are accepted design facts of v2, carried here with their
operational guidance.

**`seedSource` reverting permanently halts `tokenURI` for the affected
tokens.** `seedSource` is an init-only pointer fixed at `initialize`, by
design. `tokenSeed` falls back
to `ISeedSourceV2(seedSource).seedOf(...)` for any token with no stored
seed. A `seedSource` that reverts, whether from a bug in its own code or a
reveal epoch that never resolves, permanently reverts `tokenSeed` and
`tokenURI` for every token relying on the fallback, with no recovery
available to the collection owner. Operational guidance: treat `seedSource`
selection with the same care as a locked renderer choice, and prefer a
source that has itself shipped an audit or a long production history before
wiring it into a collection at deploy time.

**`mintToSeeded` permits duplicate seeds across tokens.** The core performs
no uniqueness check across a batch of minter-supplied seeds. `mintToSeeded`
is reachable only through a bring-your-own minter the collection owner
explicitly grants; the canonical `FixedPriceMinterV2` never calls it.
Operational guidance: the calling minter is responsible for seed
uniqueness across its own batch.

## v1 note

The wallet-cap accounting bug fixed above in v2 also exists in the deployed
mainnet v1 minter,
[`FixedPriceMinter` at `0x50941e5fd0B177826AB86419502b221049821Ba3`](https://evm.now/address/0x50941e5fd0B177826AB86419502b221049821Ba3?chainId=1),
which is an immutable implementation behind live clones. The same `if (cap
!= 0)` guard around the `mintedBy` write exists there and cannot be patched
in place.

Operational mitigation for every v1 collection: set `walletCap` before
opening a sale, or open the sale with the cap already set. Setting the cap
before the first mint removes the uncapped window the gap depends on.
