// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A liar ERC721: claims to support ERC165 + ERC721 and to permit
///         transfers, but transferFrom is a no-op. Used to verify the
///         post-transfer escrow check in SovereignAuctionHouse.createAuction —
///         after calling transferFrom, the contract reads ownerOf and reverts
///         with EscrowFailed when the token didn't actually move.
contract NoopERC721 {
    address public claimedOwner;

    function setOwner(address who) external {
        claimedOwner = who;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd || interfaceId == 0x01ffc9a7;
    }

    function ownerOf(uint256) external view returns (address) {
        return claimedOwner;
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return true;
    }

    function transferFrom(address, address, uint256) external pure {}
}
