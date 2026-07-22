// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {SurfaceCore} from "./SurfaceCore.sol";
import {SurfaceConfig, IdMode, InitParams} from "./SurfaceTypes.sol";
import {FixedPriceMinter, FixedPriceMinterInitParams} from "./minters/FixedPriceMinter.sol";

/// @notice Sale-config parameters for the canonical minter clone `createSurface`
///         wires. Matches `FixedPriceMinterInitParams` minus `collection`: the
///         factory fills that in with the token clone it creates in the same
///         call, since the caller cannot know that address ahead of time.
struct SaleConfig {
    uint256 price; // wei; used when priceStrategy is unset
    address priceStrategy; // 0 = fixed price
    uint64 mintStart; // unix seconds; 0 = open immediately
    uint64 mintEnd; // unix seconds; 0 = open-ended
    address payoutRecipient; // 0 = default to the deploy-time `owner` argument
    uint256 maxMints; // 0 = unlimited; this minter's own sale ceiling
    bytes32 allowlistRoot; // 0 = open
    uint256 walletCap; // 0 = unlimited; per-recipient
}

/// @title SurfaceFactory
/// @notice Deploys Surface collections as immutable EIP-1167 clones; each
///         collection's owner controls its authorized minters and renderer
///         slot and can lock either permanently.
///
///         Clones a collection as an immutable EIP-1167 proxy per call.
///         `createSurface` (sequential, canonical minter) clones the token and
///         a `FixedPriceMinter` together and wires them in one transaction.
///         `createSurfaceCustom` (sequential, bring-your-own minter) and
///         `createPooledSurface` (pooled, bring-your-own minter) clone only the
///         token and grant whatever minters the caller passes. No proxy admin
///         or upgrade path, and no fee taken here. New behavior ships as new
///         implementations behind a new factory, not by changing a deployed
///         collection or minter.
contract SurfaceFactory {
    /// @notice The sequential implementation every createSurface/
    ///         createSurfaceCustom clone points at.
    address public immutable sequentialImplementation;

    /// @notice The pooled implementation every createPooledSurface clone
    ///         points at.
    address public immutable pooledImplementation;

    /// @notice The FixedPriceMinter implementation createSurface clones as
    ///         the canonical minter. Not used by createSurfaceCustom or
    ///         createPooledSurface, which take their minters from the caller.
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
    ///         toggle back on. Deprecation is the permanent, one-way
    ///         end-of-life; this is the reversible circuit breaker. Neither
    ///         affects deployed collections.
    bool public paused;

    mapping(address => bool) public isSurface;
    address[] public allSurfaces;

    /// @notice `primaryMinter` is the canonical FixedPriceMinter clone
    ///         createSurface wired, the caller-supplied primary for
    ///         createSurfaceCustom/createPooledSurface, or address(0) when
    ///         none was designated. This mirrors the collection's own
    ///         primaryMinter() at the moment of creation: the default
    ///         integration endpoint for a generic client, not the complete
    ///         authorization set. A sequential collection may authorize
    ///         additional minters after creation; the record of who is
    ///         authorized to mint is the collection's MinterSet event log
    ///         (and the live isMinter/isMinterLocked views), not this field.
    ///         There is no separate minterOf storage mapping.
    event SurfaceCreated(address indexed owner, address indexed collection, address primaryMinter, IdMode idMode);
    event Deprecated(address indexed successor);
    event PausedSet(bool paused);

    error FactoryDeprecated();
    error FactoryPaused();
    error NotDeployer();
    error AlreadyDeprecated();
    error NotAContract(address account);
    error OwnerRequired();
    /// @dev Distinct from ISurfaceCore.PrimaryMinterNotAuthorized: the core
    ///      re-checks membership (and, for pooled, sole-minter-ness) at init
    ///      regardless of what the factory validates here.
    error PrimaryMinterNotAuthorized();

    constructor(
        address sequentialImplementation_,
        address pooledImplementation_,
        address minterImplementation_,
        address defaultRenderer_,
        address catalog_
    ) {
        if (sequentialImplementation_.code.length == 0) {
            revert NotAContract(sequentialImplementation_);
        }
        if (pooledImplementation_.code.length == 0) revert NotAContract(pooledImplementation_);
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
        pooledImplementation = pooledImplementation_;
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

    /// @notice Deploy a sequential collection owned by `owner` wired to a
    ///         canonical FixedPriceMinter clone in one transaction: clone the
    ///         token, clone and initialize the minter bound to it with `sale`,
    ///         then initialize the token with the minter as its sole initial
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
    /// @return collection The cloned token.
    /// @return minter The cloned, initialized, and granted FixedPriceMinter.
    function createSurface(
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        SaleConfig calldata sale,
        address[] calldata creators
    ) external returns (address collection, address minter) {
        _checkCreatable(owner);
        // Clone order matters: FixedPriceMinter.initialize requires
        // collection.code.length != 0, and an EIP-1167 clone has code
        // immediately after Clones.clone, before its own initialize runs. So
        // the token clones (uninitialized) first, then the minter clones and
        // initializes against it, then the token initializes with the minter
        // already known as its sole initial minter.
        collection = Clones.clone(sequentialImplementation);
        minter = Clones.clone(minterImplementation);
        // A caller-left-zero payoutRecipient defaults to `owner`: a deploy-time
        // snapshot of that address, not a live read, so it stays renounce-safe.
        FixedPriceMinter(minter).initialize(
            FixedPriceMinterInitParams({
                collection: collection,
                price: sale.price,
                priceStrategy: sale.priceStrategy,
                mintStart: sale.mintStart,
                mintEnd: sale.mintEnd,
                payoutRecipient: sale.payoutRecipient == address(0) ? owner : sale.payoutRecipient,
                maxMints: sale.maxMints,
                allowlistRoot: sale.allowlistRoot,
                walletCap: sale.walletCap
            })
        );
        address[] memory initialMinters = new address[](1);
        initialMinters[0] = minter;
        SurfaceCore(collection).initialize(
            InitParams({
                name: name,
                symbol: symbol,
                owner: owner,
                cfg: cfg,
                defaultRenderer: defaultRenderer,
                initialMinters: initialMinters,
                primaryMinter: minter,
                catalog: catalog,
                creators: creators
            })
        );
        _record(collection);
        emit SurfaceCreated(owner, collection, minter, IdMode.Sequential);
    }

    /// @notice Deploy and configure a sequential collection owned by `owner`
    ///         with no canonical minter: the caller supplies its own minters
    ///         (or grants them post-deploy). For a plain priced drop, prefer
    ///         `createSurface`.
    /// @param initialMinters Minters granted at init. Empty for collections
    ///        that grant minters in a later transaction.
    /// @param primaryMinter Frontend-discovery default; must be address(0) or
    ///        a member of `initialMinters`. The collection's own
    ///        setPrimaryMinter can repoint it later (sequential only).
    /// @param creators Initial listed creators (the owner's side of
    ///        attribution); each confirms by claiming the collection in their
    ///        own Catalog. Empty for solo works.
    function createSurfaceCustom(
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata initialMinters,
        address primaryMinter,
        address[] calldata creators
    ) external returns (address collection) {
        collection = _create(sequentialImplementation, name, symbol, owner, cfg, initialMinters, primaryMinter, creators);
        emit SurfaceCreated(owner, collection, primaryMinter, IdMode.Sequential);
    }

    /// @notice Deploy and configure a pooled collection owned by `owner`: the
    ///         backed/sourced form where an authorized minter chooses every id
    ///         and owns the pool's economics. Grant it in `initialMinters` so
    ///         the collection deploys fully wired in one transaction. There is
    ///         no canonical-minter form for pooled: a fixed-price pooled sale
    ///         has no general id-assignment policy a shared minter could use.
    /// @param primaryMinter Frontend-discovery default; must be address(0) or
    ///        the sole entry of `initialMinters` (the core also enforces this
    ///        at init). The pooled form has no separate setter afterward: the
    ///        primary tracks whichever minter is granted.
    function createPooledSurface(
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata initialMinters,
        address primaryMinter,
        address[] calldata creators
    ) external returns (address collection) {
        collection = _create(pooledImplementation, name, symbol, owner, cfg, initialMinters, primaryMinter, creators);
        emit SurfaceCreated(owner, collection, primaryMinter, IdMode.Pooled);
    }

    function _create(
        address implementation,
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata initialMinters,
        address primaryMinter,
        address[] calldata creators
    ) private returns (address collection) {
        _checkCreatable(owner);
        if (primaryMinter != address(0) && !_isMember(initialMinters, primaryMinter)) {
            revert PrimaryMinterNotAuthorized();
        }
        collection = Clones.clone(implementation);
        SurfaceCore(collection)
            .initialize(
                InitParams({
                    name: name,
                    symbol: symbol,
                    owner: owner,
                    cfg: cfg,
                    defaultRenderer: defaultRenderer,
                    initialMinters: initialMinters,
                    primaryMinter: primaryMinter,
                    catalog: catalog,
                    creators: creators
                })
            );
        _record(collection);
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
