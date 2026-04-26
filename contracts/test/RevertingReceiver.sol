// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A contract that rejects ETH on receive(). Used to test the
///         pull-payment refund fallback path in PndAuctionHouse.
contract RevertingReceiver {
    function bid(address payable house, uint256 auctionId, uint256 amount) external payable {
        (bool ok, bytes memory data) = house.call{value: amount}(
            abi.encodeWithSignature("createBid(uint256)", auctionId)
        );
        require(ok, _revertReason(data));
    }

    function withdraw(address payable house) external {
        (bool ok, ) = house.call(abi.encodeWithSignature("withdrawRefund()"));
        require(ok, "withdraw failed");
    }

    receive() external payable {
        revert("nope");
    }

    function _revertReason(bytes memory data) internal pure returns (string memory) {
        if (data.length < 68) return "call failed";
        assembly {
            data := add(data, 0x04)
        }
        return abi.decode(data, (string));
    }
}
