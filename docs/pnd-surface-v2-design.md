# Surface v2: primitive-first design

> **Status: design agreed 2026-10-26, pre-implementation.** This supersedes
> `docs/pnd-surface-v2-plan.md` (the August "path 1" strip plan) and the
> v2 contracts currently in `contracts/src/surface/v2/`, which are deployed
> on Sepolia only. Nothing on mainnet changes: the v1 sources, Homage, and
> abstracts stay exactly as they are. `docs/pnd-surface-system.md` remains
> the historical rationale; where it disagrees with this document, this
> document wins.

## 1. Why

v1 embedded everything in the token: the paid mint path, price curves, a
hook slot, two id modes, attribution. Every product change was a core
change, every core change was a re-audit, and several one-way decisions
had to be undone (graph, path, mint marks, hooks, pooled mode). The one
launch that went smoothly, Homage, used the token as a dumb mint target
under its own minter and ignored the embedded machinery.

v2 goes the rest of the way: a small set of **primitives**, each holding
only what cannot live anywhere else, composed by a replaceable
**launcher**. Opinions live in the launcher and the studio, never in a
primitive.

## 2. The rule for what goes in the token

A thing lives in the token only if one of three is true:

1. **It gates the token's own state change.** An outside contract cannot
   veto a mint the token performs without the token calling out to it,
   and calling out is the hook pattern v1 removed.
2. **It is written at a moment that cannot be recreated.** The seed is
   the only example.
3. **A standard makes marketplaces read it from the token address.**
   `tokenURI`, `royaltyInfo`, the ERC-4906 refresh event.

Everything else is a sibling that borrows authority from the token by
asking it `owner()`.

Companion rules:

- No primitive ships without a concrete composition that uses it.
- New behaviour is a new contract, never a new field.
- One global invariant per primitive, enforced there. Nothing enforces
  across primitives.
- Each primitive has its own interface file, tests, audit scope and
  deploy record.

## 3. Contracts

| Contract | Kind | Approx. lines |
| --- | --- | --- |
| `Surface` | token primitive, EIP-1167 clone per collection | 220 |
| `FixedPriceSale` | sale primitive, clone per sale | 260 |
| `AllowlistGate` | gate primitive, one ownerless singleton | 60 |
| `CloneFactory` | plumbing, one instance per implementation | 60 |
| `Launcher` | the common wiring, replaceable | 90 |

Renderers are unchanged: `IRenderer`, `IPreviewRenderer`, and the
artist-deployed `BatchRenderRouter`. The Catalog is unchanged and
attribution no longer appears anywhere in Surface.

### 3.1 Surface (token)

OpenZeppelin `ERC721Upgradeable` (initializer pattern only; clones are
immutable) plus plain `OwnableUpgradeable`. No two-step ownership, no
admins, no reentrancy guard (the mint path runs no external code).

**State**

- `renderer` (address, nonzero, must have code)
- `minter` (address, one slot; zero = no one can mint)
- `supplyCap` (uint256; 0 = open)
- `royaltyBps` (uint16, max 5000), `royaltyReceiver` (address, nonzero)
- `_mintedEver`, `_burnedCount`
- `_seed[tokenId]` (bytes32), the only per-token storage
- `_locks` (uint8 bitmask: RENDERER = 1, MINTER = 2, SUPPLY = 4,
  ROYALTY = 8)

**Initialize** `(name, symbol, owner, renderer, supplyCap, royaltyBps,
royaltyReceiver)`. Reverts on zero owner, zero or codeless renderer, zero
receiver, royalty above cap. Emits `RendererSet`, `RoyaltySet`,
`SupplyCapSet` so an indexer learns initial state from logs. The minter
is set afterwards by the launcher or the owner.

**Mint and burn**

- `mintTo(address to, uint256 quantity) returns (uint256 firstTokenId)`:
  `msg.sender == minter`, quantity > 0, `_mintedEver + quantity <= cap`
  when cap is set. Ids are `_mintedEver + 1 ..`. Uses `_mint`, never
  `_safeMint`. Stores `keccak256(abi.encode(block.prevrandao,
  address(this), tokenId))` per token. One event:
  `Minted(address indexed minter, address indexed to, uint256
  firstTokenId, uint256 quantity)`.
- `burn(uint256 tokenId)`: holder or approved. `Burned(tokenId)`. Burns
  never free cap. The seed stays readable.
- `totalSupply()` = minted ever minus burned.

**Owner setters, each refused once its lock bit is set**

- `setRenderer(address)` (nonzero, has code; emits `RendererSet`,
  `BatchMetadataUpdate(0, max)`, `ContractURIUpdated`)
- `setMinter(address)` (zero allowed; emits `MinterSet`)
- `setSupplyCap(uint256)` (0 = open; never below `_mintedEver`)
- `setRoyalty(uint16 bps, address receiver)` (receiver nonzero)

**Permanence**

- `lock(uint8 mask)`: one-way OR into `_locks`. Emits `Locked(mask)`.
- `seal()`: `lock(ALL)` then `_transferOwnership(address(0))`. Emits
  `Sealed()`.
- `renounceOwnership()` reverts `UseSeal()`. Owner-is-zero therefore
  always means sealed.
- Reads: `locks() returns (uint8)`, `sealed() returns (bool)`,
  `version() returns (uint256)` = 2.

**Standard surface**

- `tokenURI(id)` → `IRenderer(renderer).tokenURI(address(this), id)`
- `contractURI()` → `IRenderer(renderer).contractURI(address(this))`
- `royaltyInfo(id, salePrice)` → stored receiver, `salePrice * bps /
  10_000`
- `supportsInterface`: ERC-721, ERC-721 Metadata, ERC-2981, ERC-4906
- `notifyMetadataUpdate(from, to)`: callable by the renderer or the
  owner; emits `BatchMetadataUpdate`.
- `rescueStrayETH(to)`: owner-only sweep of the full balance. No
  function of the token is payable.
- `_update` rejects `to == address(this)` (`SelfCustodyRejected`).

**Reads for renderers** (the stable surface): `tokenSeed(id)` (reverts
`NeverMinted` out of range), `config()` returning
`(renderer, minter, supplyCap, royaltyBps, royaltyReceiver, locks,
minted)`, `renderer()`, `name()`. No `idMode` shim.

**Invariants**

- Token id equals mint order; ids are never reused.
- `_mintedEver` never exceeds a set cap; every mint path checks it.
- The token never holds ETH and the mint path makes no external call.
- Lock bits only ever turn on. `owner() == 0` implies `locks() == ALL`.

### 3.2 FixedPriceSale (minter)

A clone bound to one collection at `initialize`. Holds this sale's
money and rules and nothing about the artifact.

**Initialize** `(collection, price, mintStart, mintEnd, maxMints,
walletCap, payoutRecipient, gate)`. Authority: allowed
only if `ISurface(collection).minter() == address(this)` already (the
launcher's path, the token granted it first) **or** `msg.sender ==
ISurface(collection).owner()`. No "owner is zero" window. Rejects a zero
collection, a codeless collection, a zero payout recipient, `mintEnd <=
mintStart` when both set.

**Config**, every setter gated on `collection.owner()`:
`setPrice`, `setMintWindow`, `setMaxMints`, `setWalletCap`,
`setPayoutRecipient` (nonzero), `setGate` (zero = none; nonzero must have
code), `close()` (one-way; `Closed()`).

**Mint** `mint(address to, uint256 quantity, address referrer, bytes
data) payable`, `nonReentrant`. One signature; no overload. Checks, in
order:

1. not closed
2. inside the window (`mintStart` 0 = open now, `mintEnd` 0 = open
   ended)
3. `totalMinted + quantity <= maxMints` when set
4. gate: if `gate != 0`, `IGate(gate).check(collection, to, quantity,
   data)` must return true
5. `mintedBy[to] + quantity <= walletCap` when set
6. `msg.value == price * quantity` exactly
7. if `to.code.length != 0`, `to` must answer `onERC721Received` (the
   receiver check lives here, not in the token)
8. `ISurface(collection).mintTo(to, quantity)`
9. `totalMinted += quantity`; `mintedBy[to] += quantity` on every mint,
   capped or not
10. settle: `REFERRAL_SHARE_BPS` (a constant, 500 = 5%) of the payment to
    `referrer` when nonzero, remainder to `payoutRecipient`, both as pull
    balances; `Sold(payer, to, referrer, quantity, paid, firstTokenId)`
    and `ReferralPaid` when nonzero.

**Referral share.** Fixed at 5% by constant; no setter, no init param. It
pays whoever hosts the mint. A mint with a zero referrer sends the whole
payment to the payout recipient, and an artist's own site passes the
artist's address as referrer, so the artist keeps 100% there. A collector
minting straight from the contract can name themselves; that is the
accepted property of every open referral scheme and is not gatekept.

**Payouts.** Pull payment only. `withdraw(address account)` sends the
owed balance to `account`, callable by anyone. `withdrawTo(address to)`
sends the caller's own balance to `to`. `pendingWithdrawal(account)`.
`rescueStrayETH(to)` sweeps only the balance above the sum of pending
balances.

**Identification.** `version() returns (uint256)` = 2 and
`supportsInterface(type(IMinter).interfaceId)`, so a client that reads a
collection's `minter()` can tell a canonical sale from a bespoke minter.

**Reads.** `priceOf(to, quantity)`, every config field, `totalMinted`,
`mintedBy`. No alias getters.

**Invariant.** Sum of pending balances equals ETH paid in minus ETH
withdrawn; no caller can withdraw more than it is owed.

### 3.3 IGate and AllowlistGate

```solidity
interface IGate {
    function check(address collection, address to, uint256 quantity, bytes calldata data)
        external view returns (bool);
}
```

`AllowlistGate` is one ownerless singleton: `root[collection]` set by
`ISurface(collection).owner()` via `setRoot(collection, root)`. `check`
decodes `data` as `bytes32[]` and verifies the OpenZeppelin
standard-merkle-tree leaf `keccak256(bytes.concat(keccak256(abi.encode(to))))`.
Empty `data` fails cleanly. Gates are views; a gate that needs state
written per mint does not fit this interface, which is why the wallet
cap lives in the sale.

### 3.4 CloneFactory

One small contract, deployed once per implementation (token
implementation, sale implementation). Immutables: `implementation`,
`deployer`.

- `create(bytes initData) returns (address instance)` and
  `createDeterministic(bytes32 salt, bytes initData)`: clone, call
  `initialize` with `initData`, record `isInstance[instance] = true`,
  emit `Created(address indexed implementation, address indexed
  instance, address indexed caller)`.
- `predict(bytes32 salt, address caller) view` for the deterministic
  path (salt is namespaced by caller).
- `setPaused(bool)` and one-way `deprecate(address successor)`,
  deployer-only. Neither touches an existing instance.
- No array of instances. Discovery is the event plus `isInstance`.

### 3.5 Launcher

Immutable, references the token factory and the sale factory. Replaceable
without touching anything deployed; a bespoke project calls the factories
directly.

`launch(TokenParams t, SaleParams s) returns (address collection, address
sale)`:

1. `salt = keccak256(abi.encode(msg.sender, nonce++))`; `sale =
   saleFactory.predict(salt, address(this))`.
2. `collection = tokenFactory.create(initialize(t.name, t.symbol,
   t.owner, t.renderer, t.supplyCap, t.royaltyBps, t.royaltyReceiver ==
   0 ? t.owner : t.royaltyReceiver))`.
3. The launcher is not the owner, so it cannot call `setMinter`. The
   token therefore accepts an optional `minter` in its initialize
   params; the launcher passes the predicted sale address there.
4. `saleFactory.createDeterministic(salt, initialize(collection, s.price,
   ..., s.payoutRecipient == 0 ? t.owner : s.payoutRecipient, s.gate))`. The sale's init authority check passes because
   the token already names it.
5. Emit `Launched(address indexed owner, address indexed collection,
   address indexed sale)`.

The launcher holds every product default: the payout and royalty
fallbacks, "one sale per collection". Changing a default is a new
launcher.

## 4. Compositions

| Need | Composition |
| --- | --- |
| Priced drop | `Launcher.launch` |
| Batched editions (abstracts) | `launch` with the artist's `BatchRenderRouter` as renderer; raise `maxMints` per batch |
| Allowlist phase then public | `setGate(AllowlistGate)` and `setRoot`; later `setGate(0)` |
| Bespoke economics (Homage shape) | `tokenFactory.create` with `minter` = the bespoke minter; no launcher |
| Airdrop or artist proofs | `setMinter(ownerWallet)`, `mintTo`, `setMinter(sale)` |
| Two concurrent minters | a small router contract that is the minter and fans `mintTo` out to its own caller list |
| Collection cover and description | the renderer's `contractURI` |
| Co-creator credit | the Catalog, not Surface |

## 5. Removed and added relative to the Sepolia v2

**Removed:** two-step ownership; admin delegation; attribution
(`setCreators`, `isListedCreator`, `isConfirmedCreator`, the Catalog
pointer, the factory `catalog` immutable); `seedSource`, `mintToSeeded`,
`ISeedSourceV2`; the minter set, `_minterCount`, `primaryMinter`,
`setPrimaryMinter`, `lockMinter` as a separate function; the four
separate lock functions, events and reads; the zero-receiver royalty
sentinel and its lock-time snapshot; the `idMode` shim and the borrowed
v1 `SurfaceConfig` struct; `firstMintIndex` in `Minted`;
`SurfaceConfigured`; the reentrancy base on the token; `saleCap` and
`totalMintedByThisMinter`; the one-argument `mint` overload; the inline
Merkle allowlist in the sale (now a gate); `createSurface`,
`createSurfaceCustom` and `allSurfaces`; `IMinter`'s strategy-era
`Underpayment` error and NatSpec; `referralShareBps`, `setReferralShareBps`,
`MAX_REFERRAL_SHARE_BPS` and `ReferralShareSet`; `DefaultRenderer`, `RenderAssets`,
`ScriptyRenderer`, the vendored scripty interfaces, `ExampleScriptyWork`,
`CodeTypes` and `MetadataJson` from this system (they may return later
as a separate optional package); the renderer and v1-minter compat test
suites.

**Added:** `closed`; the ERC-721 receiver check in the sale;
`withdrawTo`; `version` and ERC-165 on the sale; `renounceOwnership`
reverting; `RendererSet`, `RoyaltySet`, `SupplyCapSet` at initialize;
`Sealed`; `IGate` and `AllowlistGate`; `CloneFactory` with
deterministic clones; `Launcher`.

**Kept:** everything that passed the section 2 test: ids, seed, cap,
renderer pointer, royalty, locks, seal, `notifyMetadataUpdate`,
`rescueStrayETH`, burn, `totalSupply`, the self-custody guard; in the
sale: price, window, ceiling, wallet cap, pull payouts, stored payout, the
referral share (now a fixed 5% constant instead of a settable field).

## 6. Tests

Per primitive, in `contracts/test/surface/v2/`:

- `Surface.t.sol`: initialize validation, mint/burn/cap, each setter and
  its lock bit, `seal`, `renounceOwnership` reverts, royalty, metadata
  delegation, self-custody guard, `rescueStrayETH`.
- `SurfaceInvariants.t.sol`: ids monotonic and never reused, cap never
  exceeded, lock bits only turn on, `owner() == 0` implies all locked,
  seed immutable once stored.
- `FixedPriceSale.t.sol`: init authority (both paths, and the rejection
  when neither holds), the ten checks in order, exact payment, wallet
  cap counted on every mint, gate wiring with a mock gate, receiver
  check, `close`, pull payment, `withdrawTo`, the fixed 5% referral
  math with zero, self and third-party referrers, config setters under
  borrowed authority.
- `FixedPriceSaleInvariants.t.sol`: value conservation.
- `AllowlistGate.t.sol`: root per collection, borrowed authority, leaf
  format, empty data.
- `CloneFactory.t.sol`: create, deterministic create and predict,
  `Created` event, pause, deprecate.
- `Launcher.t.sol`: the full launch, deterministic address matches,
  defaults applied, one `Launched` event, a bespoke-path launch without
  the launcher.
- `SurfaceSize.t.sol`: EIP-170 headroom for every implementation.
- `Deploy.t.sol`: the deploy script against every environment guard.

The default `forge test` profile stays green, and the v1 suite stays
untouched and green.

## 7. Deploy

One script, one wrapper (`contracts/script/deploy.sh <env>`), as today,
minus the default-renderer and render-assets branches. Order: token
implementation, sale implementation, `AllowlistGate`, token
`CloneFactory`, sale `CloneFactory`, `Launcher`. Factories land paused.
The deploy record is written from broadcast receipts after a code check,
never from the simulation. The record keys become `surfaceImplV2`,
`saleImplV2`, `allowlistGate`, `surfaceFactoryV2`, `saleFactoryV2`,
`launcherV2`, plus deploy block and tx hashes.

## 8. Follow-up work this unblocks (not part of the contract change)

- Indexer: bind on the two `Created` events and `Launched`; drop the
  `SurfaceCreated` v2 branch; record `minter()` from `MinterSet`;
  identify canonical sales by `version()`.
- Web: create flow calls `Launcher.launch`; settings panel reads `locks()`
  and one minter; sale panel adds `close`, gate and wallet cap; mint
  button uses the one `mint` signature; referral copy states the fixed
  5% and the self-host route-around.
- Docs: regenerate the reference from the new ABIs; retire the v1-model
  wording in the getting-started guide and glossary.

## 9. Decisions recorded and still open

**Decided 2026-10-26:** the referral share is a fixed 5% constant in the
sale, not a setting. Artists route around it on their own site by passing
their own address as referrer.

**Open:**

1. **External audit** for this v2 before mainnet, to be scoped after the
   implementation lands (token and sale are the money-relevant surface).
2. **Deprecate the v1 factory for new deploys** once this v2 is live on
   mainnet, naming the launcher as successor. v1 collections are
   unaffected.

## 10. Non-goals

- No change to anything deployed on mainnet.
- No pooled mode, backed works, companions or price strategies in this
  system. Bespoke minters remain the path for those.
- No no-code tier. The artist brings a renderer.
- Not a mass launchpad. This optimizes for PND's bespoke-first workload.
