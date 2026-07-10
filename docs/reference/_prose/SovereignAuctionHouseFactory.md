---
title: SovereignAuctionHouseFactory
---

# summary

SovereignAuctionHouseFactory deploys one
[SovereignAuctionHouse](/docs/auctions/contracts/sovereign-auction-house) per
owner as an immutable EIP-1167 clone of a fixed implementation: no proxy admin, no
upgrade path, what deploys is what runs. `createAuctionHouse` is permissionless:
anyone (an artist, a collector, an anonymous wallet) calls it and gets back their
own auction house, owned by the caller. Every clone delegates to the one
`implementation` deployed alongside this factory, and every house shares the same
fee terms baked into the factory at construction.

The factory is also the single fixed contract an indexer watches for discovery: one
`AuctionHouseCreated` event per house, plus an `allHouses` array, a `houseOf`
owner-to-house map, and an `isHouse` membership map for cheap onchain lookups. The
fee terms (`defaultFeeRecipient`, `defaultProtocolFeeBps`) and the `implementation`
are all immutable, so there is no setter and no admin. To change the protocol fee,
the fee recipient, or the core logic, a new factory is deployed alongside a new
implementation, never by mutating houses that already exist.

# concepts

### Clone-and-initialize is one transaction

`createAuctionHouse` clones `implementation` with OpenZeppelin
`Clones.cloneDeterministic` and calls `initialize` on the fresh clone in the same
call, wiring in the caller as owner and the factory's `defaultFeeRecipient` and
`defaultProtocolFeeBps`. The house comes into existence already owned and
fee-configured; there is no window between deploy and configuration for anyone to
front-run.

### One house per owner, at a predictable address

The clone salt is the owner address, so each address can have exactly one house
from this factory (`House already exists` on a repeat call), and the house's address
is deterministic from the owner alone. `predictHouseAddress` returns that address
whether or not the house has been deployed yet, so a client can show "your house
will live at 0x..." before the user signs the deploy transaction. Note that ETH sent
to the predicted address before the house exists is not recoverable; only deploy the
house first, then interact with it.

## function createAuctionHouse

access: permissionless (anyone may deploy; the new house is owned by `msg.sender`)

Deploys an EIP-1167 clone of `implementation` owned by the caller and initializes it
atomically with the factory's `defaultFeeRecipient` and `defaultProtocolFeeBps`.
The clone salt is the caller address, so each address gets at most one house here:
a second call from the same address reverts `House already exists`. On success,
records the house in `houseOf`, appends it to `allHouses`, marks it in `isHouse`,
and emits `AuctionHouseCreated`. Returns the new house address.

```solidity
address house = factory.createAuctionHouse();
```

## function allHouses

Every auction house address the factory has deployed, in creation order. Indexers
typically watch `AuctionHouseCreated` rather than paging this array, but it is
available for direct onchain enumeration.

## function houseOf

The auction house address deployed for a given owner, or the zero address if that
owner has never created one. Each owner can have at most one house from this
factory.

## function isHouse

Whether an address is an auction house this factory deployed. Cheaper than scanning
`allHouses` when a caller only needs a membership check.

## function predictHouseAddress

The address the auction house for a given owner will land at (or already lives at).
The salt is the owner address, the same input `createAuctionHouse` uses, so the
result is deterministic regardless of whether the house has been deployed yet. ETH
or NFTs sent to the predicted address before the house is deployed are not generally
recoverable, so deploy first.

```bash
cast call {{addr:auctionHouseFactory}} "predictHouseAddress(address)(address)" \
  <OWNER_ADDRESS> \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function totalHouses

The length of `allHouses`: the total number of auction houses this factory has
deployed.

## function implementation

The `SovereignAuctionHouse` implementation address every clone points at via
`DELEGATECALL`. Fixed at factory construction; there is no setter, so every house
this factory has ever created or will create shares the exact same core logic.

## function defaultFeeRecipient

The fee recipient wired into every house this factory deploys, fixed at construction.
It is the zero address only when `defaultProtocolFeeBps` is zero.

## function defaultProtocolFeeBps

The protocol fee in basis points baked into every house this factory deploys, fixed
at construction and capped at 500 (5%).

## event AuctionHouseCreated

Emitted once per successful `createAuctionHouse` call, with `owner` and `house` both
indexed, and carrying the immutable `feeRecipient` and `protocolFeeBps` so an indexer
can recover a house's fee terms without an extra read. This is the single event an
indexer needs to discover every house this factory has produced.

## error FailedDeployment

Inherited from OpenZeppelin `Clones`. The EIP-1167 clone deployment failed at the
`CREATE2` opcode level, for example if a house for this owner already exists at the
deterministic address. Not expected in normal operation against a valid
`implementation`.

## error InsufficientBalance

Inherited from OpenZeppelin `Clones`. Raised by the value-forwarding clone variants
when the factory's own ETH balance is less than the value being forwarded to the new
clone. `createAuctionHouse` does not forward value, so this is not reachable through
the factory's public surface today.
