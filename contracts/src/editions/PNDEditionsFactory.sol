// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {ERC1967Proxy} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {PNDEditions} from "./PNDEditions.sol";
import {ProjectMode} from "./PNDEditionsTypes.sol";

/// @title PNDEditionsFactory
/// @notice Deploys one PNDEditions contract per project. Opt-in
///         upgradeability: ImmutableClone (EIP-1167, no upgrade path, cheapest)
///         or Upgradeable (ERC1967/UUPS, owner can upgrade until seal()). Both
///         share one audited implementation and the canonical default renderer.
///
///         This is the single fixed contract an indexer watches for discovery
///         (one ProjectCreated event per project), mirroring how the Mint
///         protocol's MintFactory.Created drives discovery.
contract PNDEditionsFactory {
    /// @notice The PNDEditions implementation. Immutable clones and upgradeable
    ///         proxies both point here initially.
    address public immutable implementation;

    /// @notice The canonical built-in renderer wired into every project.
    address public immutable defaultRenderer;

    /// @notice Reverse lookup so a client can ask "is this a PND project?"
    mapping(address => bool) public isProject;

    /// @notice Every project, in creation order.
    address[] public allProjects;

    /// @notice Emitted once per project. `mode` lets clients and indexers see
    ///         the mutability stance without an extra read.
    event ProjectCreated(address indexed owner, address indexed project, ProjectMode mode);

    constructor(address implementation_, address defaultRenderer_) {
        require(implementation_.code.length > 0, "impl has no code");
        require(defaultRenderer_.code.length > 0, "renderer has no code");
        implementation = implementation_;
        defaultRenderer = defaultRenderer_;
    }

    /// @notice Deploy a new project ERC721A contract owned by `owner`.
    /// @param owner The project owner (artist). Taken explicitly so a deploy
    ///        helper / relayer can create on the artist's behalf.
    /// @param mode ImmutableClone or Upgradeable.
    function createProject(
        string calldata name,
        string calldata symbol,
        address owner,
        ProjectMode mode
    ) external returns (address project) {
        require(owner != address(0), "owner required");

        if (mode == ProjectMode.ImmutableClone) {
            project = Clones.clone(implementation);
            PNDEditions(project).initialize(name, symbol, owner, false, defaultRenderer);
        } else {
            bytes memory initData = abi.encodeCall(
                PNDEditions.initialize, (name, symbol, owner, true, defaultRenderer)
            );
            project = address(new ERC1967Proxy(implementation, initData));
        }

        isProject[project] = true;
        allProjects.push(project);
        emit ProjectCreated(owner, project, mode);
    }

    function totalProjects() external view returns (uint256) {
        return allProjects.length;
    }
}
