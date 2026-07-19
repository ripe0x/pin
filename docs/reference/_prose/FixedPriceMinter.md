---
title: FixedPriceMinter
---

# summary

The canonical paid mint path of the Surface System: a fixed-price/referral
minter for a sequential [Surface](/docs/collections/contracts/surface)
collection, deployed as one immutable EIP-1167 clone per collection.
`createSurface` on [the factory](/docs/collections/contracts/factory) clones
and wires one automatically; `SurfaceCreated.minter` records the binding.
The clone holds the sale config (price or price strategy, mint window,
payout, sale ceiling, and two optional gates), collects payment in its
`mint`, and calls the collection's minter-gated `mintTo` to issue tokens.
Pooled collections assign ids through their own minter, so this minter is
sequential-only.

Payment is honest: the collector pays exactly the resolved price, and a
fixed referral share of 10% (`REFERRAL_SHARE_BPS = 1000`) is paid out of
that price to whoever hosts the mint, folding back to the artist when no
referrer is passed. All proceeds accrue as pull-payment balances claimed
through `withdraw`; no external transfer happens during a mint, so a
reverting recipient can never block minting. Every mint through this
contract is paid at the configured price: `price = 0` is legal config but
there is no free-mint or owner-mint special case. Owner airdrops go around
the minter (grant a one-off minter on the collection, mint, revoke).

The minter has no owner of its own. Config authority is borrowed from the
collection: every setter checks the collection's `owner()`/`isAdmin`, so one
keyring governs both contracts and an ownership transfer on the collection
invalidates delegated admin access to the minter's config too.

# concepts

### Pricing

With no price strategy set, the required payment is `price * quantity` and
must match exactly (`WrongPayment` on a mismatch). With a strategy set, the
strategy's quote can move between quote and inclusion, so `mint` accepts
`msg.value >= quote` (`Underpayment` otherwise) and accrues the excess back
to the payer as a pull-payment refund. The quote is read from the strategy
once and reused for the settle, so a misbehaving strategy cannot split value
this contract never received. `priceOf` exposes the same resolution as a
view for frontends.

### Gates

Two optional gates, both AND-composed in the same mint call and both
evaluating the recipient `to`, not the payer:

- Merkle allowlist (`allowlistRoot` nonzero): the caller passes an
  ABI-encoded `bytes32[]` proof in `data`. The leaf format is the
  OpenZeppelin standard-merkle-tree single-address leaf,
  `keccak256(bytes.concat(keccak256(abi.encode(to))))`
- per-wallet cap (`walletCap` nonzero): `mintedBy[to]` plus the requested
  quantity must not exceed the cap. The counter increments after a
  successful mint

Both are live config: setting the allowlist root and later clearing it is
how a presale-then-public sale runs on one minter. `maxMints` is a third
ceiling, the minter's own total-sale allocation, independent of the
collection's supply cap (which binds every minter globally).

### Pull payments

`_settle` splits the paid amount between the referral share and the artist
payout and credits both as internal balances; `withdraw(account)` pays a
balance out. A `payout` of zero resolves to the collection's live `owner()`
at settle time. Balances survive anything: revoking this minter on the
collection strands nothing, since pull balances on the clone remain
claimable forever.

### Minting from a frontend

```ts
import {fixedPriceMinterAbi} from '@pin/abi';

const required = await client.readContract({
  address: minter, // from SurfaceCreated.minter
  abi: fixedPriceMinterAbi,
  functionName: 'priceOf',
  args: [collector, 1n, '0x'],
});

await walletClient.writeContract({
  address: minter,
  abi: fixedPriceMinterAbi,
  functionName: 'mint',
  args: [collector, 1n, referrer, '0x'], // data carries a Merkle proof when allowlisted
  value: required,
});
```

## function mint

access: permissionless (payable; no caller gate, guarded by window, ceiling, gate, and payment checks)

The paid mint. `to` is both the recipient and the address the gates
evaluate (an allowlist gates the collector, not the payer), so a hot wallet
can buy for a vault or a sponsor can gift; the overpayment refund on a
strategy-priced mint accrues to the payer (`msg.sender`), who sent it.
`referrer` receives the 10% referral share when nonzero; zero folds the
share to the artist. `data` carries the Merkle proof when an allowlist is
set, and is forwarded to the price strategy when one is set.

Checks run in order: `ZeroQuantity` for `quantity == 0`, `MintNotStarted`
before `mintStart`, `MintEnded` at or after a nonzero `mintEnd`,
`MaxMintsExceeded` when the call would cross `maxMints`, `NotAllowlisted` on
a failing proof, `WalletCapExceeded` when the call would cross `walletCap`,
then the payment check (`WrongPayment` fixed / `Underpayment` strategy).
The token call itself can revert `ExceedsCap` on the collection's supply
cap. On success, credits the referral and payout balances, and emits `Sold`
(after the collection's own `Minted`).

## function withdraw

access: permissionless (no caller gate; funds only ever go to the owed `account`)

Sends the pull-payment balance owed to `account` to `account`. Anyone may
trigger it, but funds only ever reach the owed address. Reverts
`ZeroAccount` for the zero address, `NothingToWithdraw` when nothing is
owed, and `WithdrawFailed` if the transfer reverts (the balance stays
claimable). Emits `Withdrawn`.

## function setPrice

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Updates the fixed price per token, ignored while a price strategy is set.
Exact-match payment means a mint transaction in flight against the old price
reverts (`WrongPayment`) rather than overpaying. Emits `PriceSet`.

## function setPriceStrategy

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Points the price strategy slot at a strategy contract, or zero to use the
fixed `price`. Reverts `NotAContract` for a nonzero address with no code,
since a codeless strategy would revert every mint. Emits
`PriceStrategySet`.

## function setMintWindow

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Reschedules the sale window: push back a start, extend a slow sale, or close
early by setting the end to now. Reverts `BadMintWindow` unless `end` is 0
(open-ended) or strictly after `start`. Emits `MintWindowSet`.

## function setPayout

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets where the artist share accrues for future mints; zero resolves to the
collection's live `owner()` at settle time. Past accruals remain claimable
at the address they were credited to. Emits `PayoutSet`.

## function setMaxMints

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets this minter's own sale ceiling (0 = unlimited), measured against
`totalMinted`. Independent of the collection's supply cap; useful as an
allocation when the collection grants more than one minter. Emits
`MaxMintsSet`.

## function setAllowlistRoot

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets the Merkle allowlist root, or zero to open the sale. Setting a root
for a presale and clearing it for the public phase runs both phases on one
minter. Emits `AllowlistRootSet`.

## function setWalletCap

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets the per-recipient mint cap (0 = unlimited), measured against
`mintedBy[to]`. Counted per recipient through this minter only; the
collection has no cross-minter wallet accounting. Emits `WalletCapSet`.

## function rescueStrayETH

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sweeps only ETH nobody is owed (for example, forced in via selfdestruct) to
`to`. The balance up to the sum of pull-payment balances is never swept.
Reverts `ZeroAccount` for the zero address, `NoStrayETH` when there is no
surplus, and `RescueFailed` if the transfer reverts. Emits
`StrayETHRescued`.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`)

Binds the clone to its collection and sets the full sale config exactly
once; the collection binding has no setter. Reverts `CollectionRequired`
for a zero collection, `NotAContract` for a collection or nonzero price
strategy with no code, and `BadMintWindow` for a nonzero `mintEnd` not after
`mintStart`. The factory's `createSurface` calls this in the same
transaction that clones the token. The implementation's constructor
disables initializers, so only clones can be initialized, and only once.
Emits `MinterConfigured`.

## function REFERRAL_SHARE_BPS

The fixed referral share as a compile-time constant: 1000 bps, 10%. Paid to
the referrer that hosts the mint; not artist-set, and not a protocol fee.

## function collection

The collection this clone sells for. Set once at `initialize`; no setter.

## function price

The fixed price per token in wei, used when `priceStrategy` is unset.

## function priceStrategy

The price strategy contract, or zero when the fixed `price` applies.

## function priceOf

The required payment in wei to mint `quantity` tokens to `to` given `data`:
`price * quantity`, or the strategy's quote when one is set. Does not
evaluate the gates or the mint window. Frontends read this to quote a mint;
a strategy quote can move between quote and inclusion.

## function mintStart

Sale window start in unix seconds; 0 means open immediately.

## function mintEnd

Sale window end in unix seconds; 0 means open-ended.

## function payout

Where the artist share accrues, or zero for the collection's live `owner()`
at settle time.

## function maxMints

This minter's own sale ceiling (0 = unlimited), measured against
`totalMinted`.

## function totalMinted

Tokens minted through this clone across its lifetime, the counter behind
`maxMints`.

## function allowlistRoot

The Merkle allowlist root, or zero when the sale is open.

## function walletCap

The per-recipient mint cap (0 = unlimited), measured against `mintedBy`.

## function mintedBy

Tokens minted to a recipient through this clone, the counter behind
`walletCap`. Incremented after a successful mint.

## function pendingWithdrawal

The pull-payment balance in wei currently owed to an account, claimable with
`withdraw`.

## event Sold

One event per successful `mint` call, the minter's sale record. Indexed by
`payer` (`msg.sender`), `to` (the recipient), and `referrer`. `paid` is the
required price actually settled, excluding any refunded excess, and
`firstTokenId` is the first id of the minted range, matching the
collection's `Minted` event from the same call. The event ABI is identical
across every canonical-minter clone, so an indexer binds one handler for all
of them.

## event ReferralPaid

Emitted when a nonzero referral cut is credited on a mint. Indexed by
`referrer`, with the credited `amount` in wei.

## event Withdrawn

Emitted when a pull-payment balance is paid out. Indexed by `account`, with
the `amount` in wei.

## event MinterConfigured

Emitted once at `initialize` with the collection binding and the full
opening sale config. Indexed by `collection`. Each field is a live setting
afterward with its own update event.

## event PriceSet

Emitted when the fixed price changes with `setPrice`.

## event PriceStrategySet

Emitted when the price strategy slot changes with `setPriceStrategy`.
Indexed by `strategy`.

## event MintWindowSet

Emitted when the sale window is rescheduled with `setMintWindow`.

## event PayoutSet

Emitted when the payout address changes with `setPayout`. Indexed by
`payout`. Only affects future accruals.

## event MaxMintsSet

Emitted when the sale ceiling changes with `setMaxMints`.

## event AllowlistRootSet

Emitted when the allowlist root changes with `setAllowlistRoot`.

## event WalletCapSet

Emitted when the per-recipient cap changes with `setWalletCap`.

## event StrayETHRescued

Emitted when `rescueStrayETH` sweeps ETH nobody is owed. Indexed by `to`,
with the swept `amount` in wei.

## event Initialized

Standard OpenZeppelin Initializable event, emitted once when the clone is
initialized.

## error ZeroQuantity

`mint` was called with `quantity == 0`. Mint at least one token.

## error MintNotStarted

A mint was attempted before `mintStart`. Wait for the window to open, or the
artist reschedules it with `setMintWindow`.

## error MintEnded

A mint was attempted at or after a nonzero `mintEnd`. The window has closed
(the artist can reopen it with `setMintWindow`).

## error MaxMintsExceeded

The call would cross this minter's own sale ceiling (`maxMints`).

## error NotAllowlisted

An allowlist root is set and the proof in `data` does not prove `to` is on
the list. Pass the recipient's proof as an ABI-encoded `bytes32[]`.

## error WalletCapExceeded

The call would push `mintedBy[to]` past `walletCap`.

## error WrongPayment

A fixed-price mint did not send exactly `price * quantity`. Fixed pricing
requires an exact match; read `priceOf` first.

## error Underpayment

A strategy-priced mint sent less than the strategy's quote. Send at least
`priceOf`; any excess accrues back to the payer as a pull-payment refund.

## error NothingToWithdraw

`withdraw` was called for an account with a zero owed balance.

## error WithdrawFailed

The ETH transfer inside `withdraw` reverted, for example a recipient that
rejects payment. Nothing is lost; the balance stays claimable.

## error ZeroAccount

`withdraw` or `rescueStrayETH` was passed the zero address. Supply a real
account.

## error NoStrayETH

`rescueStrayETH` found no ETH above the owed pull-payment balances to
sweep.

## error RescueFailed

The ETH transfer inside `rescueStrayETH` reverted.

## error NotAuthorized

A config setter or `rescueStrayETH` was called by an address that is
neither the collection's owner nor one of its admins.

## error CollectionRequired

`initialize` was given the zero address as the collection.

## error NotAContract

`initialize` or `setPriceStrategy` was given a nonzero address with no code
where a contract is required (the collection, or a price strategy). A
codeless strategy would revert every mint, so the typo is refused at the
door.

## error BadMintWindow

`initialize` or `setMintWindow` was given a nonzero `mintEnd` that is not
strictly after `mintStart`. Use `mintEnd = 0` for open-ended or an end after
the start.

## error InvalidInitialization

Standard OpenZeppelin Initializable error: `initialize` was called more
than once, or called on the implementation whose initializers are disabled.

## error NotInitializing

Standard OpenZeppelin Initializable error: an `onlyInitializing` step ran
outside an active initialization.

## error ReentrancyGuardReentrantCall

Standard OpenZeppelin ReentrancyGuard error: a `nonReentrant` function was
re-entered.
