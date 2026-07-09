// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {
    CollectionConfig,
    CollectionStatus,
    CollectionKind,
    IdMode,
    InitParams,
    MintMark,
    WorkConfig,
    Edge,
    EdgeType,
    Path,
    PathType,
    Ref
} from "../CollectionTypes.sol";

/// @title IMintMarks
/// @notice Derived, per-token provenance.
interface IMintMarks {
    function mintMarkOf(uint256 tokenId) external view returns (MintMark memory);
}

/// @title ICollectionGraph
/// @notice Directed, typed, append-only edges from this collection to any node.
interface ICollectionGraph {
    event EdgeAdded(EdgeType indexed edgeType, Ref target);
    event EdgeAcknowledged(EdgeType indexed edgeType, Ref source, bool ack);

    function addEdge(EdgeType edgeType, Ref calldata target) external;

    function edges() external view returns (Edge[] memory);

    /// @notice B acknowledges (ack=true) or revokes an inbound edge claimed by
    ///         `source` (A), making the A->B relationship verifiable as mutual.
    function acknowledgeEdge(EdgeType edgeType, Ref calldata source, bool ack) external;

    function isEdgeAcknowledged(EdgeType edgeType, Ref calldata source)
        external
        view
        returns (bool);
}

/// @title ITokenPath
/// @notice Per-token forward pointer (the pointer layer; inert in v1).
interface ITokenPath {
    event PathSet(uint256 indexed tokenId, PathType indexed pathType, Ref target, bytes32 data);
    event DefaultPathSet(PathType indexed pathType, Ref target, bytes32 data);

    function pathOf(uint256 tokenId) external view returns (Path memory);

    function setDefaultPath(PathType pathType, Ref calldata target, bytes32 data) external;

    function setPath(uint256 tokenId, PathType pathType, Ref calldata target, bytes32 data)
        external;
}

/// @title ISovereignCollection
/// @notice One artist collection: an OZ ERC721 deployed as an immutable
///         EIP-1167 clone. The core holds ownership, money paths, and
///         provenance (per-token Mint Marks + mint-time entropy); all
///         variability lives in four slots (renderer, price strategy, mint
///         hook, extension minters) and optional companion contracts.
///         Honest fixed pricing with a fixed built-in Surface Share; no
///         other protocol fee. There is no upgrade path and no seal: what
///         deploys is what runs, forever.
interface ISovereignCollection is IMintMarks, ICollectionGraph, ITokenPath {
    // ── errors ──────────────────────────────────────────────────────────────
    error OwnerRequired();
    error RendererRequired();
    error RoyaltyTooHigh();
    error BadMintWindow();
    error ZeroMinter();
    error ZeroQuantity();
    error MintNotStarted();
    error MintEnded();
    /// @notice Built-in paid mints are sequential-mode sales; pooled
    ///         collections sell exclusively through their authorized minter.
    error PooledSellsViaMinter();
    error WrongPayment();
    error Underpayment();
    error NotMinter();
    error PooledNeedsMintToAt();
    error SequentialAssignsIds();
    error ExceedsCap();
    error HookRejected();
    error NotAuthorized();
    error ZeroAccount();
    error NothingToWithdraw();
    error WithdrawFailed();
    error NoStrayETH();
    error RescueFailed();
    error MetadataIsFrozen();
    error NotMinted();
    error LengthMismatch();
    error AlreadyFrozen();
    error WorkAlreadyLocked();
    error NeverMinted();
    error RenounceDisabled();
    error AlreadyAdmin();
    error NotAnAdmin();

    // ── events ──────────────────────────────────────────────────────────────
    event CollectionConfigured(
        CollectionKind kind,
        IdMode idMode,
        uint256 price,
        uint256 supplyCap,
        uint64 mintStart,
        uint64 mintEnd,
        string artworkURI
    );

    /// @notice One event per mint call. Built-in paths cover
    ///         [firstTokenId, firstTokenId + quantity - 1]; extension mints
    ///         emit quantity 1 with firstTokenId = the minted id.
    ///         firstMintIndex is the global mint order of the call's first
    ///         token (token k's mintIndex = firstMintIndex + k), carried in
    ///         the event so indexers never need per-token mintMarkOf reads,
    ///         including for pooled re-mints where order is not derivable
    ///         from ids.
    event Minted(
        address indexed to,
        address indexed surface,
        uint256 firstTokenId,
        uint256 quantity,
        uint256 firstMintIndex,
        uint48 mintBlock,
        CollectionStatus statusAtMint
    );

    event Burned(uint256 indexed tokenId);
    event SurfacePaid(address indexed surface, uint256 amount);
    event ClosingSet(bool closing);
    event RendererSet(address indexed renderer);
    event MintHookSet(address indexed hook);
    event PriceStrategySet(address indexed strategy);
    event MinterSet(address indexed minter, bool allowed);
    event AdminSet(address indexed account, bool allowed);
    event TokenArtworkSet(uint256 indexed tokenId, string cid);
    event WorkSet(bytes32 codeHash);
    event WorkLocked();
    event Withdrawn(address indexed account, uint256 amount);
    event PayoutAddressSet(address indexed payoutAddress);
    event MetadataFrozen();
    event StrayETHRescued(address indexed to, uint256 amount);

    // ── init + config (owner) ────────────────────────────────────────────────
    /// @notice One-shot init. `p.initialMinters` grants extension minters so
    ///         pooled and backed forms deploy fully wired in one transaction.
    ///         `p.artists` is written BY the collection to the Attribution
    ///         singleton during init (the singleton authorizes the collection
    ///         itself; a factory could not pass that check after ownership is
    ///         set); each artist completes the handshake by claiming the
    ///         collection in their own Catalog.
    function initialize(InitParams calldata p) external;

    function setClosing(bool closing) external;
    function setRenderer(address renderer) external;
    function setMintHook(address hook) external;
    function setPriceStrategy(address strategy) external;
    /// @notice Grant or revoke an extension minter. Explicit, per-minter,
    ///         evented: authorizing a minter is the artist's visible, onchain
    ///         choice.
    function setMinter(address minter, bool allowed) external;
    /// @notice Grant an admin. An admin can call every management function the
    ///         owner can, except managing admins (addAdmin/removeAdmin) and
    ///         transferring ownership. Owner-only; reverts AlreadyAdmin if the
    ///         account is already an admin, ZeroAccount for the zero address.
    function addAdmin(address account) external;
    /// @notice Revoke an admin. Owner-only; reverts NotAnAdmin if the account
    ///         is not currently an admin.
    function removeAdmin(address account) external;
    function setTokenArtwork(uint256 tokenId, string calldata cid) external;
    function setTokenArtworkBatch(uint256[] calldata tokenIds, string[] calldata cids) external;
    function setPayoutAddress(address payoutAddress) external;
    function freezeMetadata() external;
    /// @notice Replace the work definition (the algorithm the renderer runs). Allowed until
    ///         `lockWork`; reverts once locked.
    function setWork(WorkConfig calldata work) external;
    /// @notice Permanently lock the work config, so it can never change again. Irreversible.
    function lockWork() external;

    // ── mint: built-in paid paths (value custody stays in the core) ─────────
    /// @notice Simple mint: surface defaults to address(0) so the artist gets
    ///         the full price (no surface share). The honest default path.
    function mint(uint256 quantity) external payable;

    /// @notice Mint crediting a surface its share. PND's frontend passes PND's
    ///         address; a self-hosted page passes the artist's address;
    ///         address(0) folds the share back to the artist. `hookData` is
    ///         forwarded to the mint hook (if any).
    function mintWithRewards(uint256 quantity, address surface, bytes calldata hookData)
        external
        payable;

    // ── mint: extension path (economics live in the authorized minter) ──────
    /// @notice Sequential mode only. Non-payable; the calling minter carries
    ///         all value handling. Hooks run. Returns the assigned id.
    function mintTo(address to, address surface, bytes calldata hookData)
        external
        returns (uint256 tokenId);

    /// @notice Pooled mode only: the minter supplies the id (tokenId ==
    ///         sourceId forms). A previously burned id mints again as a new
    ///         instance with fresh mark and entropy. Hooks run.
    function mintToAt(address to, uint256 tokenId, address surface, bytes calldata hookData)
        external;

    /// @notice Burn by owner or approved (vaults redeem through approval).
    function burn(uint256 tokenId) external;

    // ── withdrawals (pull payments) ──────────────────────────────────────────
    /// @notice Withdraw the pull-payment balance owed to `account`, to `account`.
    function withdraw(address account) external;

    function pendingWithdrawal(address account) external view returns (uint256);

    /// @notice Owner-only sweep of ETH not owed to any payee (force-fed stray ETH).
    function rescueStrayETH(address to) external;

    // ── reads ───────────────────────────────────────────────────────────────
    function config()
        external
        view
        returns (CollectionConfig memory cfg, CollectionStatus status, uint256 minted);

    /// @notice The fixed protocol surface-share, in bps (constant).
    function surfaceShareBps() external view returns (uint16);

    /// @notice Resolved price for a prospective mint: the strategy if set,
    ///         else the stored fixed price times quantity.
    function currentPrice(address minter, uint256 quantity, bytes calldata data)
        external
        view
        returns (uint256);

    /// @notice Mint-time entropy, stamped per token in the mint transaction.
    function tokenSeed(uint256 tokenId) external view returns (bytes32);

    function workConfig() external view returns (WorkConfig memory);
    function isWorkLocked() external view returns (bool);
    function idMode() external view returns (IdMode);
    function artwork() external view returns (string memory);
    function tokenArtwork(uint256 tokenId) external view returns (string memory);
    function renderer() external view returns (address);
    function mintHook() external view returns (address);
    function priceStrategy() external view returns (address);
    function isMinter(address minter) external view returns (bool);
    /// @notice Whether `account` holds an explicit admin grant (owner is an
    ///         implicit admin and need not appear here).
    function isAdmin(address account) external view returns (bool);
    function isMetadataFrozen() external view returns (bool);
    /// @notice metadataFrozen && workLocked: the art-permanence guarantee.
    ///         (The contract itself is immutable from deploy.)
    function isPermanent() external view returns (bool);
}
