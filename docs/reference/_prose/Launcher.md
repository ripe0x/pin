---
title: Launcher
---

# summary

The common wiring: one `launch` call deploys a
[Surface (v2)](/docs/surface/contracts/surface-v2) collection and its
[FixedPriceSale](/docs/surface/contracts/fixed-price-sale), already pointed at
each other, through the two [CloneFactory](/docs/surface/contracts/clone-factory)
instances. The launcher holds the product defaults: the owner as royalty and
payout fallback, PND's default referrer, one sale per collection. It holds no
authority over anything it launches. Deployed at `{{addr:launcherV2}}`.

The launcher is replaceable without touching anything deployed. A bespoke
project skips it and calls the token factory directly with its own minter.

# concepts

### How one call wires both

The launcher predicts the sale's CREATE2 address, creates the collection
with that address as its initial minter, then creates the sale at the
predicted address. The sale's initialize authority check passes because the
collection already names it.

### Parameters

`TokenParams`: `name`, `symbol`, `owner`, `renderer`, `supplyCap`,
`royaltyBps`, `royaltyReceiver` (`0` defaults to `owner`).

`SaleParams`: `price`, `mintStart`, `mintEnd`, `maxMints`, `walletCap`,
`payoutRecipient` (`0` defaults to `owner`), `gate` (`0` is none).

## function launch

access: permissionless (reverts when either factory is paused or deprecated)

Creates the collection and its sale and returns both addresses. The sale
copies the current `defaultReferrer` and keeps it forever. Validation errors
from either `initialize` bubble up. Emits `Launched`.

## function setDefaultReferrer

access: owner-only (`OwnableUnauthorizedAccount`)

Changes the referrer later launches copy into their sales; existing sales
keep theirs. `0` means launcher sales pay no referral on `mint`. Emits
`DefaultReferrerSet`.

## function transferOwnership

access: owner-only (`OwnableUnauthorizedAccount`)

Standard OpenZeppelin Ownable transfer of the right to change
`defaultReferrer`.

## function renounceOwnership

access: owner-only (`OwnableUnauthorizedAccount`)

Standard OpenZeppelin Ownable renounce: `defaultReferrer` is fixed for every
later launch.

## function defaultReferrer

The referrer each new sale copies. Should be a Safe or splitter, since every
sale keeps its copy.

## function nonce

Launch counter, part of each sale's salt.

## function owner

The address that can change `defaultReferrer`.

## function saleFactory

The sale CloneFactory.

## function tokenFactory

The token CloneFactory.

## event Launched

One per launch: owner, collection and sale.

## event DefaultReferrerSet

The default referrer changed, including at construction.

## event OwnershipTransferred

Standard OpenZeppelin Ownable event.

## error SalePredictionMismatch

The sale landed somewhere other than the predicted address. Unreachable
with a correct sale factory.

## error OwnableInvalidOwner

Standard OpenZeppelin Ownable error: a zero owner.

## error OwnableUnauthorizedAccount

Standard OpenZeppelin Ownable error: an owner-only function called by someone
else.
