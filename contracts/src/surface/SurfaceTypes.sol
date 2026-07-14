// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// Surface — shared types
//
// One contract is one collection. The core keeps three things: who owns each
// token, where the money goes, and one seed per token. How the work looks is
// the renderer's business, and the renderer sits in a slot the artist can
// swap or pin. The core never learns what the art is. It doesn't need to.
// ─────────────────────────────────────────────────────────────────────────────

/// @notice Where the mint stands, worked out fresh from the window, the cap,
///         and the clock. Never stored. config() reports it live and each
///         Minted event stamps the value it saw.
enum SurfaceStatus {
    Scheduled, // the window has not opened yet
    Open, // minting now
    Closed // the window passed, or a sequential cap filled
}

/// @notice How token ids are handed out. Not a setting — each mode is its own
///         contract, and idMode() says which one you are holding.
///         Sequential (Surface): the contract counts 1, 2, 3. The id IS
///         the mint order, and ids are never reused after a burn.
///         Pooled (PooledSurface): an authorized minter chooses each id
///         (tokenId == sourceId forms). A burned id may mint again as a new
///         instance, new seed.
enum IdMode {
    Sequential,
    Pooled
}

/// @notice The live settings, all in one struct. Setters edit these fields in
///         place, so config() always reports exactly what the contract uses.
///         The two locks are one-way: true never goes back to false. Passed
///         true at creation, the collection is born locked — permanence with
///         no second transaction to remember.
struct SurfaceConfig {
    uint256 price; // wei; used when priceStrategy is unset. 0 = gas only
    uint256 supplyCap; // 0 = open supply
    uint64 mintStart; // unix seconds; 0 = open immediately
    uint64 mintEnd; // unix seconds; 0 = open-ended
    uint16 royaltyBps; // EIP-2981, advisory
    address royaltyReceiver; // 0 = owner()
    address payoutAddress; // artist proceeds; 0 = owner()
    address renderer; // answers tokenURI; 0 at init = take the factory default
    address mintHook; // 0 = none
    address priceStrategy; // 0 = the stored fixed price
    bool rendererLocked; // one-way; see lockRenderer()
    bool supplyLocked; // one-way; see lockSupply()
}

/// @notice Everything initialize() needs, in one bundle. A struct so the call
///         stays within legacy-codegen stack limits and can grow without
///         churning the signature.
struct InitParams {
    string name;
    string symbol;
    address owner;
    SurfaceConfig cfg;
    address defaultRenderer; // used when cfg.renderer is 0
    address[] initialMinters; // extension minters granted at init
    address catalog; // Catalog singleton read for creator confirmation; 0 = none
    address[] creators; // the owner's side of attribution; each confirms via Catalog
}
