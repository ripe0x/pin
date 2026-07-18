// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {SurfaceCore} from "./SurfaceCore.sol";
import {SurfaceConfig, IdMode, InitParams} from "./SurfaceTypes.sol";

/// @title SurfaceFactory
/// @notice Deploys one collection per work, configured in one transaction, as
///         an immutable EIP-1167 clone. Two forms, two implementations, two
///         doors: createSurface for the sequential form (the contract
///         counts ids), createPooledSurface for the pooled form (the
///         minter chooses ids). No proxy admin, no upgrade path: what deploys
///         is what runs. No fee lives here either: the referral share is a
///         constant inside the collection, paid to whoever hosts the mint.
///
///         This is the one fixed address an indexer watches: one
///         SurfaceCreated event per collection, stamped with its form. The
///         system evolves by deploying new implementations and a new
///         factory, never by changing a collection already out in the world.
contract SurfaceFactory {
    /// @notice The sequential implementation every createSurface clone
    ///         points at.
    address public immutable sequentialImplementation;

    /// @notice The pooled implementation every createPooledSurface clone
    ///         points at.
    address public immutable pooledImplementation;

    /// @notice The renderer a collection gets when the artist names none.
    address public immutable defaultRenderer;

    /// @notice The Catalog singleton every clone reads for creator
    ///         confirmation. address(0) disables confirmation.
    address public immutable catalog;

    /// @notice The deployer: the only address that may deprecate this
    ///         factory, and that is its only power. It has none over
    ///         collections already deployed.
    address public immutable deployer;

    /// @notice One-way stop for NEW deploys. If an implementation turns out
    ///         to have a bug, deprecating halts further clones and points
    ///         integrators at the successor. Deployed collections are
    ///         immutable and unaffected: by design nobody can touch them,
    ///         including us.
    bool public deprecated;
    /// @notice The replacement factory once deprecated (informational).
    address public successor;

    /// @notice Reversible pause on NEW deploys, distinct from `deprecated`: a temporary
    ///         off switch (incident, maintenance) the deployer can flip back on. Deprecation
    ///         is the permanent, one-way end-of-life; this is the everyday circuit breaker.
    ///         Neither touches collections already deployed.
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
        if (defaultRenderer_.code.length == 0) revert NotAContract(defaultRenderer_);
        // Catalog is optional (0 disables creator confirmation), but a nonzero value must be a
        // real contract: a mistyped/EOA/wrong-chain address passes silently here and then makes
        // isConfirmedCreator revert forever on every collection this factory ever clones;
        // unrecoverable, since collections are immutable and there is no setCatalog.
        if (catalog_ != address(0) && catalog_.code.length == 0) revert NotAContract(catalog_);
        sequentialImplementation = sequentialImplementation_;
        pooledImplementation = pooledImplementation_;
        defaultRenderer = defaultRenderer_;
        catalog = catalog_;
        deployer = msg.sender;
    }

    /// @notice One-way: stop new deploys and name a successor (zero if none
    ///         exists yet). Deployer-only.
    function deprecate(address successor_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (deprecated) revert AlreadyDeprecated();
        deprecated = true;
        successor = successor_;
        emit Deprecated(successor_);
    }

    /// @notice Reversible: pause or resume new deploys. Deployer-only. Independent of
    ///         `deprecate`: a deprecated factory stays permanently off regardless.
    function setPaused(bool paused_) external {
        if (msg.sender != deployer) revert NotDeployer();
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Deploy + configure a sequential collection owned by `owner`;
    ///         the common form: the contract counts ids, collectors buy
    ///         through the built-in paid paths.
    /// @param owner The artist. Explicit, so a deploy helper can create on
    ///        the artist's behalf.
    /// @param cfg The full live config, including the two one-way locks:
    ///        pass them true and the collection is born locked.
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

    /// @notice Deploy + configure a pooled collection owned by `owner`; the
    ///         backed/sourced form: an authorized minter chooses every id and
    ///         owns the pool's economics. Grant it in `initialMinters` so the
    ///         work deploys fully wired in one transaction.
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
