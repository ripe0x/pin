// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// Surface, shared types
//
// The core stores per-token ownership and one seed per token. tokenURI is
// delegated to the renderer, held in a config slot the owner can change or
// lock. The core does not store or reference the artwork, and holds no sale
// economics: price, mint window, and payment custody live in the minter that
// calls mintTo/mintToId.
// ─────────────────────────────────────────────────────────────────────────────

/// @notice How token ids are assigned. Not a setting; each mode is a separate
///         contract, and idMode() reports which.
///         Sequential (Surface): the contract assigns ids 1, 2, 3, ... in mint
///         order; ids are never reused after a burn.
///         Pooled (PooledSurface): the authorized minter supplies each id
///         under its own scheme (mirroring an external collection's ids is
///         one use). A burned id may be minted again as a new instance with a
///         new seed.
enum IdMode {
    Sequential,
    Pooled
}

/// @notice Live settings in one struct. Setters edit these fields in place, so
///         config() always reports what the contract uses. The two locks are
///         one-way: true never returns to false. A lock passed as true at
///         creation applies from initialization.
struct SurfaceConfig {
    uint256 supplyCap; // 0 = open supply
    uint16 royaltyBps; // EIP-2981, advisory
    address royaltyReceiver; // 0 = owner()
    address renderer; // provides tokenURI; 0 at init = the factory default; reverts RendererRequired when that is also 0
    bool rendererLocked; // one-way; see lockRenderer()
    bool supplyLocked; // one-way; see lockSupply()
}

/// @notice All parameters initialize() needs, in one struct, so the call stays
///         within legacy-codegen stack limits and can grow without changing the
///         signature.
struct InitParams {
    string name;
    string symbol;
    address owner;
    SurfaceConfig cfg;
    address defaultRenderer; // used when cfg.renderer is 0; init reverts RendererRequired if both are 0
    address[] initialMinters; // extension minters granted at init
    address primaryMinter; // discovery default; 0 = none. Must be one of initialMinters.
    address catalog; // Catalog singleton read for creator confirmation; 0 = none
    address[] creators; // the owner's side of attribution; each confirms via Catalog
}
