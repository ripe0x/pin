// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {
    EditionConfig,
    EditionStatus,
    EditionKind,
    MintMark,
    Edge,
    EdgeType,
    Path,
    PathType,
    Ref
} from "../PNDEditionsTypes.sol";

/// @title IPNDMintMarks
/// @notice Derived, per-token provenance.
interface IPNDMintMarks {
    function mintMarkOf(uint256 tokenId) external view returns (MintMark memory);
}

/// @title IPNDEditionGraph
/// @notice Directed, typed, append-only edges from this edition to any node.
interface IPNDEditionGraph {
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

/// @title IPNDTokenPath
/// @notice Per-token forward pointer (the pointer layer; inert in v1).
interface IPNDTokenPath {
    event PathSet(uint256 indexed tokenId, PathType indexed pathType, Ref target, bytes32 data);
    event DefaultPathSet(PathType indexed pathType, Ref target, bytes32 data);

    function pathOf(uint256 tokenId) external view returns (Path memory);

    function setDefaultPath(PathType pathType, Ref calldata target, bytes32 data) external;

    function setPath(uint256 tokenId, PathType pathType, Ref calldata target, bytes32 data)
        external;
}

/// @title IPNDEditions
/// @notice One artist edition: an ERC721A contract with shared artwork +
///         shared mint conditions, honest fixed pricing, a fixed built-in
///         Surface Share, per-batch Mint Marks, an Edition Graph, and a
///         per-token Token Path. Always deployed upgradeable (UUPS); the owner
///         can seal() to renounce upgradeability.
interface IPNDEditions is IPNDMintMarks, IPNDEditionGraph, IPNDTokenPath {
    // ── events ──────────────────────────────────────────────────────────────
    event EditionConfigured(
        EditionKind kind,
        uint256 price,
        uint256 supplyCap,
        uint64 mintStart,
        uint64 mintEnd,
        string artworkURI
    );

    /// @notice One event per mint() call (one ERC721A batch). Covers
    ///         [firstTokenId, firstTokenId + quantity - 1].
    event Minted(
        address indexed to,
        address indexed surface,
        uint256 firstTokenId,
        uint256 quantity,
        uint48 mintBlock,
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

    // ── init + config (owner) ────────────────────────────────────────────────
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address owner_,
        EditionConfig calldata cfg,
        address defaultRenderer_
    ) external;

    function setClosing(bool closing) external;
    function setRenderer(address renderer) external;
    function setTokenArtwork(uint256 tokenId, string calldata cid) external;
    function setTokenArtworkBatch(uint256[] calldata tokenIds, string[] calldata cids) external;
    function setMintHook(address hook) external;
    function setPayoutAddress(address payoutAddress) external;
    function freezeMetadata() external;
    function seal() external;

    // ── mint ──────────────────────────────────────────────────────────────────
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

    /// @notice Withdraw the pull-payment balance owed to `account`, to `account`.
    function withdraw(address account) external;

    function pendingWithdrawal(address account) external view returns (uint256);

    /// @notice Owner-only sweep of ETH not owed to any payee (force-fed stray ETH).
    function rescueStrayETH(address to) external;

    // ── reads ───────────────────────────────────────────────────────────────
    function config()
        external
        view
        returns (EditionConfig memory cfg, EditionStatus status, uint256 minted);

    /// @notice The fixed protocol surface-share, in bps (constant).
    function surfaceShareBps() external view returns (uint16);

    function artwork() external view returns (string memory);
    function tokenArtwork(uint256 tokenId) external view returns (string memory);
    function renderer() external view returns (address);
    function mintHook() external view returns (address);
    function isUpgradeable() external view returns (bool);
    function isSealed() external view returns (bool);
    function isMetadataFrozen() external view returns (bool);
    /// @notice sealed && metadataFrozen: the true art-permanence guarantee.
    function isPermanent() external view returns (bool);
}
