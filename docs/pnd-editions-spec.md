# PND Editions, Phase 0 interface spec

> **Status: draft v0.2, specification only.** These are the onchain
> interfaces and storage models for PND Editions. No implementation
> yet. The Solidity below is illustrative and is meant to pin down the
> ABI surface, the events any interface can rely on, and the storage
> layout decisions, before Phase 1 turns them into compiling Foundry
> contracts. Read `docs/pnd-editions.md` for the product rationale.
>
> **Design constants locked:**
> - **ERC721A**, mainnet only.
> - **One ERC721A contract per project.** Each new project an artist
>   makes is its own contract, deployed by the factory. A project holds
>   one or more **releases** (mint configurations). The common case is a
>   single release per project; multi release projects (phases in one
>   contract) are supported, not required.
> - **Per token art is a contract level capability.** The protocol does
>   not assume every token in a release shares one image. The default
>   path is shared art (frontend v1 uses this), but the contract allows
>   unique art per token via a swappable renderer and a per token
>   override.
> - **Swappable metadata renderer**, Zora style: a built in default
>   renderer that resolves to a CID pointer, replaceable by an artist
>   owned renderer contract per project (and optionally per release).
> - **Pre and post mint hooks**: an artist owned hook contract the
>   project calls on each mint, so the artist can gate mints or record
>   custom data to their own storage contract.
> - **Artist set fixed price.** Surface share comes out of the price.
> - **Opt in upgradeability.** The artist chooses immutable or
>   upgradeable at deploy time. Immutable is the conservative default the
>   UI should present first.
> - **Mint Marks recorded per mint batch.** Release Graph and Token Path
>   are a per contract interface, no central registry.

```
pragma solidity ^0.8.24;
```

---

## 0. Global node addressing: `Ref`

Every node in the Release Graph and every Token Path target is addressed
by a `Ref`. This is the onchain form. Interfaces also serialize it to a
canonical URN string for display and for cross interface links.

```solidity
enum RefKind {
    Release,   // id is a releaseId on `contractAddress`
    Token,     // id is a tokenId on `contractAddress`
    External   // id is interpreted by `contractAddress`'s own scheme
}

struct Ref {
    uint64  chainId;          // 1 = Ethereum mainnet (only value in v1)
    address contractAddress;  // a PNDEditions project (or any contract)
    uint256 id;               // releaseId or tokenId per `kind`
    RefKind kind;
}
```

**Canonical URN string** (off chain, for UIs and self hosted pages):

```
pnd:<chainId>:<contractAddress>:r<releaseId>     // a release node
pnd:<chainId>:<contractAddress>:t<tokenId>       // a token node
pnd:<chainId>:<contractAddress>:x<id>            // an external node
```

Examples:

```
pnd:1:0xabc...def:r3      release 3 in that project
pnd:1:0xabc...def:t47     token 47 in that project
```

A `Ref` whose `contractAddress` is a different project (a different
artist's contract) is how cross project edges (collaborations, source
objects, phases across contracts) work. No registry is consulted, the
reader just resolves the `Ref`.

---

## 1. Project, release, token

The hierarchy:

- **Project** = one ERC721A contract, deployed by the factory, owned by
  the artist. This is the unit the factory creates. "A new project" is
  "a new contract".
- **Release** = a mint configuration inside a project: price, window,
  cap, default art, kind, royalty, optional renderer/hook overrides. A
  project has one or more releases. Single release projects are the
  common case.
- **Token** = an individual ERC721A token minted under a release. Has
  its own id, its own Mint Mark, its own Token Path slot, and (if the
  artist wants) its own art.

```solidity
enum ReleaseKind {
    Standalone,    // self contained
    Study,         // a study toward another release
    Phase,         // one phase of a multi phase work
    Access,        // holding a token grants access to another node
    Source,        // a source object others derive from
    Continuation   // continues a prior release
}

// Lifecycle snapshot captured into each Mint Mark. Distinct from
// ReleaseKind: kind is semantic and lives on the release and in graph
// edges, status is the moment in the mint lifecycle.
enum ReleaseStatus {
    Open,      // within window and under cap
    Closing,   // artist flagged the release as closing soon (optional)
    Closed     // window ended or cap reached
}

struct ReleaseConfig {
    string      defaultArtworkURI; // CID backed; the shared art used when a
                                   // token has no per token override
    uint256     price;             // wei. 0 = gas only (never call it "free")
    uint16      surfaceShareBps;   // 0..10000, share of price routed to surface
    uint256     supplyCap;         // 0 = open edition
    uint64      mintStart;         // unix seconds; 0 = open immediately
    uint64      mintEnd;           // unix seconds; 0 = open ended
    uint16      royaltyBps;        // EIP-2981
    address     royaltyReceiver;
    ReleaseKind kind;
    address     payoutAddress;     // artist proceeds recipient
    address     renderer;          // 0 = inherit project renderer
    address     mintHook;          // 0 = inherit project hook (or none)
}
```

Notes:

- `price == 0` is the gas only case. Contract events and UI must say
  "gas only", never "free".
- `surfaceShareBps` is a share **of the price**, taken out of it, not
  added on top. The collector always pays exactly `price * quantity`.
- `defaultArtworkURI` is the shared image for the release. A token may
  override it (Section 4). Frontend v1 only uses the default.
- An open edition (`supplyCap == 0`, `mintEnd == 0`) is allowed but
  should be a deliberate choice in the UI, not a default.

---

## 2. `IPNDEditions` (the per project ERC721A contract)

```solidity
interface IPNDEditions /* is IERC721A, IERC2981 */ {

    // --- events ---

    event ReleaseCreated(
        uint256 indexed releaseId,
        ReleaseKind kind,
        uint256 price,
        uint16 surfaceShareBps,
        uint256 supplyCap,
        uint64 mintStart,
        uint64 mintEnd,
        string defaultArtworkURI
    );

    // One event per mint() call (one ERC721A batch). `firstTokenId` is
    // the batch head; the batch covers [firstTokenId, firstTokenId+quantity-1].
    event Minted(
        uint256 indexed releaseId,
        address indexed to,
        address indexed surface,
        uint256 firstTokenId,
        uint256 quantity,
        uint32  startIndexInRelease,
        uint48  mintBlock,
        ReleaseStatus statusAtMint
    );

    event SurfacePaid(
        uint256 indexed releaseId,
        address indexed surface,
        uint256 amount
    );

    event RendererSet(uint256 indexed releaseId, address renderer); // releaseId max = project default
    event MintHookSet(uint256 indexed releaseId, address hook);
    event TokenArtworkSet(uint256 indexed tokenId, string cid);

    // --- writes ---

    function createRelease(ReleaseConfig calldata cfg)
        external
        returns (uint256 releaseId);

    /// @notice Mint `quantity` tokens of `releaseId` to msg.sender.
    /// @param surface The mint surface payout address. PND's frontend
    ///        passes PND's address; a self hosted page passes the
    ///        artist's chosen address; address(0) folds the surface
    ///        share back to the artist payout.
    /// @param hookData Opaque payload forwarded to the mint hook (if any).
    /// Requirements: msg.value == price * quantity; within window; under cap.
    function mint(
        uint256 releaseId,
        uint256 quantity,
        address surface,
        bytes calldata hookData
    ) external payable;

    /// @notice Artist flags a release as Closing for the lifecycle
    ///         snapshot. Not required for Closed (derived from window/cap).
    function setClosing(uint256 releaseId, bool closing) external;

    // --- metadata / extensibility (owner only) ---

    /// @notice Set the project default renderer. address(0) restores the
    ///         built in default renderer.
    function setProjectRenderer(address renderer) external;

    /// @notice Per release renderer override. address(0) = inherit project.
    function setReleaseRenderer(uint256 releaseId, address renderer) external;

    /// @notice Per token art override (CID). Used by the built in default
    ///         renderer; custom renderers may ignore it.
    function setTokenArtwork(uint256 tokenId, string calldata cid) external;
    function setTokenArtworkBatch(uint256[] calldata tokenIds, string[] calldata cids) external;

    /// @notice Set the project default mint hook. address(0) = none.
    function setProjectMintHook(address hook) external;
    /// @notice Per release hook override. address(0) = inherit project.
    function setReleaseMintHook(uint256 releaseId, address hook) external;

    // --- upgrade control (see Section 7) ---

    /// @notice Renounce upgradeability permanently. Only callable on an
    ///         upgradeable project. After this, isUpgradeable() == false
    ///         forever. No effect on immutable (clone) projects.
    function seal() external;

    // --- reads ---

    function release(uint256 releaseId)
        external
        view
        returns (ReleaseConfig memory cfg, ReleaseStatus status, uint256 minted);

    function totalReleases() external view returns (uint256);
    function rendererOf(uint256 releaseId) external view returns (address);
    function mintHookOf(uint256 releaseId) external view returns (address);
    function isUpgradeable() external view returns (bool);
    function isSealed() external view returns (bool);
}
```

### 2.1 Mint payment split (reference logic)

```
total      = price * quantity                     // must equal msg.value
surfaceCut = surface == address(0)
               ? 0
               : total * surfaceShareBps / 10000
artistCut  = total - surfaceCut

pay artistCut  -> release.payoutAddress
pay surfaceCut -> surface           (emit SurfacePaid)
```

Use a reentrancy guard. The mint hook and the two payouts are external
calls. There is no protocol fee and no PND recipient in this function.

### 2.2 Mint call order of operations

```
1. validate: within [mintStart, mintEnd], under supplyCap, msg.value == price*quantity
2. firstTokenId = _nextTokenId()            // known before minting in ERC721A
3. resolve hook = mintHookOf(releaseId)
4. if hook != 0: hook.beforeMint(..., firstTokenId, ...) must return BEFORE_MINT_MAGIC (else revert)
5. _mint(msg.sender, quantity)              // ERC721A batch [firstTokenId .. +quantity-1]
6. record MintBatch (Section 3); update release counters
7. split + pay (2.1)
8. if hook != 0: hook.afterMint(..., firstTokenId, ...)   // artist records custom data here
9. emit Minted
```

Hooks are **not** payable in v1, so the honest pricing invariant
(collector pays exactly `price * quantity`) is preserved. Hook driven
extra charges are out of scope for v1.

---

## 3. Mint Marks, the per batch model

The provenance design that makes ERC721A and rich per token marks
coexist: **a Mint Mark is computed, not stored per token.** Per token
storage would defeat ERC721A's batch savings. Instead each `mint()` call
(one contiguous ERC721A batch) writes one batch record, and any token's
mark is derived from the batch it falls in.

```solidity
struct MintBatch {
    uint16        releaseId;
    uint32        startIndexInRelease; // indexInRelease of the head token
    uint48        mintBlock;           // block.number at mint
    ReleaseStatus statusAtMint;        // uint8
    address       surface;             // 20 bytes
}
// stored as: mapping(uint256 batchHeadTokenId => MintBatch)
// plus:      uint256[] batchHeads   // ascending by construction
```

`startIndexInRelease` is the running per release mint counter captured
before this batch. The contract keeps `releaseMinted[releaseId]` and
increments it by `quantity` on each mint, so indices stay correct even
if two releases are minted in interleaved transactions (token ids are
globally sequential per ERC721A, but a release's tokens need not be
contiguous).

Storage cost per mint **call** (not per token): the `MintBatch` record
(2 slots) plus one push to `batchHeads`. A batch of 10 amortizes that
across 10 tokens. This is what keeps per token provenance from clawing
back ERC721A's batch savings.

### 3.1 The public Mint Mark (derived)

```solidity
struct MintMark {
    uint16        releaseId;
    uint32        indexInRelease;  // 0-based mint order within the release
    uint48        mintBlock;
    ReleaseStatus statusAtMint;
    address       surface;
    bool          isFirst;         // indexInRelease == 0
    bool          isFinal;         // release Closed && tokenId == lastTokenId[releaseId]
}

interface IPNDMintMarks {
    function mintMarkOf(uint256 tokenId) external view returns (MintMark memory);
}
```

Resolution of `mintMarkOf(tokenId)`:

1. Binary search `batchHeads` for the greatest head `<= tokenId`. Call
   it `head`.
2. Load `b = batchAt[head]`.
3. `indexInRelease = b.startIndexInRelease + (tokenId - head)`.
4. `isFirst = (indexInRelease == 0)`.
5. `isFinal = release Closed and tokenId == releaseLastTokenId[releaseId]`.

Per release bookkeeping needed for `first` / `final`:

```solidity
mapping(uint256 => uint256) releaseFirstTokenId;  // set on first mint
mapping(uint256 => uint256) releaseLastTokenId;   // updated each mint
mapping(uint256 => uint256) releaseMinted;        // running count
```

Notes:

- Marks are permanent. `mintMarkOf` reads PND's own mappings, so it
  still resolves for a burned token (provenance outlives the token).
- `isFinal` is only meaningful once the release is `Closed`.
- No rarity. No random traits, no reveal, no rank. A mark is a stamp on
  the back of the print.
- The renderer (Section 4) may surface Mint Mark fields as provenance
  attributes in token JSON, framed as provenance, never as rarity.

---

## 4. Metadata renderer (`IPNDRenderer`)

Zora style swappable rendering. The project has a default renderer set
to the canonical built in renderer at deploy; the artist can replace it
per project, and override it per release. `tokenURI` always delegates to
the resolved renderer.

```solidity
interface IPNDRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function contractURI() external view returns (string memory);
}
```

Resolution inside the project's `tokenURI(tokenId)`:

```
releaseId = release owning tokenId        // via the batch model
r = setReleaseRenderer[releaseId] (if set)
    else setProjectRenderer (if set)
    else BUILT_IN_DEFAULT_RENDERER
return r.tokenURI(tokenId)
```

The **built in default renderer** behavior (the fallback):

```
art = tokenArtworkURI[tokenId]            // per token override, if set
      else release.defaultArtworkURI      // shared release art
return JSON {
  name, description,
  image: art,
  attributes: [ provenance from MintMark: mint order, mint block,
                surface, status at mint, first/final ]
}
```

This delivers all three requirements at once:

- **Shared art by default** (frontend v1): no per token override set, the
  renderer returns the release's `defaultArtworkURI`.
- **Unique art per token**: the artist sets `setTokenArtwork(tokenId,
  cid)`, or ships a custom renderer that computes/looks up art per token
  (generative, manifest based, fully onchain SVG/HTML, anything).
- **Artist owned rendering**: `setProjectRenderer` / `setReleaseRenderer`
  point at the artist's own `IPNDRenderer` contract.

Per token art is therefore a contract capability regardless of what the
v1 frontend exposes. A prolific per token project would typically use a
custom renderer rather than thousands of `setTokenArtwork` writes.

---

## 5. Mint hooks (`IPNDMintHook`)

An artist owned contract the project calls on each mint. This is the
"build on / record custom data on each mint" capability the artist
wanted from Zora's old contracts: gate mints, record provenance to the
artist's own storage contract, drive an external system, all without PND
building those features into the core.

```solidity
interface IPNDMintHook {
    // Return value must equal this selector to authorize the mint.
    // bytes4(keccak256("beforeMint(address,uint256,uint256,uint256,address,bytes)"))
    function beforeMint(
        address minter,
        uint256 releaseId,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes calldata hookData
    ) external returns (bytes4);

    function afterMint(
        address minter,
        uint256 releaseId,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes calldata hookData
    ) external;
}
```

Semantics:

- The hook is **owner set** (the artist's own contract). Trust is
  artist scoped: a misbehaving hook only harms that artist's own
  project. Collectors can read `mintHookOf(releaseId)` to see it.
- `beforeMint` can revert to **gate** a mint (custom allowlist, anti bot,
  per wallet limits, external conditions) without PND shipping any of
  those as protocol features.
- `afterMint` is where the artist **records custom data** to their own
  storage contract, keyed by `firstTokenId`/`quantity`.
- Hooks are non payable in v1 (preserves honest pricing). The project
  uses a reentrancy guard around the whole mint.
- The magic value return on `beforeMint` prevents accidentally pointing
  at a contract that is not actually a hook.

---

## 6. `IPNDTokenPath`

Each token id has exactly one forward pointer slot, empty at mint. V1 is
the **pointer layer only**: it stores and emits a typed pointer, it does
not execute anything. Continuation, migration, claim, reveal, and burn
are interpretations a later version (or another contract, possibly via a
mint hook style extension) applies to the pointer.

```solidity
enum PathType {
    None, Continuation, Migration, Claim, Reveal, Burn, Custom
}

struct Path {
    PathType pathType;
    Ref      target;
    bytes32  data;   // optional aux payload, scheme defined by pathType/Custom
}

interface IPNDTokenPath {
    event PathSet(uint256 indexed tokenId, PathType indexed pathType, Ref target, bytes32 data);
    event ReleaseDefaultPathSet(uint256 indexed releaseId, PathType indexed pathType, Ref target, bytes32 data);

    /// @notice Resolve a token's path: explicit per token path if set,
    ///         else the release level default, else PathType.None.
    function pathOf(uint256 tokenId) external view returns (Path memory);

    function setReleaseDefaultPath(uint256 releaseId, PathType pathType, Ref calldata target, bytes32 data) external;
    function setPath(uint256 tokenId, PathType pathType, Ref calldata target, bytes32 data) external;
}
```

v1 authority: `setPath` and `setReleaseDefaultPath` are owner (artist)
gated. The per token slot still exists for every token, so a token can
diverge from its release default later, and a future version can open
holder writes without a storage migration. `pathOf` returns the explicit
per token path if set, otherwise the release default, otherwise `None`.

---

## 7. `IPNDReleaseGraph`

Directed, typed, append only edges from a release to any `Ref`. Owner
gated. Cross project and cross artist edges are just a `Ref` whose
`contractAddress` differs.

```solidity
enum EdgeType {
    BelongsTo,   // this release is part of a larger work
    StudyOf,     // this release is a study toward the target
    PhaseOf,     // this release is a phase of the target work
    Continues,   // this release continues / follows the target
    Source,      // this release is a source the target derives from
    Access       // holding this release's tokens grants access to target
}

struct Edge { EdgeType edgeType; Ref target; }

interface IPNDReleaseGraph {
    event EdgeAdded(uint256 indexed releaseId, EdgeType indexed edgeType, Ref target);
    function addEdge(uint256 releaseId, EdgeType edgeType, Ref calldata target) external;
    function edgesOf(uint256 releaseId) external view returns (Edge[] memory);
}
```

v1 semantics: append only (no edit, no remove) for provenance
integrity. Correct a mistake by adding a clarifying edge, not by
rewriting history.

---

## 8. Factory and upgradeability

Opt in upgradeability. The artist chooses the deployment mode per
project. The factory holds one shared implementation (the `PNDEditions`
logic) and deploys one of two proxy shapes.

```solidity
enum ProjectMode {
    ImmutableClone,  // EIP-1167 minimal proxy. No upgrade code. Cheapest. Default in UI.
    Upgradeable      // ERC1967 (UUPS) proxy. Owner can upgrade until seal().
}

interface IPNDEditionsFactory {
    event ProjectCreated(
        address indexed owner,
        address indexed project,
        ProjectMode mode
    );

    /// @notice Deploy a new per project ERC721A contract.
    function createProject(
        string calldata name,
        string calldata symbol,
        address owner,
        ProjectMode mode
    ) external returns (address project);

    function implementation() external view returns (address);
    function defaultRenderer() external view returns (address);
}
```

Mode semantics:

- **ImmutableClone**: EIP-1167 clone of `implementation`. Immutable by
  bytecode, no upgrade path exists, maximal credibility, cheapest
  deploy. `isUpgradeable() == false`.
- **Upgradeable**: ERC1967 UUPS proxy. `_authorizeUpgrade` is gated on
  `owner() && !sealed`. The owner can upgrade, and can later call
  `seal()` to renounce upgradeability permanently (converting it to
  effectively immutable). `isUpgradeable() == !sealed`.

The shared `PNDEditions` implementation is initializer based (no
constructor), so it works as both a clone target and a UUPS impl:
`initialize(name, symbol, owner, mode, defaultRenderer)`.

Transparency: both `isUpgradeable()` and `isSealed()` are public reads so
any interface (and any collector) can see a project's mutability stance.
The UI should present ImmutableClone first and make Upgradeable a
conscious opt in.

The factory is the single fixed contract Ponder watches for discovery
(mirrors how `mint_creators` is populated from Mint's `Created`).
`ProjectCreated` carries `owner` and `project` so the existing indexer
pattern needs no new primitives.

---

## 9. Token id convention

- ERC721A `_startTokenId()` returns **1**. The first token a project
  ever mints is `#1`. `indexInRelease` is relative to each release, so
  absolute token id and mint order within the release are different
  numbers and both are exposed.
- Token ids are globally sequential across all releases in one project
  (ERC721A requirement). A release's tokens are therefore not guaranteed
  contiguous, which is why Mint Marks resolve through the batch model in
  Section 3.

---

## 10. tokenURI and metadata persistence

- `tokenURI(tokenId)` delegates to the resolved renderer (Section 4).
- v1 default renderer: per token CID override if set, else the release
  `defaultArtworkURI` (CID backed), returning JSON with provenance
  attributes from the Mint Mark.
- Fully onchain media (SVG/HTML) and generative per token art are
  supported by shipping a custom renderer, not required in v1.
- PND Editions media is registered with the existing Preserve pinning /
  CID availability signal so onchain readability and self hosting are
  backed by real persistence, not a single gateway.

---

## 11. What this spec deliberately does not define (v1)

- Any execution semantics for `PathType` values (the pointer is inert).
- Sale strategies, allowlists, Dutch auctions, premint signatures (an
  artist can build allowlist style gating in their own mint hook).
- Any secondary market, ERC20 wrapping, AMM, or coin.
- Any protocol fee recipient. There is none.
- A central registry for graph or path data. The interfaces are the
  standard, each project contract is the store.
- Payable mint hooks (preserves honest pricing in v1).

---

## 12. Resolved decisions and remaining ABI questions

**Resolved (this revision):**

- One ERC721A contract per project (factory deploys per project).
- Per token art is a contract capability via renderer + per token CID
  override; frontend v1 uses shared release art.
- Swappable renderer with built in CID fallback (Zora style).
- Pre and post mint hooks, owner set, non payable, magic value gated.
- Artist set fixed price; surface share out of price; `surface == 0`
  folds to artist.
- Opt in upgradeability: ImmutableClone (default) vs Upgradeable (UUPS,
  sealable).
- `_startTokenId == 1`. Mint Marks stored per batch onchain and emitted.
- Append only graph edges. Token Path artist gated in v1.

**Still open (close before Phase 1):**

1. Hook scope: project default plus per release override (assumed). Want
   per token hooks too, or is per release enough?
2. Renderer override granularity: project plus per release (assumed).
   Per token renderer is unusual; per token CID override covers it.
3. `ReleaseStatus { Open, Closing, Closed }` and `ReleaseKind { ... }`
   member sets. Confirm.
4. EIP-2981 on `ReleaseConfig` (assumed present). Per release royalty
   confirmed?
5. Upgradeable projects: owner is the upgrade authority (assumed). Any
   timelock or second signer wanted, or keep it owner only for v1?
6. Should `seal()` also be available as a one way switch on a project
   that was deployed Upgradeable but the artist later wants to lock (yes,
   assumed) and should sealing emit an event for collectors (yes,
   assumed)?
