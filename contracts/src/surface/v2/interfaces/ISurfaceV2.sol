// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceConfig, IdMode} from "../../SurfaceTypes.sol";

/// @notice All parameters SurfaceV2.initialize() needs, in one struct, so the
///         call stays within legacy-codegen stack limits and can grow without
///         changing the signature. Same shape as v1 InitParams plus
///         `seedSource`, which v1 has no field for.
struct InitParamsV2 {
    string name;
    string symbol;
    address owner;
    SurfaceConfig cfg;
    address defaultRenderer; // used when cfg.renderer is 0; init reverts RendererRequired if both are 0
    address[] initialMinters; // extension minters granted at init
    address primaryMinter; // discovery default; 0 = none. Must be one of initialMinters.
    address catalog; // Catalog singleton read for creator confirmation; 0 = none
    address[] creators; // the owner's side of attribution; each confirms via Catalog
    address seedSource; // external seed fallback; 0 = disabled. Init-only, no setter.
}

/// @title ISurfaceV2
/// @notice Interface of the sequential-only SurfaceV2 collection: an
///         OpenZeppelin ERC721 deployed as an immutable EIP-1167 clone. It
///         holds no value and runs no sale logic, and assigns token ids in
///         mint order (1, 2, 3, ...), never reused after a burn. The renderer
///         and the minter set are the swappable module slots; royalty, supply
///         cap, primary minter, creators, and admins are owner- or
///         admin-mutable config, each with a one-way lock. seal() engages
///         every remaining lock and renounces ownership in one call.
interface ISurfaceV2 {
    // ── errors ──────────────────────────────────────────────────────────────
    error OwnerRequired();
    error RendererRequired();
    error RendererNotContract(address renderer);
    error SeedSourceNotContract(address seedSource);
    error NotAContract(address account);
    error RoyaltyTooHigh();
    error ZeroMinter();
    error ZeroQuantity();
    error NotMinter();
    error ExceedsCap(uint256 cap, uint256 attempted);
    error NotAuthorized();
    error ZeroAccount();
    error NoStrayETH();
    error RescueFailed();
    error NeverMinted();
    error AlreadyAdmin();
    error NotAnAdmin();
    error BadSupplyCap(uint256 floor, uint256 requested);
    error SupplyIsLocked();
    error RendererIsLocked();
    error MinterIsLocked();
    error PrimaryMinterNotAuthorized();
    /// @dev setRoyalty and lockRoyalty both revert this once the royalty is
    ///      locked.
    error RoyaltyIsLocked();
    /// @dev _update rejects any transfer or mint landing a token at the
    ///      collection's own address: a token there can never be moved again.
    error SelfCustodyRejected(uint256 tokenId);

    // ── events ──────────────────────────────────────────────────────────────
    event SurfaceConfigured(IdMode idMode, uint256 supplyCap);

    // ── ERC-4906 (metadata refresh signals for marketplaces) ────────────────
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    // ── ERC-7572 (contract-level metadata refresh signal) ───────────────────
    event ContractURIUpdated();

    /// @notice Emitted once per mint call; the per-mint record. Covers
    ///         [firstTokenId, firstTokenId + quantity - 1]. firstMintIndex
    ///         equals firstTokenId (kept as a separate field for indexer ABI
    ///         stability with v1). minter is the calling minter (msg.sender).
    event Minted(
        address indexed minter, address indexed to, uint256 firstTokenId, uint256 quantity, uint256 firstMintIndex
    );

    event Burned(uint256 indexed tokenId);
    event RoyaltySet(uint16 royaltyBps, address indexed royaltyReceiver);
    event SupplyCapSet(uint256 supplyCap);
    event SupplyLocked();
    event RendererLocked();
    event MinterLocked();
    /// @notice One-way: engaged by lockRoyalty() or by seal().
    event RoyaltyLocked();
    event CreatorListed(address indexed creator, bool listed);
    event RendererSet(address indexed renderer);
    event MinterSet(address indexed minter, bool allowed);
    event PrimaryMinterSet(address indexed minter);
    event AdminSet(address indexed account, bool allowed);
    event StrayETHRescued(address indexed to, uint256 amount);

    // ── init + config ────────────────────────────────────────────────────────
    /// @notice One-shot initializer. `p.initialMinters` grants extension
    ///         minters and `p.creators` seeds the owner's side of
    ///         attribution, so a collection deploys fully configured in one
    ///         transaction. rendererLocked/supplyLocked set true in `p.cfg`
    ///         take effect here; the minter set has no initialize-time lock
    ///         and is frozen afterward by the separate lockMinter() call.
    ///         `p.seedSource` is stored once and has no setter.
    function initialize(InitParamsV2 calldata p) external;

    /// @notice Updates the EIP-2981 royalty. Capped at 50%; receiver 0 =
    ///         owner(). Reverts once lockRoyalty() has engaged.
    function setRoyalty(uint16 royaltyBps, address royaltyReceiver) external;
    /// @notice Updates the supply cap (0 = open supply). Reverts once locked,
    ///         or when set below mints-ever.
    function setSupplyCap(uint256 supplyCap) external;
    /// @notice One-way: locks the supply cap permanently. The cap binds every
    ///         mint path, so no later minter grant can exceed it.
    function lockSupply() external;
    /// @notice Points tokenURI at a new renderer. Reverts once locked; the
    ///         renderer cannot be the zero address.
    function setRenderer(address renderer) external;
    /// @notice Grants or revokes an extension minter. Reverts once the
    ///         minter set is locked.
    function setMinter(address minter, bool allowed) external;
    /// @notice One-way, optional. Freezes the list of authorized minters:
    ///         setMinter always reverts afterward. The lock does not stop
    ///         minting: every minter granted before the lock keeps its
    ///         authority. Locking with no minter granted leaves the
    ///         collection permanently unable to mint.
    function lockMinter() external;
    /// @notice Points the frontend-discovery default at `minter` (must be a
    ///         currently granted minter, or the zero address to clear it).
    ///         Reverts once the minter set is locked.
    function setPrimaryMinter(address minter) external;
    /// @notice Grants an admin. An admin can call every management function
    ///         the owner can, except managing admins and transferring
    ///         ownership. Owner-only; reverts AlreadyAdmin / ZeroAccount.
    function addAdmin(address account) external;
    /// @notice Revokes an admin. The owner may remove anyone; an admin may
    ///         renounce itself. Reverts NotAnAdmin when there is no grant to
    ///         remove.
    function removeAdmin(address account) external;
    /// @notice Owner's side of attribution: lists or unlists creators. A
    ///         listing is an assertion; confirmation also requires the
    ///         creator to register this collection in the Catalog
    ///         (isConfirmedCreator).
    function setCreators(address[] calldata list, bool listed) external;
    /// @notice Emits an ERC-4906 refresh for changes the core cannot observe
    ///         (an on-chain-live work whose output changed, a reveal, new
    ///         captures). Callable by the current renderer or owner/admin.
    ///         Works after lockRenderer, which pins the renderer pointer,
    ///         not its output.
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external;
    /// @notice One-way, optional: pins the renderer pointer permanently. An
    ///         immutable renderer behind a locked pointer gives full
    ///         presentation permanence; a mutable renderer behind a locked
    ///         pointer remains changeable within that renderer.
    function lockRenderer() external;
    /// @notice One-way, optional: locks the royalty (bps and receiver)
    ///         permanently. Reverts RoyaltyIsLocked once engaged.
    function lockRoyalty() external;
    /// @notice Owner-only, one transaction: engages every un-engaged lock
    ///         (renderer, supply, minter, royalty), then renounces
    ///         ownership. Sealing with zero granted minters permanently ends
    ///         minting.
    function seal() external;

    // ── mint ─────────────────────────────────────────────────────────────────
    /// @notice Authorized minters only. Non-payable; the calling minter
    ///         handles all economics. Mints `quantity` tokens with ids
    ///         `firstTokenId .. firstTokenId + quantity - 1`, deriving each
    ///         token's seed. One call, one Minted event. Reverts
    ///         ZeroQuantity on a zero quantity.
    function mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId);
    /// @notice Authorized minters only. Same id assignment as mintTo, but
    ///         the caller supplies each token's seed: `seeds.length` is the
    ///         quantity, and a zero entry derives the default seed for that
    ///         token instead. A nonzero entry is stored and takes precedence
    ///         over `seedSource` for that token.
    function mintToSeeded(address to, bytes32[] calldata seeds) external returns (uint256 firstTokenId);

    // ── burn ─────────────────────────────────────────────────────────────────
    /// @notice Burns a token. Authorized for the token holder or an address
    ///         the holder approved.
    function burn(uint256 tokenId) external;

    /// @notice Owner-or-admin sweep of the full ETH balance. No function of
    ///         the collection receives ETH, so any balance arrived by force
    ///         (selfdestruct, pre-funded address) and is owed to no one.
    function rescueStrayETH(address to) external;

    // ── reads ───────────────────────────────────────────────────────────────
    function config() external view returns (SurfaceConfig memory cfg, uint256 minted);

    /// @notice Mint-time entropy for `tokenId`. Reverts NeverMinted for
    ///         `tokenId == 0 || tokenId > mints-ever`. Falls back to
    ///         `seedSource` when no seed is stored for an in-range id.
    function tokenSeed(uint256 tokenId) external view returns (bytes32);

    /// @notice Compat shim for renderers built against v1's ISurfaceView:
    ///         always Sequential. Not a mutable setting.
    function idMode() external view returns (IdMode);
    function renderer() external view returns (address);
    function isMinter(address minter) external view returns (bool);
    /// @notice Frontend-discovery default: the minter a generic client
    ///         should read/call first. Not proof that no other authorized
    ///         minter exists; every granted minter in isMinter is equally
    ///         callable.
    function primaryMinter() external view returns (address);
    /// @notice Whether `account` may call the admin-gated setters: the
    ///         owner, or any address holding an explicit grant.
    function isAdmin(address account) external view returns (bool);
    function isRendererLocked() external view returns (bool);
    function isSupplyLocked() external view returns (bool);
    /// @notice Whether the minter set is frozen (see lockMinter).
    function isMinterLocked() external view returns (bool);
    /// @notice Whether the royalty is frozen (see lockRoyalty).
    function isRoyaltyLocked() external view returns (bool);
    /// @notice Whether the owner has listed `who` as a creator (one side).
    function isListedCreator(address who) external view returns (bool);
    /// @notice Mutual attribution: the owner listed `who` AND `who`
    ///         registered this collection in the Catalog. Either side can
    ///         retract, which removes the confirmation. False when no
    ///         Catalog is set.
    function isConfirmedCreator(address who) external view returns (bool);
    /// @notice The Catalog singleton creators are confirmed against (0 =
    ///         disabled).
    function catalog() external view returns (address);
    /// @notice External seed fallback for tokens with no stored seed (0 =
    ///         disabled). Set once at init; no setter.
    function seedSource() external view returns (address);
    /// @notice Snapshot of every one-way lock plus renounce state, in one
    ///         call. `sealed_` is `owner() == address(0)`; `version_` is the
    ///         implementation version.
    function permanence()
        external
        view
        returns (
            bool rendererLocked,
            bool supplyLocked,
            bool minterLocked,
            bool royaltyLocked,
            bool sealed_,
            uint256 version_
        );
}
