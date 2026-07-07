// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// Sovereign Collection — shared types
//
// One OZ ERC721 contract == one collection. A collection is a fixed-price
// edition, a generative collection, or a backed/pooled work depending on which
// modules fill its slots; the core stores ownership, money paths, and
// provenance only.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev How a Ref's `id` is interpreted.
enum RefKind {
    Collection, // contractAddress is a collection; id is ignored (or 0)
    Token, // id is a tokenId on contractAddress
    External // id is interpreted by contractAddress's own scheme
}

/// @notice A globally addressable node in the Collection Graph / Token Path.
struct Ref {
    uint64 chainId; // 1 = Ethereum mainnet
    address contractAddress; // a collection, or any contract
    uint256 id; // tokenId per `kind` (0 for a collection node)
    RefKind kind;
}

/// @notice Semantic role of a collection, used by the Collection Graph.
///         Default Standalone. Not surfaced in the basic create flow.
enum CollectionKind {
    Standalone,
    Study,
    Phase,
    Access,
    Source,
    Continuation
}

/// @notice Lifecycle snapshot captured into each Mint Mark.
enum CollectionStatus {
    Open, // within window and under cap
    Closing, // artist flagged it as closing soon
    Closed // window ended or cap reached
}

/// @notice Token id assignment model, fixed at init.
///         Sequential: the core assigns nextId++; extension minters may mint
///         but never choose ids; ids are never reused after burn.
///         Pooled: an authorized extension minter supplies every id
///         (tokenId == sourceId forms); a burned id may be minted again as a
///         new instance with fresh mark and entropy.
enum IdMode {
    Sequential,
    Pooled
}

/// @notice What a faithful render requires. Declared, not enforced: the
///         honest-preservation label the renderer, capture tooling, and
///         archives read.
enum Liveness {
    Pure, // seed only; archival-deterministic
    ChainLive, // reads declared onchain state at render time
    ExternalLive // reads declared offchain sources; fragile by nature
}

/// @notice Collection Graph edge type.
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

/// @notice A typed, directed edge from this collection to another node.
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

/// @notice How a stored file must be emitted into the assembled HTML.
///         Script = plain JS; ScriptGzip = gzipped JS (the renderer loads a
///         gunzip helper and emits it as a gzip data-URI script tag).
enum CodeKind {
    Script,
    ScriptGzip
}

/// @notice An onchain-addressable file: a named entry in a scripty v2
///         storage contract or an EthFS FileStore.
struct CodeRef {
    address store;
    string name;
    CodeKind kind;
}

/// @notice What the work is, executably. Interpreted by renderers, stored and
///         lockable on the collection. Empty for works whose renderer contract
///         IS the algorithm (Solidity SVG works).
struct WorkConfig {
    CodeRef[] code; // the algorithm, chunked/named in onchain storage
    CodeRef[] deps; // library files (gzipped p5/three/etc.)
    string codeURI; // offchain pointer for oversized code; hash-verified
    bytes32 codeHash; // integrity hash of the assembled script ("" refs ok)
    Liveness liveness;
    uint8 injectionVersion; // version of the render-context injection convention
    string renderParams; // renderer-interpreted settings (aspect, versions)
}

/// @notice The artist-supplied collection configuration, set at init. There is
///         no surface-share field: the share is a fixed protocol constant
///         (SURFACE_SHARE_BPS) paid to whoever hosts the mint.
struct CollectionConfig {
    string artworkURI; // shared/cover art; per-token overridable
    uint256 price; // wei; used when priceStrategy is unset. 0 = gas only
    uint256 supplyCap; // 0 = open supply
    uint64 mintStart; // unix seconds; 0 = open immediately
    uint64 mintEnd; // unix seconds; 0 = open-ended
    uint16 royaltyBps; // EIP-2981
    address royaltyReceiver; // 0 = owner()
    CollectionKind kind; // graph role; default Standalone
    address payoutAddress; // artist proceeds; 0 = owner()
    address renderer; // 0 = default renderer
    address mintHook; // 0 = none
    address priceStrategy; // 0 = stored price
    IdMode idMode;
}

/// @notice Everything initialize() needs, bundled so the call stays within
///         legacy-codegen stack limits and the signature can grow without
///         churn.
struct InitParams {
    string name;
    string symbol;
    address owner;
    CollectionConfig cfg;
    WorkConfig work;
    address defaultRenderer;
    address[] initialMinters; // extension minters granted at init
    address attribution; // Attribution singleton; 0 skips the roster write
    address[] artists; // collab roster, written by the collection during init
}

/// @notice Per-token mint record, stored packed in a single slot
///         (48 + 40 + 8 + 160 = 256 bits). `mintIndex` is uint40 so the record fills the
///         slot exactly; 2^40 mints is unreachable, so the count never truncates.
struct MintRecord {
    uint48 mintBlock;
    uint40 mintIndex; // 0-based global mint order across the collection
    uint8 statusAtMint; // CollectionStatus
    address surface;
}

/// @notice The derived, public Mint Mark for a single token.
struct MintMark {
    uint40 mintIndex;
    uint48 mintBlock;
    CollectionStatus statusAtMint;
    address surface;
    bool isFirst; // mintIndex == 0
    bool isFinal; // collection Closed && mintIndex == last ever assigned
}
