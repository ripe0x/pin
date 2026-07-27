// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IRenderer} from "../../src/surface/interfaces/IRenderer.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Base64} from "solady/utils/Base64.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @notice Rehearsal-only IRenderer that serves a fixed snapshot of an artist's
///         real render (captured from their live mainnet renderer) via hosted
///         URLs, so a Sepolia collection displays the actual artwork + audio in
///         the PND UI without redeploying the artist's onchain generative
///         stack. Every token in the batch resolves to the same artwork, which
///         matches the edition model (one work per batch). Not a production
///         renderer: mainnet returns self-contained data: URIs from the live
///         stack, this returns URLs to a hosted snapshot.
contract SnapshotRenderer is IRenderer, Ownable {
    string public name;
    string public description;
    string public htmlUrl;
    string public imageUrl;

    constructor(string memory name_, string memory description_, string memory htmlUrl_, string memory imageUrl_) {
        _initializeOwner(msg.sender);
        name = name_;
        description = description_;
        htmlUrl = htmlUrl_;
        imageUrl = imageUrl_;
    }

    /// @dev Prevents _initializeOwner from being callable a second time.
    function _guardInitializeOwner() internal pure override returns (bool) {
        return true;
    }

    /// @notice Repoint the snapshot URLs, so a rehearsal can swap the artwork
    ///         source without redeploying and re-registering on the router.
    function setUrls(string calldata htmlUrl_, string calldata imageUrl_) external onlyOwner {
        htmlUrl = htmlUrl_;
        imageUrl = imageUrl_;
    }

    function tokenURI(address, uint256 tokenId) external view override returns (string memory) {
        string memory id = LibString.toString(tokenId);
        string memory meta = string.concat(
            '{"name":"',
            name,
            " #",
            id,
            '","description":"',
            description,
            '","image":"',
            imageUrl,
            '","animation_url":"',
            htmlUrl,
            '","attributes":[{"trait_type":"Preview","value":"Sepolia snapshot"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(meta)));
    }

    function contractURI(address) external view override returns (string memory) {
        string memory meta = string.concat(
            '{"name":"', name, '","description":"', description, '","image":"', imageUrl, '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(meta)));
    }
}
