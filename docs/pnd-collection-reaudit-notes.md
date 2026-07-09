# SovereignCollection: re-audit notes (post-`43f4ae7`)

> **Purpose.** A running log of changes made to the collection contracts
> AFTER the audited baseline, so a re-review can be done against this
> single doc once the batch of changes is complete. Append one section
> per change. Nothing here has been reviewed yet.
>
> **Audited baseline: commit `43f4ae7`** (`fix(collection): security-audit
> fixes`). That commit applies the notes from **two independent security
> reviews** of SovereignCollection + Homage (pooled-burn restricted to
> authorized minters, mintIndex widened to uint40, `setWork`/`lockWork`
> honesty, comment cleanup). The baseline access-control model is
> **single-owner** (`Ownable2StepUpgradeable`); every management function
> is `onlyOwner`. Everything below changes behavior on top of that
> baseline and needs a re-review pass before any mainnet deploy.

---

## Change 1: Multi-admin access control

**Branch:** `claude/elated-swirles-0cc8e7`. **Touches:**
`SovereignCollection.sol`, `interfaces/ISovereignCollection.sol`, and the
collection test suite.

### Summary

The single-owner model becomes **owner + flat, full-access admins**. The
owner may grant any number of admins; an admin can call every management
function the owner can, with two functions reserved to the owner. `owner()`
is unchanged (still `Ownable2Step`, still what marketplaces read as the
storefront admin, still the root of the keyring).

### Mechanism

- New state: `mapping(address => bool) private _admins;` (independent of
  `_minters`; admin and extension-minter are distinct roles).
- New modifier:
  `onlyOwnerOrAdmin = (msg.sender == owner() || _admins[msg.sender])`,
  reverting `NotAuthorized` otherwise.
- New functions, all added to `ISovereignCollection`:
  - `addAdmin(address account)` (`onlyOwner`; reverts `ZeroAccount` on the
    zero address, `AlreadyAdmin` if already granted; emits
    `AdminSet(account, true)`).
  - `removeAdmin(address account)` (`onlyOwner`; reverts `NotAnAdmin` if the
    account is not currently an admin, so a typo or double-remove fails
    loudly; emits `AdminSet(account, false)`). No last-admin guard: removing
    every admin is safe because the owner keeps full access.
  - `isAdmin(address) view`.
  New errors: `AlreadyAdmin`, `NotAnAdmin`.

### Authority diff (this is the whole review surface)

Reserved to the owner (unchanged, `onlyOwner`):

| Function | Why owner-only |
|---|---|
| `addAdmin` / `removeAdmin` | the keyring: only the owner grants/revokes admins, so a rogue admin can never mint peers or lock out the owner |
| `transferOwnership` / `acceptOwnership` (Ownable2Step) | ownership is the root authority and the marketplace `owner()` |
| `renounceOwnership` | still disabled (reverts `RenounceDisabled`) |

Widened from `onlyOwner` to `onlyOwnerOrAdmin` (16 functions):

`setClosing`, `setRenderer`, `setMintHook`, `setPriceStrategy`,
`setMinter`, `setTokenArtwork`, `setTokenArtworkBatch`, `setPayoutAddress`,
`freezeMetadata`, `setWork`, `lockWork`, `addEdge`, `acknowledgeEdge`,
`setDefaultPath`, `setPath`, `rescueStrayETH`.

### Deliberate properties / accepted risk

This is a flat model by explicit product decision (no graduated roles).
Consequences a reviewer should confirm are intended, not accidental:

- **An admin can move money.** `setPayoutAddress` is admin-accessible, so
  an admin can redirect all FUTURE proceeds. (Past accruals already sit in
  pull-payment balances at the old address and are untouched.)
  `rescueStrayETH` is admin-accessible, but by construction it can only
  sweep ETH ABOVE `_totalPending` (owed balances remain untouchable).
- **An admin can take irreversible actions.** `freezeMetadata` and
  `lockWork` are admin-accessible. The owner can revoke the admin
  afterward but cannot undo a freeze/lock the admin already performed.
- **An admin can authorize minters.** `setMinter` is admin-accessible, so
  an admin can grant an extension minter (which can then mint / in pooled
  form move value per its own logic).
- **Freeze remains supreme over admins.** The `_metadataFrozen` /
  `_workLocked` guards live inside the functions, checked AFTER the
  `onlyOwnerOrAdmin` gate, so once frozen/locked neither owner nor admin
  can write artwork/renderer/work. (Verified by
  `test_freeze_blocksAdminArtwork`.)
- **The owner is always an implicit admin** (the modifier's `||
  owner()` arm); the owner need not appear in `_admins`.

### Reviewer focus / invariants to check

1. The modifier only widens the caller set; it introduces no new external
   call, so pull-payment and reentrancy properties are unchanged.
2. No admin path escalates to owner or to admin-management
   (`addAdmin`/`removeAdmin`, `transferOwnership` stay `onlyOwner`). Covered
   by `test_admin_cannotManageAdmins`, `test_admin_cannotTransferOwnership`.
3. `_admins` and `_minters` are separate maps; being an admin does not
   grant `mintTo`/`mintToAt`, and being a minter does not grant admin.
4. Freeze/lock ordering (auth gate before the frozen/locked check) holds
   for every widened setter.

### Open decision to resolve before the re-audit

- **Should `setPayoutAddress` be carved back to `onlyOwner`?** It is the
  single highest-consequence widened function (an admin can reroute the
  artist's money). It is currently admin-accessible per the "full access,
  no roles" directive. A one-word change if the answer is to reserve it.
- **Admin persistence across ownership transfer.** Transferring ownership
  does NOT clear `_admins`; the new owner inherits the prior owner's admin
  set. For a collection that changes hands this could leave a prior
  operator with full access. Confirm this is acceptable, or add an
  admin-clear on `acceptOwnership`.

### Test coverage

- New `test/collection/CollectionAdmin.t.sol` (15 tests): grant/revoke +
  events, addAdmin guards (zero address, already-admin) + owner-only,
  removeAdmin guards (not-an-admin, double-remove) + owner-only, admin runs
  every widened setter, admin redirects payouts (functional proof), the two
  owner-only carve-outs, revoked-admin loses access, non-admin rejected,
  owner stays authorized, freeze blocks admin artwork.
- Existing suites updated: unauthorized-caller assertions on the 16
  widened functions now expect `NotAuthorized` (was
  `OwnableUnauthorizedAccount`).
- Full collection suite: **201 passed / 0 failed** (fork tests excluded).
