---
title: FixedPriceMinter
---

# summary

Fixed-price minter for a sequential [Surface](/docs/surface/contracts/surface)
collection, deployed as one EIP-1167 clone per collection.
`createSurface` on [the factory](/docs/surface/contracts/factory) clones and
grants one; `SurfaceCreated.primaryMinter` records the address. The clone stores
the sale config (fixed `price` or an `IPriceStrategy`, mint window, payout
recipient, per-clone sale ceiling, Merkle allowlist root, per-recipient cap),
takes payment in `mint`, and calls the collection's `mintTo` to issue tokens.
Pooled collections assign ids through their own minter, so this minter is
sequential only.

`mint` requires exact payment on a fixed price, or `msg.value` at least the
strategy quote with the excess refunded, and pays a fixed 10% referral share
(`REFERRAL_SHARE_BPS = 1000`) to the `referrer` argument when nonzero, the rest
to `payoutRecipient`. Proceeds accrue as pull-payment balances withdrawn through
`withdraw`; no ETH is transferred during a mint, so a reverting recipient does
not block minting. `price = 0` is valid config; there is no separate free-mint or
owner-mint entrypoint. An owner mint is done by granting a minter on the
collection, calling `mintTo`, and revoking.

The minter has no owner. Config setters check the collection's `owner()`/`isAdmin`,
so a collection ownership transfer also invalidates delegated admin access to the
minter config.

# concepts

### Pricing

With no price strategy set, the required payment is `price * quantity` and
`msg.value` must equal it (`WrongPayment` otherwise). With a strategy set, the
quote can change between read and inclusion, so `mint` requires `msg.value` at
least the quote (`Underpayment` otherwise) and credits the excess back to the
payer as a pull-payment balance. The quote is read from the strategy once and
reused for the settle, so the strategy cannot direct more value than the contract
received. `priceOf` returns the same resolution as a view.

### Gates

Two optional gates, both checked in `mint` and both evaluating the recipient `to`,
not the payer:

- Merkle allowlist (`allowlistRoot` nonzero): the caller passes an ABI-encoded
  `bytes32[]` proof in `data`. The leaf is the OpenZeppelin standard-merkle-tree
  single-address leaf, `keccak256(bytes.concat(keccak256(abi.encode(to))))`
- per-recipient cap (`walletCap` nonzero): `mintedBy[to]` plus the requested
  quantity must not exceed the cap; the counter increments after a successful mint

Both are live config. `maxMints` is a separate ceiling on this clone's own total
sales, distinct from the collection's supply cap, which bounds every minter.

### Pull payments

`mint` credits the referral share and the payout as internal balances rather than
transferring during the call; `withdraw(account)` sends a balance out.
`payoutRecipient` is a concrete stored value, enforced nonzero at both
`initialize` and `setPayoutRecipient`, so it is never resolved from the
collection's live `owner()`; a renounced collection keeps paying it. A balance
credited on this clone stays withdrawable after the collection revokes the
minter.

### Minting from a frontend

The two mint entrypoints share the same guarded path (`_executeMint`
internally), so settlement, gates, and reentrancy protection are identical; only
the caller-facing shape differs.

```ts
import {fixedPriceMinterAbi} from '@pin/abi';

const required = await client.readContract({
  address: minter, // from SurfaceCreated.primaryMinter
  abi: fixedPriceMinterAbi,
  functionName: 'priceOf',
  args: [collector, 1n, '0x'],
});

// Common case: mint to the caller, no referrer, no gate data.
await walletClient.writeContract({
  address: minter,
  abi: fixedPriceMinterAbi,
  functionName: 'mint',
  args: [1n],
  value: required,
});

// Full form: a different recipient, a referrer, or allowlist proof data.
await walletClient.writeContract({
  address: minter,
  abi: fixedPriceMinterAbi,
  functionName: 'mint',
  args: [collector, 1n, referrer, '0x'], // data carries a Merkle proof when allowlisted
  value: required,
});
```

## function mint(address,uint256,address,bytes)

access: permissionless (payable; window, ceiling, gate, and payment checks apply)

Takes payment and mints `quantity` tokens to `to`. `to` is the recipient and the
address the gates evaluate; `msg.sender` is the payer, and any strategy
overpayment refund is credited to the payer. `referrer`, when nonzero, receives
the 10% referral share; zero directs the full amount to `payoutRecipient`. `data`
carries the Merkle proof when an allowlist is set and is forwarded to the price
strategy when one is set.

Checks, in order: `ZeroQuantity` for `quantity == 0`, `MintNotStarted` before
`mintStart`, `MintEnded` at or after a nonzero `mintEnd`, `MaxMintsExceeded` past
`maxMints`, `NotAllowlisted` on a failing proof, `WalletCapExceeded` past
`walletCap`, then the payment check (`WrongPayment` fixed, `Underpayment`
strategy). The `mintTo` call can revert `ExceedsCap` on the collection's supply
cap. On success, credits the referral and payout balances and emits `Sold` after
the collection's `Minted`.

## function mint(uint256)

access: permissionless (payable; window, ceiling, gate, and payment checks apply)

Ergonomic overload for the common case: mints `quantity` tokens to `msg.sender`
with no referrer and no gate data, equivalent to
`mint(msg.sender, quantity, address(0), "")`. Same checks, settlement, and
`Sold` emission as the four-argument form. Use the four-argument form for a
different recipient, a referrer, or allowlist proof data.

## function withdraw

access: permissionless (funds go only to `account`)

Sends `account` its owed pull-payment balance. Any caller may invoke it; the
transfer goes to `account`. Reverts `ZeroAccount` for the zero address,
`NothingToWithdraw` for a zero balance, and `WithdrawFailed` if the transfer
reverts, leaving the balance intact. Emits `Withdrawn`.

## function setPrice

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets the fixed price per token, used when no price strategy is set. Emits
`PriceSet`.

## function setPriceStrategy

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets the price strategy, or zero to use the fixed `price`. Reverts `NotAContract`
for a nonzero address with no code. Emits `PriceStrategySet`.

## function setMintWindow

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets the sale window. Reverts `BadMintWindow` unless `end` is 0 (open-ended) or
strictly after `start`. Emits `MintWindowSet`.

## function setPayoutRecipient

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets the stored payout address for future mints. Reverts `PayoutRecipientRequired`
for the zero address. Balances already credited stay at the address they were
credited to. Emits `PayoutRecipientSet`.

## function setMaxMints

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets this clone's sale ceiling (0 = unlimited), checked against `totalMinted`.
Distinct from the collection's supply cap. Emits `MaxMintsSet`.

## function setAllowlistRoot

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets the Merkle allowlist root, or zero for no allowlist. Emits
`AllowlistRootSet`.

## function setWalletCap

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sets the per-recipient cap (0 = unlimited), checked against `mintedBy[to]`.
Counted per recipient on this clone only. Emits `WalletCapSet`.

## function rescueStrayETH

access: collection owner or admin (`onlyCollectionAdmin`, else `NotAuthorized`)

Sends `to` the ETH balance above the sum of pull-payment balances. Owed balances
are not swept. Reverts `ZeroAccount` for the zero address, `NoStrayETH` when the
surplus is zero, and `RescueFailed` if the transfer reverts. Emits
`StrayETHRescued`.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`)

Sets the collection binding and the sale config once; the collection binding has
no setter. Reverts `CollectionRequired` for a zero collection, `NotAContract` for
a collection or nonzero price strategy with no code, `BadMintWindow` for a
nonzero `mintEnd` not after `mintStart`, and `PayoutRecipientRequired` for a zero
payout recipient. `createSurface` calls this in the transaction that clones the
token. The implementation constructor disables initializers, so only a clone is
initialized, once. Emits `MinterConfigured`.

## function REFERRAL_SHARE_BPS

The referral share as a compile-time constant: 1000 bps, 10%. Paid to the
`referrer` argument, not artist-set.

## function collection

The collection this clone sells for. Set at `initialize`; no setter.

## function price

The fixed price per token in wei, used when `priceStrategy` is zero.

## function priceStrategy

The price strategy contract, or zero when the fixed `price` applies.

## function priceOf

The required payment in wei to mint `quantity` tokens to `to` given `data`:
`price * quantity`, or the strategy quote when one is set. Does not check the
gates or the window. A strategy quote can change between this read and inclusion.

## function mintStart

Sale window start in unix seconds; 0 means open immediately.

## function mintEnd

Sale window end in unix seconds; 0 means open-ended.

## function payoutRecipient

The stored artist payout address. Never zero once set: enforced nonzero at both
`initialize` and `setPayoutRecipient`, and never derived from the collection's
live `owner()`, so a renounced collection keeps paying it.

## function maxMints

This clone's sale ceiling (0 = unlimited), checked against `totalMinted`.

## function totalMinted

Tokens minted through this clone, the counter behind `maxMints`.

## function allowlistRoot

The Merkle allowlist root, or zero for no allowlist.

## function walletCap

The per-recipient cap (0 = unlimited), checked against `mintedBy`.

## function mintedBy

Tokens minted to a recipient through this clone, the counter behind `walletCap`.
Incremented after a successful mint.

## function pendingWithdrawal

The pull-payment balance in wei owed to an account, withdrawn with `withdraw`.

## event Sold

Emitted once per `mint` call. Indexed by `payer` (`msg.sender`), `to`, and
`referrer`. `paid` is the settled price, excluding refunded excess;
`firstTokenId` is the first id of the minted range, matching the collection's
`Minted` from the same call. The ABI is the same across every clone, so one
indexer handler covers all of them.

## event ReferralPaid

Emitted when a nonzero referral cut is credited. Indexed by `referrer`, with the
`amount` in wei.

## event Withdrawn

Emitted when a pull-payment balance is paid out. Indexed by `account`, with the
`amount` in wei.

## event MinterConfigured

Emitted at `initialize` with the collection binding and the opening sale config.
Indexed by `collection`. Each field has its own update event afterward.

## event PriceSet

Emitted when the fixed price changes with `setPrice`.

## event PriceStrategySet

Emitted when the price strategy changes with `setPriceStrategy`. Indexed by
`strategy`.

## event MintWindowSet

Emitted when the window changes with `setMintWindow`.

## event PayoutRecipientSet

Emitted when the payout address changes with `setPayoutRecipient`. Indexed by
`payoutRecipient`. Affects future accruals.

## event MaxMintsSet

Emitted when the sale ceiling changes with `setMaxMints`.

## event AllowlistRootSet

Emitted when the allowlist root changes with `setAllowlistRoot`.

## event WalletCapSet

Emitted when the per-recipient cap changes with `setWalletCap`.

## event StrayETHRescued

Emitted when `rescueStrayETH` sweeps unowed ETH. Indexed by `to`, with the
`amount` in wei.

## event Initialized

OpenZeppelin Initializable event, emitted once when the clone is initialized.

## error ZeroQuantity

`mint` was called with `quantity == 0`.

## error MintNotStarted

`mint` was called before `mintStart`.

## error MintEnded

`mint` was called at or after a nonzero `mintEnd`.

## error MaxMintsExceeded

The call would cross this clone's `maxMints` ceiling.

## error NotAllowlisted

An allowlist root is set and the proof in `data` does not prove `to` is on the
list. Pass the recipient's proof as an ABI-encoded `bytes32[]`.

## error WalletCapExceeded

The call would push `mintedBy[to]` past `walletCap`.

## error WrongPayment

A fixed-price mint did not send exactly `price * quantity`.

## error Underpayment

A strategy-priced mint sent less than the quote. Excess above the quote is
refunded to the payer.

## error NothingToWithdraw

`withdraw` was called for an account with a zero balance.

## error WithdrawFailed

The transfer in `withdraw` reverted, for example a recipient that rejects ETH.
The balance is left intact.

## error ZeroAccount

`withdraw` or `rescueStrayETH` was passed the zero address.

## error NoStrayETH

`rescueStrayETH` found no ETH above the owed balances.

## error RescueFailed

The transfer in `rescueStrayETH` reverted.

## error NotAuthorized

A config setter or `rescueStrayETH` was called by an address that is neither the
collection's owner nor one of its admins.

## error CollectionRequired

`initialize` was given the zero address as the collection.

## error NotAContract

`initialize` or `setPriceStrategy` was given a nonzero address with no code where
a contract is required (the collection, or a price strategy).

## error BadMintWindow

`initialize` or `setMintWindow` was given a nonzero `mintEnd` not strictly after
`mintStart`. Use `mintEnd = 0` for open-ended.

## error PayoutRecipientRequired

`initialize` or `setPayoutRecipient` was given the zero address. Both write
points reject zero, so `_settle` never has to resolve a fallback.

## error InvalidInitialization

OpenZeppelin Initializable error: `initialize` was called more than once, or on
the implementation whose initializers are disabled.

## error NotInitializing

OpenZeppelin Initializable error: an `onlyInitializing` step ran outside an active
initialization.

## error ReentrancyGuardReentrantCall

OpenZeppelin ReentrancyGuard error: a `nonReentrant` function was re-entered.
