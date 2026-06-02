// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// PND Editions — shared types
//
// File-level enums and structs shared by the editions contract, the factory,
// the renderer, and the hook interface. See docs/pnd-editions-spec.md.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev How a Ref's `id` is interpreted.
enum RefKind {
    Release, // id is a releaseId on contractAddress
    Token, // id is a tokenId on contractAddress
    External // id is interpreted by contractAddress's own scheme
}

/// @notice A globally addressable node in the Release Graph / Token Path.
///         (chainId, contractAddress, id, kind) is the onchain form of the
///         canonical `pnd:<chain>:<contract>:r|t|x<id>` URN.
struct Ref {
    uint64 chainId; // 1 = Ethereum mainnet (only value in v1)
    address contractAddress; // a PNDEditions project, or any contract
    uint256 id; // releaseId or tokenId per `kind`
    RefKind kind;
}

/// @notice Semantic role of a release. Lives on the release and is reflected
///         in graph edges. Distinct from lifecycle ReleaseStatus.
enum ReleaseKind {
    Standalone,
    Study,
    Phase,
    Access,
    Source,
    Continuation
}

/// @notice Lifecycle snapshot captured into each Mint Mark.
enum ReleaseStatus {
    Open, // within window and under cap
    Closing, // artist flagged it as closing soon
    Closed // window ended or cap reached
}

/// @notice Deployment mode chosen per project at the factory.
enum ProjectMode {
    ImmutableClone, // EIP-1167 minimal proxy, no upgrade path
    Upgradeable // ERC1967 (UUPS) proxy, owner can upgrade until seal()
}

/// @notice Release Graph edge type.
enum EdgeType {
    BelongsTo,
    StudyOf,
    PhaseOf,
    Continues,
    Source,
    Access
}

/// @notice Token Path pointer type. v1 stores and emits these; it does not
///         execute them.
enum PathType {
    None,
    Continuation,
    Migration,
    Claim,
    Reveal,
    Burn,
    Custom
}

/// @notice A typed, directed edge from a release to another node.
struct Edge {
    EdgeType edgeType;
    Ref target;
}

/// @notice A token's forward pointer.
struct Path {
    PathType pathType;
    Ref target;
    bytes32 data; // optional aux payload, scheme defined by pathType/Custom
}

/// @notice Artist-supplied release configuration (input to createRelease and
///         the stored shape).
struct ReleaseConfig {
    string defaultArtworkURI; // CID-backed shared art; per-token overridable
    uint256 price; // wei. 0 = gas only (never "free")
    uint16 surfaceShareBps; // 0..10000, share of price routed to the surface
    uint256 supplyCap; // 0 = open edition
    uint64 mintStart; // unix seconds; 0 = open immediately
    uint64 mintEnd; // unix seconds; 0 = open-ended
    uint16 royaltyBps; // EIP-2981
    address royaltyReceiver; // 0 = owner()
    ReleaseKind kind;
    address payoutAddress; // artist proceeds; 0 = owner()
    address renderer; // 0 = inherit project renderer
    address mintHook; // 0 = inherit project hook (or none)
}

/// @notice One record per mint() call (one ERC721A batch). Keyed by the batch
///         head tokenId. A token's Mint Mark is derived from the batch it
///         falls in — see PNDEditions.mintMarkOf.
struct MintBatch {
    uint32 releaseId;
    uint32 startIndexInRelease; // indexInRelease of the head token
    uint48 mintBlock; // block.number at mint
    uint8 statusAtMint; // ReleaseStatus
    address surface; // the mint surface that facilitated entry
}

/// @notice The derived, public Mint Mark for a single token.
struct MintMark {
    uint32 releaseId;
    uint32 indexInRelease; // 0-based mint order within the release
    uint48 mintBlock;
    ReleaseStatus statusAtMint;
    address surface;
    bool isFirst; // indexInRelease == 0
    bool isFinal; // release Closed && tokenId == last minted of the release
}
