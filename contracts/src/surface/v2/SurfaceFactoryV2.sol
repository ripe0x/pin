// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {ISurfaceV2, InitParamsV2} from "./interfaces/ISurfaceV2.sol";
import {SurfaceConfig, IdMode} from "../SurfaceTypes.sol";
import {FixedPriceMinterV2, FixedPriceMinterV2InitParams} from "./minters/FixedPriceMinterV2.sol";

/// @notice Sale-config parameters for the canonical minter clone
///         `createSurface` wires. Matches `FixedPriceMinterV2InitParams`
///         minus `collection`: the factory fills that in with the token
///         clone it creates in the same call, since the caller cannot know
///         that address ahead of time.
struct SaleConfig {
    uint256 price; // wei; exact payment required
    uint64 mintStart; // unix seconds; 0 = open immediately
    uint64 mintEnd; // unix seconds; 0 = open-ended
    address payoutRecipient; // 0 = default to the deploy-time `owner` argument
    uint256 maxMints; // 0 = unlimited; this minter's own sale ceiling
    bytes32 allowlistRoot; // 0 = open
    uint256 walletCap; // 0 = unlimited; per-recipient
}

/// @title SurfaceFactoryV2
/// @notice Deploys SurfaceV2 collections as immutable EIP-1167 clones; each
///         collection's owner controls its renderer, supply cap, royalty,
///         and authorized minters, each lockable permanently.
///
///         `createSurface` (canonical minter) clones the token and a
///         `FixedPriceMinterV2` together and wires them in one transaction.
///         `createSurfaceCustom` (bring-your-own minters) clones only the
///         token and grants whatever minters the caller passes. No proxy
///         admin or upgrade path, and no fee taken here. New behavior ships
///         as new implementations behind a new factory, not by changing a
///         deployed collection or minter.
contract SurfaceFactoryV2 {
    /// @notice The SurfaceV2 implementation every createSurface/
    ///         createSurfaceCustom clone points at.
    address public immutable sequentialImplementation;

    /// @notice The FixedPriceMinterV2 implementation createSurface clones as
    ///         the canonical minter. Not used by createSurfaceCustom, which
    ///         takes its minters from the caller.
    address public immutable minterImplementation;

    /// @notice Renderer assigned to a collection that names none of its own.
    ///         May be zero: with no factory default, a collection that sets no
    ///         renderer reverts RendererRequired at creation, requiring every
    ///         collection to supply its own.
    address public immutable defaultRenderer;

    /// @notice Catalog singleton every clone reads for creator confirmation.
    ///         address(0) disables confirmation.
    address public immutable catalog;

    /// @notice Deployer: the only address that may deprecate this factory, and
    ///         its only power. Has no power over deployed collections.
    address public immutable deployer;

    /// @notice One-way stop for new deploys. Deprecating halts further clones
    ///         and names a successor for integrators, e.g. when an
    ///         implementation is found to have a bug. Deployed collections are
    ///         immutable and unaffected.
    bool public deprecated;
    /// @notice Replacement factory set on deprecation (informational).
    address public successor;

    /// @notice Reversible pause on new deploys, distinct from `deprecated`: a
    ///         temporary off switch (incident, maintenance) the deployer can
    ///         toggle back on. Neither flag affects deployed collections.
    bool public paused;

    mapping(address => bool) public isSurface;
    address[] public allSurfaces;

    /// @notice `primaryMinter` is the canonical FixedPriceMinterV2 clone that
    ///         createSurface wired, or the caller-supplied primary for
    ///         createSurfaceCustom, or address(0) when the caller named none.
    ///         It mirrors the collection's primaryMinter() at creation: the
    ///         default integration endpoint, not the complete authorization
    ///         set. A collection may authorize more minters later. The full
    ///         record is the collection's MinterSet event log plus the live
    ///         isMinter/isMinterLocked views. There is no minterOf storage
    ///         mapping. `name` and `symbol` are the collection's ERC721
    ///         identity, fixed at initialize with no setter, so an indexer
    ///         can record them from log data without a contract read.
    event SurfaceCreated(
        address indexed owner,
        address indexed collection,
        address primaryMinter,
        IdMode idMode,
        string name,
        string symbol
    );
    event Deprecated(address indexed successor);
    event PausedSet(bool paused);

    error FactoryDeprecated();
    error FactoryPaused();
    error NotDeployer();
    error AlreadyDeprecated();
    error NotAContract(address account);
    error OwnerRequired();
    /// @dev Distinct from ISurfaceV2.PrimaryMinterNotAuthorized: the core
    ///      re-checks membership at init regardless of what the factory
    ///      validates here.
    error PrimaryMinterNotAuthorized();

    constructor(
        address sequentialImplementation_,
        address minterImplementation_,
        address defaultRenderer_,
        address catalog_
    ) {
        if (sequentialImplementation_.code.length == 0) {
            revert NotAContract(sequentialImplementation_);
        }
        if (minterImplementation_.code.length == 0) revert NotAContract(minterImplementation_);
        // The default renderer is optional (0 = no factory default): a collection that names
        // no renderer of its own then reverts RendererRequired at creation, requiring every
        // collection to supply its own. A nonzero value must be a contract, same as catalog
        // below, so an EOA/typo cannot silently become the fallback tokenURI for every clone.
        if (defaultRenderer_ != address(0) && defaultRenderer_.code.length == 0) {
            revert NotAContract(defaultRenderer_);
        }
        // Catalog is optional (0 disables creator confirmation), but a nonzero value must be a
        // contract: a mistyped/EOA/wrong-chain address passes silently here and then makes
        // isConfirmedCreator revert on every collection this factory clones, unrecoverable
        // since collections are immutable and there is no setCatalog.
        if (catalog_ != address(0) && catalog_.code.length == 0) revert NotAContract(catalog_);
        sequentialImplementation = sequentialImplementation_;
        minterImplementation = minterImplementation_;
        defaultRenderer = defaultRenderer_;
        catalog = catalog_;
        deployer = msg.sender;
    }

    /// @notice One-way: stop new deploys and set a successor (zero if none
    ///         exists yet). Deployer-only.
    function deprecate(address successor_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (deprecated) revert AlreadyDeprecated();
        deprecated = true;
        successor = successor_;
        emit Deprecated(successor_);
    }

    /// @notice Reversible: pause or resume new deploys. Deployer-only. Independent of
    ///         `deprecate`: a deprecated factory stays permanently off regardless of this flag.
    function setPaused(bool paused_) external {
        if (msg.sender != deployer) revert NotDeployer();
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Deploy a collection owned by `owner` wired to a canonical
    ///         FixedPriceMinterV2 clone in one transaction: clone the token,
    ///         clone and initialize the minter bound to it with `sale`, then
    ///         initialize the token with the minter as its sole initial
    ///         minter. The common priced-drop path.
    /// @param owner The artist. Explicit, so a deploy helper can create on
    ///        the artist's behalf.
    /// @param cfg The full live config, including the two one-way locks: pass
    ///        them true to initialize the collection locked.
    /// @param sale The canonical minter's sale config (price, window, payout,
    ///        cap, allowlist, wallet cap). See `SaleConfig`.
    /// @param creators Initial listed creators (the owner's side of
    ///        attribution); each confirms by claiming the collection in their
    ///        own Catalog. Empty for solo works.
    /// @param seedSource External seed fallback wired into the collection at
    ///        init; address(0) disables it (the default, and the only
    ///        option most works need).
    /// @return collection The cloned token.
    /// @return minter The cloned, initialized, and granted FixedPriceMinterV2.
    function createSurface(
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        SaleConfig calldata sale,
        address[] calldata creators,
        address seedSource
    ) external returns (address collection, address minter) {
        _checkCreatable(owner);
        // Clone order matters: FixedPriceMinterV2.initialize requires
        // collection.code.length != 0, and an EIP-1167 clone has code
        // immediately after Clones.clone, before its own initialize runs. So
        // the token clones (uninitialized) first, then the minter clones and
        // initializes against it, then the token initializes with the minter
        // already known as its sole initial minter.
        collection = Clones.clone(sequentialImplementation);
        minter = Clones.clone(minterImplementation);
        _initCanonicalMinter(minter, collection, owner, sale);
        _initCanonicalToken(collection, minter, name, symbol, owner, cfg, creators, seedSource);
        _record(collection);
        // Memory copies keep the emit's string operands at the top of the
        // stack; reading the calldata slots directly here exceeds the
        // legacy-codegen stack-depth limit.
        string memory name_ = name;
        string memory symbol_ = symbol;
        emit SurfaceCreated(owner, collection, minter, IdMode.Sequential, name_, symbol_);
    }

    /// @dev Split out of createSurface to keep its stack frame within the
    ///      legacy-codegen limit; no behavior of its own.
    function _initCanonicalMinter(address minter, address collection, address owner, SaleConfig calldata sale)
        private
    {
        // A caller-left-zero payoutRecipient defaults to `owner`: a deploy-time
        // snapshot of that address, not a live read, so it stays renounce-safe.
        FixedPriceMinterV2(minter).initialize(
            FixedPriceMinterV2InitParams({
                collection: collection,
                price: sale.price,
                mintStart: sale.mintStart,
                mintEnd: sale.mintEnd,
                payoutRecipient: sale.payoutRecipient == address(0) ? owner : sale.payoutRecipient,
                maxMints: sale.maxMints,
                allowlistRoot: sale.allowlistRoot,
                walletCap: sale.walletCap
            })
        );
    }

    /// @dev Split out of createSurface to keep its stack frame within the
    ///      legacy-codegen limit; no behavior of its own.
    function _initCanonicalToken(
        address collection,
        address minter,
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata creators,
        address seedSource
    ) private {
        address[] memory initialMinters = new address[](1);
        initialMinters[0] = minter;
        ISurfaceV2(collection).initialize(
            InitParamsV2({
                name: name,
                symbol: symbol,
                owner: owner,
                cfg: cfg,
                defaultRenderer: defaultRenderer,
                initialMinters: initialMinters,
                primaryMinter: minter,
                catalog: catalog,
                creators: creators,
                seedSource: seedSource
            })
        );
    }

    /// @notice Deploy and configure a collection owned by `owner` with no
    ///         canonical minter: the caller supplies its own minters (or
    ///         grants them post-deploy). For a plain priced drop, prefer
    ///         `createSurface`.
    /// @param initialMinters Minters granted at init. Empty for collections
    ///        that grant minters in a later transaction.
    /// @param primaryMinter Frontend-discovery default; must be address(0) or
    ///        a member of `initialMinters`. The collection's own
    ///        setPrimaryMinter can repoint it later.
    /// @param creators Initial listed creators (the owner's side of
    ///        attribution); each confirms by claiming the collection in their
    ///        own Catalog. Empty for solo works.
    /// @param seedSource External seed fallback wired into the collection at
    ///        init; address(0) disables it.
    function createSurfaceCustom(
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata initialMinters,
        address primaryMinter,
        address[] calldata creators,
        address seedSource
    ) external returns (address collection) {
        _checkCreatable(owner);
        if (primaryMinter != address(0) && !_isMember(initialMinters, primaryMinter)) {
            revert PrimaryMinterNotAuthorized();
        }
        collection = _createCustom(name, symbol, owner, cfg, initialMinters, primaryMinter, creators, seedSource);
        _record(collection);
        // Memory copies keep the emit's string operands at the top of the
        // stack; reading the calldata slots directly here exceeds the
        // legacy-codegen stack-depth limit.
        string memory name_ = name;
        string memory symbol_ = symbol;
        emit SurfaceCreated(owner, collection, primaryMinter, IdMode.Sequential, name_, symbol_);
    }

    /// @dev Split out of createSurfaceCustom to keep its stack frame within
    ///      the legacy-codegen limit; no behavior of its own.
    function _createCustom(
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata initialMinters,
        address primaryMinter,
        address[] calldata creators,
        address seedSource
    ) private returns (address collection) {
        collection = Clones.clone(sequentialImplementation);
        // Assigned field by field rather than as one struct literal: with 10
        // fields, building the literal in a single expression needs every
        // calldata argument live on the stack at once and exceeds the
        // legacy-codegen stack-depth limit.
        InitParamsV2 memory p;
        p.name = name;
        p.symbol = symbol;
        p.owner = owner;
        p.cfg = cfg;
        p.defaultRenderer = defaultRenderer;
        p.initialMinters = initialMinters;
        p.primaryMinter = primaryMinter;
        p.catalog = catalog;
        p.creators = creators;
        p.seedSource = seedSource;
        ISurfaceV2(collection).initialize(p);
    }

    function _isMember(address[] calldata list, address account) private pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == account) return true;
        }
        return false;
    }

    function _checkCreatable(address owner) private view {
        if (deprecated) revert FactoryDeprecated();
        if (paused) revert FactoryPaused();
        if (owner == address(0)) revert OwnerRequired();
    }

    function _record(address collection) private {
        isSurface[collection] = true;
        allSurfaces.push(collection);
    }

    function totalSurfaces() external view returns (uint256) {
        return allSurfaces.length;
    }
}
