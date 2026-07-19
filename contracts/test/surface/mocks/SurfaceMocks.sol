// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IRenderer} from "../../../src/surface/interfaces/IRenderer.sol";
import {ISurface} from "../../../src/surface/interfaces/ISurface.sol";
import {ISurfaceCore} from "../../../src/surface/interfaces/ISurfaceCore.sol";
import {IPooledSurface} from "../../../src/surface/interfaces/IPooledSurface.sol";

/// @dev Deterministic renderer: returns strings derived from the collection
///      address + tokenId, so tests can assert delegation without depending
///      on any real onchain-SVG renderer.
contract MockRenderer is IRenderer {
    function tokenURI(address collection, uint256 tokenId) external pure override returns (string memory) {
        return string(abi.encodePacked("mock://token/", _addrStr(collection), "/", _uintStr(tokenId)));
    }

    function contractURI(address collection) external pure override returns (string memory) {
        return string(abi.encodePacked("mock://contract/", _addrStr(collection)));
    }

    function _uintStr(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory b = new bytes(len);
        while (v != 0) {
            len -= 1;
            b[len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }

    function _addrStr(address a) internal pure returns (string memory) {
        bytes memory data = abi.encodePacked(a);
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(2 + data.length * 2);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < data.length; i++) {
            str[2 + i * 2] = alphabet[uint8(data[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}

/// @dev Extension minter that calls mintTo (sequential) / mintToId (pooled).
///      Stands in for a real minter module (the Phase 2 canonical minter,
///      BackedMinter, PooledIdMinter, etc.) in tests.
contract MockMinter {
    function callMintTo(ISurface collection, address to, uint256 quantity) external returns (uint256 firstTokenId) {
        return collection.mintTo(to, quantity);
    }

    function callMintToId(IPooledSurface collection, address to, uint256 tokenId) external {
        collection.mintToId(to, tokenId);
    }

    /// @dev Burn as an authorized minter — the only path that can retire a pooled token.
    function callBurn(ISurfaceCore collection, uint256 tokenId) external {
        collection.burn(tokenId);
    }
}
