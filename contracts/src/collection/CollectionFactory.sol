// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {Collection} from "./Collection.sol";
import {CollectionConfig, InitParams, WorkConfig} from "./CollectionTypes.sol";

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

    /// @notice The Attribution singleton for optional roster writes at deploy.
    ///         address(0) disables the integration.
    address public immutable attribution;

    mapping(address => bool) public isCollection;
    address[] public allCollections;

    event CollectionCreated(address indexed owner, address indexed collection);

    constructor(address implementation_, address defaultRenderer_, address attribution_) {
        require(implementation_.code.length > 0, "impl has no code");
        require(defaultRenderer_.code.length > 0, "renderer has no code");
        implementation = implementation_;
        defaultRenderer = defaultRenderer_;
        attribution = attribution_;
    }

    /// @notice Deploy + configure a new collection owned by `owner`.
    /// @param owner The artist. Taken explicitly so a deploy helper can create
    ///        on the artist's behalf.
    /// @param initialMinters Extension minters granted at init (pooled/backed
    ///        forms deploy fully wired in one tx). Empty for collections that
    ///        sell through the built-in fixed-price path.
    /// @param artists Optional Attribution roster (collabs). The collection
    ///        writes it to the Attribution singleton during its own init (the
    ///        singleton authorizes the collection itself); each artist
    ///        completes the handshake by claiming the collection in their own
    ///        Catalog. Ignored when empty or when the factory has no
    ///        attribution set.
    function createCollection(
        string calldata name,
        string calldata symbol,
        address owner,
        CollectionConfig calldata cfg,
        WorkConfig calldata workCfg,
        address[] calldata initialMinters,
        address[] calldata artists
    ) external returns (address collection) {
        require(owner != address(0), "owner required");
        collection = Clones.clone(implementation);
        Collection(collection).initialize(
            InitParams({
                name: name,
                symbol: symbol,
                owner: owner,
                cfg: cfg,
                work: workCfg,
                defaultRenderer: defaultRenderer,
                initialMinters: initialMinters,
                attribution: attribution,
                artists: artists
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
