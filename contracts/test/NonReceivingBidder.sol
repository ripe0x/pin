// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A contract that can place bids and receive ETH refunds, but does
///         NOT implement IERC721Receiver. Used to test that endAuction now
///         reverts (rather than silently cancels) if the winning bidder can't
///         take delivery — closing the prior griefing path where a contract
///         bidder could win with no intent to settle.
contract NonReceivingBidder {
    function bid(address payable house, uint256 auctionId, uint256 amount) external payable {
        (bool ok, bytes memory data) = house.call{value: amount}(
            abi.encodeWithSignature("createBid(uint256)", auctionId)
        );
        require(ok, _reason(data));
    }

    receive() external payable {}

    function _reason(bytes memory data) internal pure returns (string memory) {
        if (data.length < 68) return "call failed";
        assembly {
            data := add(data, 0x04)
        }
        return abi.decode(data, (string));
    }
}
