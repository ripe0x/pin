// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// PND Editions — shared types
//
// One ERC721A contract == one edition. Shared artwork + shared mint
// conditions, but every minted token keeps its own identity (Mint Mark now,
// Token Path later). See docs/pnd-editions-spec.md.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev How a Ref's `id` is interpreted.
enum RefKind {
    Edition, // contractAddress is an edition; id is ignored (or 0)
    Token, // id is a tokenId on contractAddress
    External // id is interpreted by contractAddress's own scheme
}

/// @notice A globally addressable node in the Edition Graph / Token Path.
///         Onchain form of the `pnd:<chain>:<contract>:e|t|x<id>` URN.
struct Ref {
    uint64 chainId; // 1 = Ethereum mainnet
    address contractAddress; // a PNDEditions edition, or any contract
    uint256 id; // tokenId per `kind` (0 for an edition node)
    RefKind kind;
}

/// @notice Semantic role of an edition, used by the Edition Graph. Default
///         Standalone. Not surfaced in the basic create flow.
enum EditionKind {
    Standalone,
    Study,
    Phase,
    Access,
    Source,
    Continuation
}

/// @notice Lifecycle snapshot captured into each Mint Mark.
enum EditionStatus {
    Open, // within window and under cap
    Closing, // artist flagged it as closing soon
    Closed // window ended or cap reached
}

/// @notice Edition Graph edge type.
enum EdgeType {
    BelongsTo,
    StudyOf,
    PhaseOf,
    Continues,
    Source,
    Access
}

/// @notice Token Path pointer type. v1 stores/emits these; it does not
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

/// @notice A typed, directed edge from this edition to another node.
struct Edge {
    EdgeType edgeType;
    Ref target;
}

/// @notice A token's forward pointer.
struct Path {
    PathType pathType;
    Ref target;
    bytes32 data; // optional aux payload
}

/// @notice The artist-supplied edition configuration, set at deploy. There is
///         no surface-share field: the share is a fixed protocol constant
///         (SURFACE_SHARE_BPS) paid to whoever hosts the mint.
struct EditionConfig {
    string artworkURI; // CID-backed shared art; per-token overridable
    uint256 price; // wei. 0 = gas only (never "free")
    uint256 supplyCap; // 0 = open edition
    uint64 mintStart; // unix seconds; 0 = open immediately
    uint64 mintEnd; // unix seconds; 0 = open-ended
    uint16 royaltyBps; // EIP-2981
    address royaltyReceiver; // 0 = owner()
    EditionKind kind; // graph role; default Standalone
    address payoutAddress; // artist proceeds; 0 = owner()
    address renderer; // 0 = default renderer
    address mintHook; // 0 = none
}

/// @notice One record per mint() call (one ERC721A batch), keyed by the batch
///         head tokenId. A token's per-batch fields (block, surface, status)
///         are read from the batch it falls in; its mint order is derived
///         directly from the tokenId.
struct MintBatch {
    uint48 mintBlock;
    uint8 statusAtMint; // EditionStatus
    address surface;
}

/// @notice The derived, public Mint Mark for a single token.
struct MintMark {
    uint32 indexInEdition; // 0-based mint order (tokenId - startTokenId)
    uint48 mintBlock;
    EditionStatus statusAtMint;
    address surface;
    bool isFirst; // indexInEdition == 0
    bool isFinal; // edition Closed && tokenId == last minted
}
