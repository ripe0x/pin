---
title: FixedPriceSale
---

# summary

The v2 sale primitive: one EIP-1167 clone per sale through the sale
[CloneFactory](/docs/surface/contracts/clone-factory), bound to one
[Surface (v2)](/docs/surface/contracts/surface-v2) collection at initialize.
It holds this sale's rules and money and nothing about the artwork. Every
mint pays exactly `price * quantity`; proceeds accrue as pull balances.

Config authority is borrowed from the collection's owner. Before the owner
renounces, every setting is changeable; after, the sale is frozen and
payouts keep flowing. A client that reads a collection's `minter()` can tell a
canonical sale from a bespoke minter with `supportsInterface` on the IMinter
interface id and `version()`.

# concepts

### Two mint paths

`mint(quantity)` mints to the caller, pays the referral share to the sale's
fixed `defaultReferrer` (PND's address on a launcher sale) and sends no gate
data. `mintWithReferral(to, quantity, referrer, data)` is the full path: any
recipient, any referrer (zero keeps the whole payment for the artist), and
gate data. The collector pays the same price on both; only the split changes.

### The checks, in order

1. not closed (`SaleClosed`)
2. inside the window (`MintNotStarted`, `MintEnded`)
3. `totalMinted + quantity <= maxMints` when set (`MaxMintsExceeded`)
4. the gate's `check` returns true when a gate is set (`GateRejected`)
5. `mintedBy[to] + quantity <= walletCap` when set (`WalletCapExceeded`)
6. `msg.value == price * quantity` (`WrongPayment`)
7. a contract recipient answers `onERC721Received` (`ReceiverRejected`)
8. the collection's `mintTo`
9. `totalMinted` and `mintedBy[to]` grow on every mint, capped or not
10. settle: `REFERRAL_SHARE_BPS` (500, 5%) to a nonzero referrer, the rest to
    `payoutRecipient`, both as pull balances

### Referral share

A constant 5%, with no setter. It pays whoever hosts the mint. An artist's
own site passes the artist's address as referrer and keeps 100%; anyone can
name themselves when minting straight from the contract. It is a host reward,
not a protocol fee.

## function mint

access: permissionless (the mint checks above)

Mints `quantity` tokens to the caller with `defaultReferrer` as referrer and
empty gate data, so a gated sale rejects it with `GateRejected`. Payable;
`nonReentrant`. Emits `Sold` and, for a nonzero referral amount,
`ReferralPaid`.

## function mintWithReferral

access: permissionless (the mint checks above)

Mints `quantity` tokens to `to`. `to` is both the recipient and the address
the gate and wallet cap evaluate. `referrer` receives the referral share
when nonzero. `data` goes to the gate and nothing else (for
[AllowlistGate](/docs/surface/contracts/allowlist-gate), an abi-encoded
`bytes32[]` proof). Payable; `nonReentrant`.

## function withdraw

access: permissionless (funds go only to `account`)

Sends `account` its whole owed balance. Reverts `ZeroAccount`,
`NothingToWithdraw`, or `WithdrawFailed` when the transfer fails (the balance
is kept). Emits `Withdrawn`.

## function withdrawTo

access: permissionless (the caller's own balance only)

Sends the caller's owed balance to `to`. Same reverts as `withdraw`.

## function setPrice

access: owner-only (the collection's owner, borrowed; `NotAuthorized`)

Sets the price per token in wei. Emits `PriceSet`.

## function setMintWindow

access: owner-only (the collection's owner, borrowed; `NotAuthorized`)

Sets the window. `0` start opens now, `0` end is open-ended; an end at or
before a start reverts `BadMintWindow`. Emits `MintWindowSet`.

## function setMaxMints

access: owner-only (the collection's owner, borrowed; `NotAuthorized`)

Sets this sale's ceiling; `0` is unlimited. Emits `MaxMintsSet`.

## function setWalletCap

access: owner-only (the collection's owner, borrowed; `NotAuthorized`)

Sets the per-recipient cap; `0` is unlimited. Counts every earlier mint.
Emits `WalletCapSet`.

## function setPayoutRecipient

access: owner-only (the collection's owner, borrowed; `NotAuthorized`)

Sets where the artist share accrues. Rejects zero
(`PayoutRecipientRequired`). Balances already accrued stay with the old
recipient. Emits `PayoutRecipientSet`.

## function setGate

access: owner-only (the collection's owner, borrowed; `NotAuthorized`)

Sets the gate; `0` removes it. A nonzero address without code reverts
`NotAContract`. Emits `GateSet`.

## function close

access: owner-only (the collection's owner, borrowed; `NotAuthorized`)

One-way: no mint succeeds afterwards. Another sale needs a new clone and the
collection's `setMinter`. Emits `Closed`.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`); the collection already names this clone as its minter, or the caller is the collection's owner (`NotAuthorized`)

Binds the sale to a collection with its price, window, ceiling, wallet cap,
payout recipient, gate and default referrer. Reverts `CollectionRequired`,
`NotAContract` (collection or gate without code), `PayoutRecipientRequired`
and `BadMintWindow`. Through the factory the caller is the factory, so only
the first authority path applies: grant the predicted address as minter first,
as the launcher does. Emits `MintWindowSet`, `PayoutRecipientSet` and
`GateSet`.

## function REFERRAL_SHARE_BPS

The referral share, `500` (5%).

## function closed

Whether `close` was called.

## function collection

The collection this sale mints.

## function defaultReferrer

The referrer `mint(quantity)` pays. Fixed at initialize; may be zero.

## function gate

The gate consulted before each mint, or zero.

## function maxMints

This sale's ceiling; `0` is unlimited.

## function mintEnd

Window end in unix seconds; `0` is open-ended.

## function mintStart

Window start in unix seconds; `0` is open now.

## function mintedBy

Tokens minted to an address through this sale, counted on every mint.

## function payoutRecipient

Where the artist share accrues. Never zero.

## function pendingWithdrawal

The owed balance of an address.

## function price

Price per token in wei.

## function priceOf

`price * quantity`. Does not evaluate the gate or the window.

## function supportsInterface

True for ERC-165 and the IMinter interface id.

## function totalMinted

Tokens minted through this sale.

## function version

`2`, the implementation lineage marker.

## function walletCap

The per-recipient cap; `0` is unlimited.

## event Sold

One per successful mint: payer, recipient, referrer, quantity, exact payment
and first token id.

## event ReferralPaid

A nonzero referral amount accrued to a referrer.

## event Withdrawn

An owed balance was paid out: the account it was owed to, where it went, and
the amount.

## event PriceSet

The price changed.

## event MintWindowSet

The window changed, including at initialize.

## event MaxMintsSet

The ceiling changed.

## event WalletCapSet

The wallet cap changed.

## event PayoutRecipientSet

The payout recipient changed, including at initialize.

## event GateSet

The gate changed, including at initialize.

## event Closed

The sale was closed for good.

## event Initialized

Standard OpenZeppelin Initializable event, emitted once by `initialize`.

## error SaleClosed

The sale is closed.

## error MintNotStarted

Before `mintStart`.

## error MintEnded

At or after `mintEnd`.

## error MaxMintsExceeded

The mint would pass this sale's ceiling.

## error GateRejected

The gate's `check` returned false.

## error WalletCapExceeded

The mint would pass the recipient's wallet cap.

## error WrongPayment

`msg.value` is not exactly `price * quantity`.

## error ReceiverRejected

A contract recipient did not answer `onERC721Received` correctly.

## error BadMintWindow

A window end at or before its start.

## error CollectionRequired

`initialize` was given a zero collection.

## error NotAContract

A collection or gate address without code.

## error NotAuthorized

A setter from someone other than the collection's owner, or an initialize
that neither authority path allows.

## error NothingToWithdraw

The account has no owed balance.

## error PayoutRecipientRequired

A zero payout recipient.

## error WithdrawFailed

The ETH transfer to the recipient failed; the balance is kept.

## error ZeroAccount

A withdrawal to the zero address.

## error ReentrancyGuardReentrantCall

Standard OpenZeppelin ReentrancyGuard error: a reentrant call into a mint or
withdrawal.

## error InvalidInitialization

Standard OpenZeppelin Initializable error: `initialize` on an initialized
clone or on the implementation.

## error NotInitializing

Standard OpenZeppelin Initializable error, unreachable in normal use.
