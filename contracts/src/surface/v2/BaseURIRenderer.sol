// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Strings} from "openzeppelin-contracts/contracts/utils/Strings.sol";

import {ISurface} from "./interfaces/ISurface.sol";
import {IRenderer} from "../interfaces/IRenderer.sol";

/// @title BaseURIRenderer
/// @notice Shared renderer for collections whose metadata is a folder of JSON
///         files: tokenURI(id) = baseURI + id + ".json".
///
/// @dev    One instance serves every collection. Authority is borrowed from
///         the collection's live owner(), so renouncing the collection also
///         freezes its base URI: no separate lock, no second owner to forget.
contract BaseURIRenderer is IRenderer {
    error NotCollectionOwner();

    event BaseURISet(address indexed collection, string baseURI);

    mapping(address collection => string) public baseURIOf;

    /// @notice Collection owner only. Signals an ERC-4906 refresh when this
    ///         renderer is the collection's current renderer; otherwise the
    ///         later setRenderer emits its own refresh.
    function setBaseURI(address collection, string calldata baseURI) external {
        if (msg.sender != ISurface(collection).owner()) revert NotCollectionOwner();
        baseURIOf[collection] = baseURI;
        emit BaseURISet(collection, baseURI);
        if (ISurface(collection).renderer() == address(this)) {
            ISurface(collection).notifyMetadataUpdate(0, type(uint256).max);
        }
    }

    /// @notice Empty until a base URI is set.
    function tokenURI(address collection, uint256 tokenId) external view returns (string memory) {
        string memory base = baseURIOf[collection];
        if (bytes(base).length == 0) return "";
        return string.concat(base, Strings.toString(tokenId), ".json");
    }

    function contractURI(address) external pure returns (string memory) {
        return "";
    }
}
