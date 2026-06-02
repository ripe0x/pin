// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IPNDMintHook} from "../../src/editions/interfaces/IPNDMintHook.sol";
import {IPNDRenderer} from "../../src/editions/interfaces/IPNDRenderer.sol";
import {PNDEditions} from "../../src/editions/PNDEditions.sol";

/// @dev Mint hook that gates and records custom data, mirroring what an artist
///      would deploy to build on each mint.
contract MockMintHook is IPNDMintHook {
    bool public allow = true;
    bool public revertBefore;
    uint256 public beforeCount;
    uint256 public afterCount;
    address public lastMinter;
    uint256 public lastFirstTokenId;
    uint256 public lastQuantity;
    address public lastSurface;
    mapping(uint256 => bytes) public recorded; // firstTokenId => custom data

    function setAllow(bool a) external {
        allow = a;
    }

    function setRevertBefore(bool r) external {
        revertBefore = r;
    }

    function beforeMint(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes calldata
    ) external returns (bytes4) {
        require(!revertBefore, "hook: revert");
        beforeCount++;
        lastMinter = minter;
        lastFirstTokenId = firstTokenId;
        lastQuantity = quantity;
        lastSurface = surface;
        return allow ? IPNDMintHook.beforeMint.selector : bytes4(0xffffffff);
    }

    function afterMint(
        address,
        uint256,
        uint256 firstTokenId,
        address,
        bytes calldata data
    ) external {
        afterCount++;
        recorded[firstTokenId] = data;
    }

    function recordedData(uint256 firstTokenId) external view returns (bytes memory) {
        return recorded[firstTokenId];
    }
}

/// @dev A custom renderer that ignores edition state and returns fixed URIs.
contract MockRenderer is IPNDRenderer {
    function tokenURI(uint256) external pure returns (string memory) {
        return "custom://token";
    }

    function contractURI() external pure returns (string memory) {
        return "custom://contract";
    }
}

/// @dev Rejects ETH, used to test payout/surface transfer failures.
contract RevertOnReceive {
    receive() external payable {
        revert("no eth");
    }
}

/// @dev A v2 implementation used to prove an edition can upgrade.
contract PNDEditionsV2Mock is PNDEditions {
    function version() external pure returns (uint256) {
        return 2;
    }
}
