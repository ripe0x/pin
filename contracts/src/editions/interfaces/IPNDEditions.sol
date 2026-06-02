// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {
    ReleaseConfig,
    ReleaseStatus,
    ReleaseKind,
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

/// @title IPNDReleaseGraph
/// @notice Directed, typed, append-only edges from a release to any node.
interface IPNDReleaseGraph {
    event EdgeAdded(uint256 indexed releaseId, EdgeType indexed edgeType, Ref target);

    function addEdge(uint256 releaseId, EdgeType edgeType, Ref calldata target) external;

    function edgesOf(uint256 releaseId) external view returns (Edge[] memory);
}

/// @title IPNDTokenPath
/// @notice Per-token forward pointer (the pointer layer; inert in v1).
interface IPNDTokenPath {
    event PathSet(uint256 indexed tokenId, PathType indexed pathType, Ref target, bytes32 data);
    event ReleaseDefaultPathSet(
        uint256 indexed releaseId, PathType indexed pathType, Ref target, bytes32 data
    );

    function pathOf(uint256 tokenId) external view returns (Path memory);

    function setReleaseDefaultPath(
        uint256 releaseId,
        PathType pathType,
        Ref calldata target,
        bytes32 data
    ) external;

    function setPath(uint256 tokenId, PathType pathType, Ref calldata target, bytes32 data)
        external;
}

/// @title IPNDEditions
/// @notice The per-project ERC721A editions contract.
interface IPNDEditions is IPNDMintMarks, IPNDReleaseGraph, IPNDTokenPath {
    // ── events ──────────────────────────────────────────────────────────────
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

    /// @notice One event per mint() call (one ERC721A batch). Covers
    ///         [firstTokenId, firstTokenId + quantity - 1].
    event Minted(
        uint256 indexed releaseId,
        address indexed to,
        address indexed surface,
        uint256 firstTokenId,
        uint256 quantity,
        uint32 startIndexInRelease,
        uint48 mintBlock,
        ReleaseStatus statusAtMint
    );

    event SurfacePaid(uint256 indexed releaseId, address indexed surface, uint256 amount);
    event ReleaseClosingSet(uint256 indexed releaseId, bool closing);
    event ProjectRendererSet(address renderer);
    event ReleaseRendererSet(uint256 indexed releaseId, address renderer);
    event ProjectMintHookSet(address hook);
    event ReleaseMintHookSet(uint256 indexed releaseId, address hook);
    event TokenArtworkSet(uint256 indexed tokenId, string cid);
    event Sealed();

    // ── lifecycle / config (owner) ────────────────────────────────────────────
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address owner_,
        bool upgradeable_,
        address defaultRenderer_
    ) external;

    function createRelease(ReleaseConfig calldata cfg) external returns (uint256 releaseId);

    function setClosing(uint256 releaseId, bool closing) external;

    function setProjectRenderer(address renderer) external;
    function setReleaseRenderer(uint256 releaseId, address renderer) external;
    function setTokenArtwork(uint256 tokenId, string calldata cid) external;
    function setTokenArtworkBatch(uint256[] calldata tokenIds, string[] calldata cids) external;
    function setProjectMintHook(address hook) external;
    function setReleaseMintHook(uint256 releaseId, address hook) external;

    function seal() external;

    // ── mint ──────────────────────────────────────────────────────────────────
    /// @param surface   The mint surface payout address. address(0) folds the
    ///                  surface share back to the artist payout.
    /// @param hookData  Opaque payload forwarded to the mint hook (if any).
    function mint(uint256 releaseId, uint256 quantity, address surface, bytes calldata hookData)
        external
        payable;

    // ── reads ───────────────────────────────────────────────────────────────
    function release(uint256 releaseId)
        external
        view
        returns (ReleaseConfig memory cfg, ReleaseStatus status, uint256 minted);

    function totalReleases() external view returns (uint256);
    function releaseOf(uint256 tokenId) external view returns (uint256);
    function releaseArtwork(uint256 releaseId) external view returns (string memory);
    function tokenArtwork(uint256 tokenId) external view returns (string memory);
    function rendererOf(uint256 releaseId) external view returns (address);
    function mintHookOf(uint256 releaseId) external view returns (address);
    function isUpgradeable() external view returns (bool);
    function isSealed() external view returns (bool);
}
