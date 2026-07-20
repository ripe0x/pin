// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceConfig, IdMode, InitParams} from "../SurfaceTypes.sol";

/// @title ISurfaceCore
/// @notice Shared interface of every collection, regardless of id mode. An
///         OpenZeppelin ERC721 deployed as an immutable EIP-1167 clone: it
///         holds no value and runs no sale logic, and stores one seed per
///         token. The two mutable slots are the renderer and the minter set;
///         there is no upgrade path.
///
///         The mint entrypoints are not declared here. Each id mode is its own
///         contract with its own entrypoints: ISurface (sequential) assigns
///         ids in mint order; IPooledSurface lets its minter choose ids.
interface ISurfaceCore {
    // ── errors ──────────────────────────────────────────────────────────────
    error OwnerRequired();
    error RendererRequired();
    error RendererNotContract(address renderer);
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
    error TooManyMinters();
    error PrimaryMinterNotAuthorized();
    error OnlySequential();

    // ── events ──────────────────────────────────────────────────────────────
    event SurfaceConfigured(IdMode idMode, uint256 supplyCap);

    // ── ERC-4906 (metadata refresh signals for marketplaces) ────────────────
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    // ── ERC-7572 (contract-level metadata refresh signal) ───────────────────
    event ContractURIUpdated();

    /// @notice Emitted once per mint call; the per-mint record. Sequential
    ///         mints cover [firstTokenId, firstTokenId + quantity - 1]; pooled
    ///         mints are always quantity 1. firstMintIndex is the global mint
    ///         order of the call's first token (token k's index =
    ///         firstMintIndex + k), included because pooled ids do not encode
    ///         it. minter is the calling minter (msg.sender), which minted
    ///         this token; it gives cross-minter attribution without trace
    ///         lookups. The mint block is the log's own block. No per-token
    ///         data is stored beyond the seed; indexers read the rest from the
    ///         log.
    event Minted(
        address indexed minter, address indexed to, uint256 firstTokenId, uint256 quantity, uint256 firstMintIndex
    );

    event Burned(uint256 indexed tokenId);
    event RoyaltySet(uint16 royaltyBps, address indexed royaltyReceiver);
    event SupplyCapSet(uint256 supplyCap);
    event SupplyLocked();
    event RendererLocked();
    event MinterLocked();
    event CreatorListed(address indexed creator, bool listed);
    event RendererSet(address indexed renderer);
    event MinterSet(address indexed minter, bool allowed);
    event PrimaryMinterSet(address indexed minter);
    event AdminSet(address indexed account, bool allowed);
    event StrayETHRescued(address indexed to, uint256 amount);

    // ── init + config ────────────────────────────────────────────────────────
    /// @notice One-shot initializer. `p.initialMinters` grants extension
    ///         minters and `p.creators` seeds the owner's side of attribution,
    ///         so pooled, backed, and collaborative forms deploy fully
    ///         configured in one transaction. rendererLocked/supplyLocked set
    ///         true in `p.cfg` take effect here; the minter set has no
    ///         initialize-time lock and is frozen afterward by the separate
    ///         lockMinter() call.
    function initialize(InitParams calldata p) external;

    /// @notice Updates the EIP-2981 royalty. Capped at 50%; receiver 0 =
    ///         owner().
    function setRoyalty(uint16 royaltyBps, address royaltyReceiver) external;
    /// @notice Updates the supply cap (0 = open supply). Reverts once locked,
    ///         or when set below current supply (mints-ever in sequential
    ///         mode, live supply in pooled).
    function setSupplyCap(uint256 supplyCap) external;
    /// @notice One-way: locks the supply cap permanently. The cap binds every
    ///         mint path, so no later minter grant can exceed it.
    function lockSupply() external;
    /// @notice Points tokenURI at a new renderer. Reverts once locked; the
    ///         renderer cannot be the zero address.
    function setRenderer(address renderer) external;
    /// @notice Grants or revokes an extension minter. Reverts once the minter
    ///         set is locked; the pooled form allows one minter at a time.
    function setMinter(address minter, bool allowed) external;
    /// @notice One-way, optional: freezes the minter set permanently. A backed
    ///         pooled collection sets this so no minter can be swapped in later
    ///         to burn another minter's backed tokens.
    function lockMinter() external;
    /// @notice Sequential-only: point the frontend-discovery default at
    ///         `minter` (must be a currently granted minter, or the zero
    ///         address to clear it). Reverts OnlySequential on a pooled
    ///         collection, whose primary follows its sole minter automatically;
    ///         reverts once the minter set is locked.
    function setPrimaryMinter(address minter) external;
    /// @notice Grants an admin. An admin can call every management function the
    ///         owner can, except managing admins and transferring ownership.
    ///         Owner-only; reverts AlreadyAdmin / ZeroAccount.
    function addAdmin(address account) external;
    /// @notice Revokes an admin. The owner may remove anyone; an admin may
    ///         renounce itself. Reverts NotAnAdmin when there is no grant to
    ///         remove.
    function removeAdmin(address account) external;
    /// @notice Owner's side of attribution: lists or unlists creators. A
    ///         listing is an assertion; confirmation also requires the creator
    ///         to register this collection in the Catalog (isConfirmedCreator).
    function setCreators(address[] calldata list, bool listed) external;
    /// @notice Emits an ERC-4906 refresh for changes the core cannot observe
    ///         (a chain-live work moving, a reveal, new captures). Callable by
    ///         the current renderer or owner/admin. Works after lockRenderer,
    ///         which pins the renderer pointer, not its output.
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external;
    /// @notice One-way, optional: pins the renderer pointer permanently. An
    ///         immutable renderer behind a locked pointer is full presentation
    ///         permanence; a mutable renderer behind a locked pointer is an
    ///         explicit, inspectable choice.
    function lockRenderer() external;

    // ── burn ─────────────────────────────────────────────────────────────────
    /// @notice Burns a token. Authorization depends on the form: sequential
    ///         collections use the standard owner-or-approved rule; pooled
    ///         collections restrict burning to authorized minters, which
    ///         control the id pool and any per-token backing.
    function burn(uint256 tokenId) external;

    /// @notice Owner-or-admin sweep of the full ETH balance. The token holds
    ///         no value of its own, so any balance is force-fed (selfdestruct,
    ///         pre-funded address); there is nothing owed to sweep around.
    function rescueStrayETH(address to) external;

    // ── reads ───────────────────────────────────────────────────────────────
    function config() external view returns (SurfaceConfig memory cfg, uint256 minted);

    /// @notice Mint-time entropy, stamped per token in the mint transaction.
    function tokenSeed(uint256 tokenId) external view returns (bytes32);

    /// @notice The collection's id mode. Fixed at deploy, not a mutable
    ///         setting.
    function idMode() external view returns (IdMode);
    function renderer() external view returns (address);
    function isMinter(address minter) external view returns (bool);
    /// @notice Frontend-discovery default: the minter a generic client should
    ///         read/call first. Not proof that no other authorized minter
    ///         exists; every granted minter in isMinter is equally callable.
    ///         Sequential: owner/admin-set via setPrimaryMinter, cleared on
    ///         revoke of the current primary. Pooled: tracks the sole minter
    ///         automatically, 0 when none is granted.
    function primaryMinter() external view returns (address);
    /// @notice Whether `account` may call the admin-gated setters: the owner,
    ///         or any address holding an explicit grant.
    function isAdmin(address account) external view returns (bool);
    function isRendererLocked() external view returns (bool);
    function isSupplyLocked() external view returns (bool);
    /// @notice Whether the minter set is frozen (see lockMinter).
    function isMinterLocked() external view returns (bool);
    /// @notice Whether the owner has listed `who` as a creator (one side).
    function isListedCreator(address who) external view returns (bool);
    /// @notice Mutual attribution: the owner listed `who` AND `who` registered
    ///         this collection in the Catalog. Either side can retract, which
    ///         removes the confirmation. False when no Catalog is set.
    function isConfirmedCreator(address who) external view returns (bool);
    /// @notice The Catalog singleton creators are confirmed against (0 =
    ///         disabled).
    function catalog() external view returns (address);
}
