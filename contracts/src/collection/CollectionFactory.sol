// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {Collection} from "./Collection.sol";
import {CollectionConfig, InitParams} from "./CollectionTypes.sol";

/// @title CollectionFactory
/// @notice Deploys one Collection per work, configured atomically at
///         deploy, as an immutable EIP-1167 clone: no proxy admin, no upgrade
///         path, what deploys is what runs. There is no protocol fee here;
///         the Referral Share is a fixed constant inside the collection, paid
///         to whoever hosts the mint.
///
///         This is the single fixed contract an indexer watches for discovery
///         (one CollectionCreated event per collection). Core evolution
///         happens by deploying a new implementation + factory, never by
///         changing deployed collections.
contract CollectionFactory {
    /// @notice The Collection implementation every clone points at.
    address public immutable implementation;

    /// @notice The canonical built-in renderer wired into every collection.
    address public immutable defaultRenderer;

    /// @notice The Catalog singleton every clone reads for creator confirmation.
    ///         address(0) disables confirmation (listings still work).
    address public immutable catalog;

    /// @notice The deployer: the only address that may deprecate this
    ///         factory. No other privilege exists — the deployer has zero
    ///         power over collections already deployed.
    address public immutable deployer;

    /// @notice One-way kill switch for NEW deploys. If a bug is found in the
    ///         implementation post-deploy, deprecating stops further clones
    ///         (createCollection reverts) and points integrators at the
    ///         successor factory. Deployed collections are immutable and
    ///         unaffected — by design they cannot be fixed or touched.
    bool public deprecated;
    /// @notice The replacement factory once deprecated (informational).
    address public successor;

    mapping(address => bool) public isCollection;
    address[] public allCollections;

    event CollectionCreated(address indexed owner, address indexed collection);
    event Deprecated(address indexed successor);

    error FactoryDeprecated();
    error NotDeployer();
    error AlreadyDeprecated();

    constructor(address implementation_, address defaultRenderer_, address catalog_) {
        require(implementation_.code.length > 0, "impl has no code");
        require(defaultRenderer_.code.length > 0, "renderer has no code");
        implementation = implementation_;
        defaultRenderer = defaultRenderer_;
        catalog = catalog_;
        deployer = msg.sender;
    }

    /// @notice One-way: stop new deploys and name a successor (may be zero if
    ///         none exists yet). Deployer-only.
    function deprecate(address successor_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (deprecated) revert AlreadyDeprecated();
        deprecated = true;
        successor = successor_;
        emit Deprecated(successor_);
    }

    /// @notice Deploy + configure a new collection owned by `owner`.
    /// @param owner The artist. Taken explicitly so a deploy helper can create
    ///        on the artist's behalf.
    /// @param initialMinters Extension minters granted at init (pooled/backed
    ///        forms deploy fully wired in one tx). Empty for collections that
    ///        sell through the built-in fixed-price path.
    /// @param creators Optional initial creator listing (the owner's side of
    ///        attribution). Each listed creator completes the handshake by
    ///        claiming the collection in their own Catalog; isConfirmedCreator
    ///        then reads true. Empty for solo works (owner() is the creator).
    function createCollection(
        string calldata name,
        string calldata symbol,
        address owner,
        CollectionConfig calldata cfg,
        address[] calldata initialMinters,
        address[] calldata creators
    ) external returns (address collection) {
        if (deprecated) revert FactoryDeprecated();
        require(owner != address(0), "owner required");
        collection = Clones.clone(implementation);
        Collection(collection).initialize(
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
        isCollection[collection] = true;
        allCollections.push(collection);
        emit CollectionCreated(owner, collection);
    }

    function totalCollections() external view returns (uint256) {
        return allCollections.length;
    }
}
