// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {PNDEditions} from "./PNDEditions.sol";
import {EditionConfig} from "./PNDEditionsTypes.sol";

/// @title PNDEditionsFactory
/// @notice Deploys one PNDEditions contract per edition, configured atomically
///         at deploy. Every edition is a UUPS proxy (upgradeable); the owner
///         can seal() to renounce upgradeability. There is no protocol fee
///         here — the Surface Share is a fixed constant inside the edition,
///         paid to whoever hosts the mint.
///
///         This is the single fixed contract an indexer watches for discovery
///         (one EditionCreated event per edition).
contract PNDEditionsFactory {
    /// @notice The PNDEditions implementation every proxy points at initially.
    address public immutable implementation;

    /// @notice The canonical built-in renderer wired into every edition.
    address public immutable defaultRenderer;

    mapping(address => bool) public isEdition;
    address[] public allEditions;

    event EditionCreated(address indexed owner, address indexed edition);

    constructor(address implementation_, address defaultRenderer_) {
        require(implementation_.code.length > 0, "impl has no code");
        require(defaultRenderer_.code.length > 0, "renderer has no code");
        implementation = implementation_;
        defaultRenderer = defaultRenderer_;
    }

    /// @notice Deploy + configure a new edition owned by `owner`.
    /// @param owner The artist. Taken explicitly so a deploy helper can create
    ///        on the artist's behalf.
    function createEdition(
        string calldata name,
        string calldata symbol,
        address owner,
        EditionConfig calldata cfg
    ) external returns (address edition) {
        require(owner != address(0), "owner required");
        bytes memory initData = abi.encodeCall(
            PNDEditions.initialize, (name, symbol, owner, cfg, defaultRenderer)
        );
        edition = address(new ERC1967Proxy(implementation, initData));
        isEdition[edition] = true;
        allEditions.push(edition);
        emit EditionCreated(owner, edition);
    }

    function totalEditions() external view returns (uint256) {
        return allEditions.length;
    }
}
