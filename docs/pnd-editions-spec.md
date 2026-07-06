# PND Editions — interface spec

> **SUPERSEDED (2026-07-06).** The Editions contract was reworked into the
> SovereignCollection system (OZ ERC721 core, four slots, id modes); see
> docs/pnd-collection-system.md and docs/pnd-collection-contracts-plan.md.
> This document describes the pre-rework ERC721A design; payment-split,
> hook, and graph concepts carry over, token-layer specifics do not.
> Contracts now live in contracts/src/collection/ (src/editions/ was
> removed).

> **Status: v2, updated for the hardened contracts** in
> `contracts/src/editions/` (the contract is the source of truth). Since the
> original v2 the mint API split into `mint` / `mintWithRewards`, proceeds became
> pull payments (`withdraw`), and the contract gained `setPayoutAddress`,
> `freezeMetadata` / `isPermanent`, settle-before-upgrade, two-step ownership, a
> reference mint-hook library, and the bilateral graph handshake. See
> `docs/pnd-editions-security-review.md` and `docs/pnd-editions-design-review.md`.
> Read `docs/pnd-editions-README.md` for the overview and
> `docs/pnd-editions.md` for the product rationale.
>
> **Design constants:**
> - **ERC721A**, mainnet only.
> - **One contract == one edition.** The factory deploys + configures an
>   edition in one transaction. There is no separate project/release level.
> - **Fixed Surface Share** (`SURFACE_SHARE_BPS = 1000`, 10%): a protocol
>   constant, not artist-set. Paid out of the price to whoever hosts the mint
>   (PND on PND; the artist on their own site; folded back to the artist on a
>   direct mint). No other protocol fee.
> - **Always upgradeable** (UUPS); the owner can `seal()` to renounce it.
> - Per-token art via a swappable renderer + per-token CID override; pre/post
>   mint hooks; per-batch Mint Marks; per-contract Edition Graph + Token Path.

```
pragma solidity ^0.8.24;
```

## 0. Global node addressing: `Ref`

```solidity
enum RefKind { Edition, Token, External }

struct Ref {
    uint64  chainId;          // 1 = Ethereum mainnet
    address contractAddress;  // a PNDEditions edition, or any contract
    uint256 id;               // tokenId per `kind` (0 for an edition node)
    RefKind kind;
}
```

Canonical URN string (off chain): `pnd:<chainId>:<contract>:e` (edition),
`:t<tokenId>` (token), `:x<id>` (external). A `Ref` whose `contractAddress`
is a different edition is how cross-edition edges (phases, collaborations,
source objects) work — no registry is consulted.

## 1. Edition config

```solidity
enum EditionKind { Standalone, Study, Phase, Access, Source, Continuation }
enum EditionStatus { Open, Closing, Closed }

struct EditionConfig {
    string      artworkURI;     // CID-backed shared art; per-token overridable
    uint256     price;          // wei. 0 = gas only (never "free")
    uint256     supplyCap;      // 0 = open edition
    uint64      mintStart;      // unix seconds; 0 = open immediately
    uint64      mintEnd;        // unix seconds; 0 = open-ended
    uint16      royaltyBps;     // EIP-2981
    address     royaltyReceiver;// 0 = owner()
    EditionKind kind;           // graph role; default Standalone
    address     payoutAddress;  // artist proceeds; 0 = owner()
    address     renderer;       // 0 = default renderer
    address     mintHook;       // 0 = none
}
```

There is no `surfaceShareBps` field — the share is the fixed constant.

## 2. `IPNDEditions`

```solidity
interface IPNDEditions is IPNDMintMarks, IPNDEditionGraph, IPNDTokenPath {
    event EditionConfigured(
        EditionKind kind, uint256 price, uint256 supplyCap,
        uint64 mintStart, uint64 mintEnd, string artworkURI
    );
    // One event per mint() call (one ERC721A batch).
    event Minted(
        address indexed to, address indexed surface,
        uint256 firstTokenId, uint256 quantity, uint48 mintBlock,
        EditionStatus statusAtMint
    );
    event SurfacePaid(address indexed surface, uint256 amount);
    event ClosingSet(bool closing);
    event RendererSet(address renderer);
    event MintHookSet(address hook);
    event TokenArtworkSet(uint256 indexed tokenId, string cid);
    event Sealed();
    event Withdrawn(address indexed account, uint256 amount);
    event PayoutAddressSet(address payoutAddress);
    event MetadataFrozen();
    event StrayETHRescued(address indexed to, uint256 amount);

    // init + config (owner)
    function initialize(
        string calldata name_, string calldata symbol_, address owner_,
        EditionConfig calldata cfg, address defaultRenderer_
    ) external;
    function setClosing(bool closing) external;
    function setRenderer(address renderer) external;
    function setTokenArtwork(uint256 tokenId, string calldata cid) external;
    function setTokenArtworkBatch(uint256[] calldata tokenIds, string[] calldata cids) external;
    function setMintHook(address hook) external;
    function seal() external;

    // config (owner), cont.
    function setPayoutAddress(address payoutAddress) external;
    function freezeMetadata() external;            // one-way; see isPermanent()
    function rescueStrayETH(address to) external;  // only ETH not owed to a payee

    // mint
    /// @notice Honest default: surface = 0, the artist gets 100%.
    function mint(uint256 quantity) external payable;
    /// @notice Credits `surface` the fixed Surface Share (address(0) folds it to
    ///         the artist). `hookData` is forwarded to the mint hook if set.
    function mintWithRewards(uint256 quantity, address surface, bytes calldata hookData)
        external
        payable;

    // pull payments: proceeds accrue per-address; claim them here. withdraw is
    // permissionless (funds only ever go to `account`); upgrades are blocked
    // until all accrued balances are withdrawn (settle-before-upgrade).
    function withdraw(address account) external;
    function pendingWithdrawal(address account) external view returns (uint256);

    // reads
    function config() external view returns (EditionConfig memory cfg, EditionStatus status, uint256 minted);
    function surfaceShareBps() external view returns (uint16); // constant
    function artwork() external view returns (string memory);
    function tokenArtwork(uint256 tokenId) external view returns (string memory);
    function renderer() external view returns (address);
    function mintHook() external view returns (address);
    function isUpgradeable() external view returns (bool);
    function isSealed() external view returns (bool);
    function isMetadataFrozen() external view returns (bool);
    function isPermanent() external view returns (bool); // sealed && frozen
}
```

### 2.1 Mint payment split (reference logic)

```
total      = price * quantity                   // must equal msg.value
surfaceCut = surface == address(0) ? 0 : total * SURFACE_SHARE_BPS / 10000
artistCut  = total - surfaceCut
accrue surfaceCut -> _pending[surface]              (emit SurfacePaid)
accrue artistCut  -> _pending[payoutAddress | owner]
// claimed later via withdraw(); _totalPending gates upgrades (no drain).
```

Reentrancy-guarded. The hook (if set) is called before mint (must return
`IPNDMintHook.beforeMint.selector`) and after payment. Hooks are non-payable.

## 3. Mint Marks (per batch)

Each `mint()` call is one ERC721A batch; we store one record keyed by the
batch head tokenId. A token's mint order is derived directly from its id; the
per-batch fields (block, surface, status) come from its batch.

```solidity
struct MintBatch { uint48 mintBlock; uint8 statusAtMint; address surface; }
// mapping(uint256 batchHeadTokenId => MintBatch) + uint256[] batchHeads (ascending)

struct MintMark {
    uint32 indexInEdition;   // tokenId - startTokenId (0-based)
    uint48 mintBlock;
    EditionStatus statusAtMint;
    address surface;
    bool isFirst;            // indexInEdition == 0
    bool isFinal;            // edition Closed && tokenId == last minted
}
interface IPNDMintMarks { function mintMarkOf(uint256 tokenId) external view returns (MintMark memory); }
```

`mintMarkOf`: binary-search `batchHeads` for the batch; `indexInEdition =
tokenId - _startTokenId()`; `isFinal` true only once the edition is Closed.
`_startTokenId() == 1` (the first token is `#1`). Marks resolve for burned
tokens too (provenance outlives the token).

## 4. Renderer (`IPNDRenderer`)

`tokenURI` delegates to the resolved renderer (the edition's `renderer`, else
the built-in default). The default returns base64 JSON: per-token CID override
if set, else the edition `artwork()`, plus Mint Mark provenance attributes.
The renderer reads edition state from `msg.sender` via `IPNDEditionsView`
(`name`, `artwork`, `tokenArtwork`, `mintMarkOf`). Custom renderers (generative
/ fully onchain) just point `setRenderer` at their own `IPNDRenderer`.

## 5. Mint hooks (`IPNDMintHook`)

```solidity
interface IPNDMintHook {
    function beforeMint(address minter, uint256 quantity, uint256 firstTokenId, address surface, bytes calldata hookData) external returns (bytes4);
    function afterMint(address minter, uint256 quantity, uint256 firstTokenId, address surface, bytes calldata hookData) external;
}
```

Owner-set (in `EditionConfig.mintHook` at deploy, or `setMintHook` later),
non-payable, magic-value gated. `beforeMint` reverting (or wrong selector)
blocks the mint; `afterMint` is where the artist records custom data to their
own storage.

## 6. Edition Graph + Token Path

```solidity
enum EdgeType { BelongsTo, StudyOf, PhaseOf, Continues, Source, Access }
struct Edge { EdgeType edgeType; Ref target; }
interface IPNDEditionGraph {
    event EdgeAdded(EdgeType indexed edgeType, Ref target);
    event EdgeAcknowledged(EdgeType indexed edgeType, Ref source, bool ack);
    function addEdge(EdgeType edgeType, Ref calldata target) external;  // owner, append-only
    function edges() external view returns (Edge[] memory);
    // Bilateral handshake: B acknowledges an inbound edge claimed by A, so a
    // reader can show "verified mutual" vs "claimed" with no central registry.
    function acknowledgeEdge(EdgeType edgeType, Ref calldata source, bool ack) external;
    function isEdgeAcknowledged(EdgeType edgeType, Ref calldata source) external view returns (bool);
}

enum PathType { None, Continuation, Migration, Claim, Reveal, Burn, Custom }
struct Path { PathType pathType; Ref target; bytes32 data; }
interface IPNDTokenPath {
    event PathSet(uint256 indexed tokenId, PathType indexed pathType, Ref target, bytes32 data);
    event DefaultPathSet(PathType indexed pathType, Ref target, bytes32 data);
    function pathOf(uint256 tokenId) external view returns (Path memory); // token path, else edition default
    function setDefaultPath(PathType pathType, Ref calldata target, bytes32 data) external; // owner
    function setPath(uint256 tokenId, PathType pathType, Ref calldata target, bytes32 data) external; // owner (v1)
}
```

v1: pointer layer only (inert). Owner-gated; holder writes reserved for later.

## 7. Factory + upgradeability

```solidity
interface IPNDEditionsFactory {
    event EditionCreated(address indexed owner, address indexed edition);
    function createEdition(
        string calldata name, string calldata symbol, address owner, EditionConfig calldata cfg
    ) external returns (address edition);
    function implementation() external view returns (address);
    function defaultRenderer() external view returns (address);
}
```

Every edition is a UUPS proxy over one shared implementation, initialized with
the config in the same call. `_authorizeUpgrade` is `onlyOwner && !sealed`;
`seal()` renounces upgradeability permanently. `isUpgradeable()` / `isSealed()`
are public reads. `EditionCreated` is the single discovery event an indexer
watches.

## 8. tokenURI + persistence

`tokenURI` is fully renderer-driven (Section 4). v1 default: per-token CID
override, else the edition's CID-backed `artworkURI`, as JSON with provenance
attributes. Editions media is registered with the existing Preserve pinning /
CID availability signal.

## 9. Not in v1

Execution of `PathType` actions (pointer is inert); sale strategies /
allowlists / Dutch auctions / premints (an artist can gate in their own mint
hook); any secondary market / AMM / coin; any protocol fee beyond the fixed
Surface Share; a central registry for graph/path data.
