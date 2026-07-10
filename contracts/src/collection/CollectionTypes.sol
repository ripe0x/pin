// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// Collection — shared types
//
// One OZ ERC721 contract == one collection. A collection is a fixed-price
// edition, a generative collection, or a backed/pooled work depending on which
// modules fill its slots; the core stores ownership, money paths, and the
// per-token seed only. ALL presentation data (work config, cover art,
// captures) lives in renderer-land (WorkTypes.sol / RenderAssets.sol): the
// core's tokenURI defers wholly to the renderer slot, optionally pinned
// forever with lockRenderer(). Relationship/graph semantics live in companion contracts
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

/// @notice The live collection configuration. Set at init and — except
///         idMode, which is structural — updatable afterward via the setters
///         (window, price, cap, royalty, payout, and the three module slots),
///         so this struct is always the single current truth that config()
///         reports. There is no referrer-share field: the share is a fixed
///         protocol constant (REFERRAL_SHARE_BPS) paid to whoever hosts the
///         mint.
struct CollectionConfig {
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
    address defaultRenderer;
    address[] initialMinters; // extension minters granted at init
    address catalog; // Catalog singleton the collection reads for creator confirmation; 0 = none
    address[] creators; // initial listed creators (owner's side of attribution); confirmed via Catalog
}
