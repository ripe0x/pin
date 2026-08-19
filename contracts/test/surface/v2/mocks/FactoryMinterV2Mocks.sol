// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ISeedSourceV2} from "../../../../src/surface/v2/interfaces/ISeedSourceV2.sol";

/// @dev Placeholder bring-your-own minter: no mint logic, just a deployed
///      address for factory tests that only assert grant/authorization
///      wiring and never mint through it.
contract MockMinterV2 {}

/// @dev Fixed-answer seed source, used only to prove seedSource passes
///      through the factory into the collection at init. Fallback read
///      behavior (tokenSeed resolution) is exercised by the seed test suite,
///      not here.
contract StubSeedSourceV2 is ISeedSourceV2 {
    bytes32 internal immutable answer;

    constructor(bytes32 answer_) {
        answer = answer_;
    }

    function seedOf(address, uint256) external view override returns (bytes32) {
        return answer;
    }
}

/// @dev A payable recipient whose receive() always reverts. Proves pull
///      payment isolates a hostile payoutRecipient: it cannot block a mint
///      that credits it, but its own withdraw() call fails since the
///      transfer to it reverts.
contract RevertingReceiverV2 {
    receive() external payable {
        revert("RevertingReceiverV2: refuses ETH");
    }
}
