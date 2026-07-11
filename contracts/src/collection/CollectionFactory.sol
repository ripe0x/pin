// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {Collection} from "./Collection.sol";
import {CollectionConfig, InitParams} from "./CollectionTypes.sol";

/// @title CollectionFactory
/// @notice Deploys one Collection per work, configured in one transaction, as
///         an immutable EIP-1167 clone. No proxy admin, no upgrade path: what
///         deploys is what runs. No fee lives here either — the referral
///         share is a constant inside the collection, paid to whoever hosts
///         the mint.
///
///         This is the one fixed address an indexer watches: one
///         CollectionCreated event per collection. The core evolves by
///         deploying a new implementation and a new factory, never by
///         changing a collection already out in the world.
contract CollectionFactory {
    /// @notice The Collection implementation every clone points at.
    address public immutable implementation;

    /// @notice The renderer a collection gets when the artist names none.
    address public immutable defaultRenderer;

    /// @notice The Catalog singleton every clone reads for creator
    ///         confirmation. address(0) disables confirmation.
    address public immutable catalog;

    /// @notice The deployer: the only address that may deprecate this
    ///         factory, and that is its only power. It has none over
    ///         collections already deployed.
    address public immutable deployer;

    /// @notice One-way stop for NEW deploys. If the implementation turns out
    ///         to have a bug, deprecating halts further clones and points
    ///         integrators at the successor. Deployed collections are
    ///         immutable and unaffected — by design nobody can touch them,
    ///         including us.
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
    error NotAContract(address account);
    error OwnerRequired();

    constructor(address implementation_, address defaultRenderer_, address catalog_) {
        if (implementation_.code.length == 0) revert NotAContract(implementation_);
        if (defaultRenderer_.code.length == 0) revert NotAContract(defaultRenderer_);
        implementation = implementation_;
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

    /// @notice Deploy + configure a new collection owned by `owner`.
    /// @param owner The artist. Explicit, so a deploy helper can create on
    ///        the artist's behalf.
    /// @param cfg The full live config, including the two one-way locks —
    ///        pass them true and the collection is born locked.
    /// @param initialMinters Extension minters granted at init, so pooled and
    ///        backed forms deploy fully wired. Empty for built-in sales.
    /// @param creators Initial listed creators (the owner's side of
    ///        attribution); each confirms by claiming the collection in their
    ///        own Catalog. Empty for solo works.
    function createCollection(
        string calldata name,
        string calldata symbol,
        address owner,
        CollectionConfig calldata cfg,
        address[] calldata initialMinters,
        address[] calldata creators
    ) external returns (address collection) {
        if (deprecated) revert FactoryDeprecated();
        if (owner == address(0)) revert OwnerRequired();
        collection = Clones.clone(implementation);
        Collection(collection)
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
        isCollection[collection] = true;
        allCollections.push(collection);
        emit CollectionCreated(owner, collection);
    }

    function totalCollections() external view returns (uint256) {
        return allCollections.length;
    }
}
