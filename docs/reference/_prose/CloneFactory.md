---
title: CloneFactory
---

# summary

Plumbing, deployed once per implementation: the token factory
(`{{addr:surfaceFactoryV2}}`) clones [Surface (v2)](/docs/surface/contracts/surface-v2)
and the sale factory (`{{addr:saleFactoryV2}}`) clones
[FixedPriceSale](/docs/surface/contracts/fixed-price-sale). Each call clones the
implementation as an EIP-1167 proxy, calls it with the caller's encoded
`initialize` in the same transaction, and records the instance. An init that
reverts reverts the whole call, so no half-initialized instance is recorded.

Discovery is the `Created` event plus `isInstance`; there is no list. The
deployer can pause new instances or deprecate the factory for good, and
neither touches an existing instance. Most callers use the
[Launcher](/docs/surface/contracts/launcher); a bespoke project calls a
factory directly.

## function create

access: permissionless (reverts `FactoryPaused` or `FactoryDeprecated`)

Clones the implementation, calls it with `initData` (an encoded `initialize`
call), and records it. The clone's `initialize` sees this factory as
`msg.sender`. Emits `Created`.

## function createDeterministic

access: permissionless (reverts `FactoryPaused` or `FactoryDeprecated`)

Same as `create`, at the CREATE2 address `predict(salt, msg.sender)` returns.
The salt is namespaced by the caller, so nobody can take another caller's
address. Reusing a salt as the same caller reverts `FailedDeployment`.

## function setPaused

access: deployer-only (`NotDeployer`)

Halts or resumes new instances. Emits `PausedSet`.

## function deprecate

access: deployer-only (`NotDeployer`); one-way (`AlreadyDeprecated`)

Halts new instances for good and names where new ones should come from.
Unpausing does not revive it. Emits `Deprecated`.

## function deployer

The address that deployed the factory: the only one that can pause or
deprecate.

## function deprecated

Whether `deprecate` was called.

## function implementation

The contract every instance clones.

## function isInstance

Whether an address was created by this factory.

## function paused

Whether new instances are halted.

## function predict

The address `createDeterministic(salt, ...)` returns when called by `caller`.

## function successor

The successor named by `deprecate`, or zero.

## event Created

One per instance: the implementation, the new instance, and the caller (the
launcher, for a launcher-made collection or sale).

## event PausedSet

The pause flag changed.

## event Deprecated

The factory was deprecated, naming a successor.

## error AlreadyDeprecated

`deprecate` was already called.

## error FactoryDeprecated

A create after deprecation.

## error FactoryPaused

A create while paused.

## error NotAContract

The constructor was given an implementation without code.

## error NotDeployer

`setPaused` or `deprecate` from someone other than the deployer.

## error FailedDeployment

Standard OpenZeppelin Clones error: the clone could not be created, for
example a reused deterministic salt.

## error AddressEmptyCode

Standard OpenZeppelin Address error, unreachable since a clone always has
code.

## error FailedCall

Standard OpenZeppelin Address error: the init call reverted with no reason.

## error InsufficientBalance

Standard OpenZeppelin error, unreachable since no create sends value.
