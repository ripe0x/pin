// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {SurfaceCore} from "./SurfaceCore.sol";
import {SurfaceConfig, IdMode, InitParams} from "./SurfaceTypes.sol";

/// @title SurfaceFactory
/// @notice Deploys one collection per call, configured in a single transaction,
///         as an immutable EIP-1167 clone. Two forms, two implementations, two
///         entrypoints: createSurface for the sequential form (the contract
///         assigns ids), createPooledSurface for the pooled form (the minter
///         chooses ids). No proxy admin and no upgrade path. No fee is stored
///         here; the referral share is a constant inside the collection, paid
///         to the mint host.
///
///         Emits one SurfaceCreated event per collection, stamped with its
///         form, from a single fixed address for indexers to watch. New
///         behavior ships by deploying new implementations and a new factory,
///         not by modifying a deployed collection.
contract SurfaceFactory {
    /// @notice The sequential implementation every createSurface clone
    ///         points at.
    address public immutable sequentialImplementation;

    /// @notice The pooled implementation every createPooledSurface clone
    ///         points at.
    address public immutable pooledImplementation;

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

    event SurfaceCreated(address indexed owner, address indexed collection, IdMode idMode);
    event Deprecated(address indexed successor);
    event PausedSet(bool paused);

    error FactoryDeprecated();
    error FactoryPaused();
    error NotDeployer();
    error AlreadyDeprecated();
    error NotAContract(address account);
    error OwnerRequired();

    constructor(
        address sequentialImplementation_,
        address pooledImplementation_,
        address defaultRenderer_,
        address catalog_
    ) {
        if (sequentialImplementation_.code.length == 0) {
            revert NotAContract(sequentialImplementation_);
        }
        if (pooledImplementation_.code.length == 0) revert NotAContract(pooledImplementation_);
        // The default renderer is optional (0 = no factory default): a collection that names
        // no renderer of its own then reverts RendererRequired at creation, requiring every
        // collection to supply its own. A nonzero value must be a contract, same as catalog
        // below, so an EOA/typo cannot silently become the fallback tokenURI for every clone.
        if (defaultRenderer_ != address(0) && defaultRenderer_.code.length == 0) {
            revert NotAContract(defaultRenderer_);
        }
        // Catalog is optional (0 disables creator confirmation), but a nonzero value must be a
        // contract: a mistyped/EOA/wrong-chain address passes silently here and then makes
        // isConfirmedCreator revert forever on every collection this factory clones;
        // unrecoverable, since collections are immutable and there is no setCatalog.
        if (catalog_ != address(0) && catalog_.code.length == 0) revert NotAContract(catalog_);
        sequentialImplementation = sequentialImplementation_;
        pooledImplementation = pooledImplementation_;
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

    /// @notice Deploy and configure a sequential collection owned by `owner`:
    ///         the contract assigns ids, collectors buy through the built-in
    ///         paid paths.
    /// @param owner The artist. Explicit, so a deploy helper can create on
    ///        the artist's behalf.
    /// @param cfg The full live config, including the two one-way locks: pass
    ///        them true to initialize the collection locked.
    /// @param initialMinters Extension minters granted at init. Empty for
    ///        collections that sell only through the built-in paths.
    /// @param creators Initial listed creators (the owner's side of
    ///        attribution); each confirms by claiming the collection in their
    ///        own Catalog. Empty for solo works.
    function createSurface(
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata initialMinters,
        address[] calldata creators
    ) external returns (address collection) {
        return _create(sequentialImplementation, IdMode.Sequential, name, symbol, owner, cfg, initialMinters, creators);
    }

    /// @notice Deploy and configure a pooled collection owned by `owner`: the
    ///         backed/sourced form where an authorized minter chooses every id
    ///         and owns the pool's economics. Grant it in `initialMinters` so
    ///         the collection deploys fully wired in one transaction.
    function createPooledSurface(
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata initialMinters,
        address[] calldata creators
    ) external returns (address collection) {
        return _create(pooledImplementation, IdMode.Pooled, name, symbol, owner, cfg, initialMinters, creators);
    }

    function _create(
        address implementation,
        IdMode idMode,
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata initialMinters,
        address[] calldata creators
    ) private returns (address collection) {
        if (deprecated) revert FactoryDeprecated();
        if (paused) revert FactoryPaused();
        if (owner == address(0)) revert OwnerRequired();
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
                    catalog: catalog,
                    creators: creators
                })
            );
        isSurface[collection] = true;
        allSurfaces.push(collection);
        emit SurfaceCreated(owner, collection, idMode);
    }

    function totalSurfaces() external view returns (uint256) {
        return allSurfaces.length;
    }
}
