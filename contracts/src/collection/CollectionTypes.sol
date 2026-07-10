// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// Collection — shared types
//
// One OZ ERC721 contract == one collection. A collection is a fixed-price
// edition, a generative collection, or a backed/pooled work depending on which
// modules fill its slots; the core stores ownership, money paths, and
// provenance only. Relationship/graph semantics live in companion contracts
// (Attribution today; a relationship registry when the graph product ships),
// never in the immutable core.
// ─────────────────────────────────────────────────────────────────────────────

/// @notice Lifecycle status, derived purely from the mint window, the supply
///         cap, and the current block — never from stored mutable state. It is
///         a view/event value only: config() reports it live and each Minted
///         event stamps the value at mint; nothing stores it.
enum CollectionStatus {
    Scheduled, // before mintStart: the public window has not opened yet
    Open, // within the window and under cap
    Closed // window ended, or a sequential cap is full
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

/// @notice The live collection configuration. Set at init and — except
///         idMode, which is structural — updatable afterward via the setters
///         (window, price, cap, royalty, payout, and the three module slots),
///         so this struct is always the single current truth that config()
///         reports. There is no referrer-share field: the share is a fixed
///         protocol constant (REFERRAL_SHARE_BPS) paid to whoever hosts the
///         mint.
struct CollectionConfig {
    string artworkURI; // shared/cover art; per-token overridable
    uint256 price; // wei; used when priceStrategy is unset. 0 = gas only
    uint256 supplyCap; // 0 = open supply; lockable via lockSupply()
    uint64 mintStart; // unix seconds; 0 = open immediately
    uint64 mintEnd; // unix seconds; 0 = open-ended
    uint16 royaltyBps; // EIP-2981
    address royaltyReceiver; // 0 = owner()
    address payoutAddress; // artist proceeds; 0 = owner()
    address renderer; // 0 = default renderer
    address mintHook; // 0 = none
    address priceStrategy; // 0 = stored price
    IdMode idMode; // fixed at init
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

/// @notice Per-token mint record: exactly the facts the onchain renderer must
///         read synchronously (both are injected into the render context), in
///         one packed slot. Everything else about a mint — referrer, lifecycle
///         status — is event-only provenance (`Minted`), reconstructed by
///         indexers, never stored. `mintBlock != 0` doubles as the
///         was-ever-minted sentinel. `mintIndex` is uint40; 2^40 mints is
///         unreachable, so the count never truncates.
struct MintRecord {
    uint48 mintBlock;
    uint40 mintIndex; // 0-based global mint order across the collection
}

/// @notice The derived, public Mint Mark for a single token.
struct MintMark {
    uint40 mintIndex;
    uint48 mintBlock;
    bool isFirst; // mintIndex == 0
    bool isFinal; // collection Closed && mintIndex == last ever assigned
}
