// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IPriceStrategy} from "../../../../src/surface/interfaces/IPriceStrategy.sol";

/// @dev Fixed answer regardless of arguments; stands in for a legitimate
///      dynamic-pricing module in tests that only need a strategy present.
contract MockFixedStrategy is IPriceStrategy {
    uint256 public answer;

    constructor(uint256 answer_) {
        answer = answer_;
    }

    function setAnswer(uint256 answer_) external {
        answer = answer_;
    }

    function priceOf(address, address, uint256) external view override returns (uint256) {
        return answer;
    }
}

/// @dev Always reverts. Proves a misbehaving strategy's revert bubbles out
///      of mint() rather than being swallowed.
contract RevertingStrategy is IPriceStrategy {
    function priceOf(address, address, uint256) external pure override returns (uint256) {
        revert("RevertingStrategy: always reverts");
    }
}

/// @dev Returns gasleft(), which strictly decreases across successive calls
///      within one transaction. Used to prove the minter reads the strategy
///      exactly once per mint(): if the required-for-the-msg.value-check
///      value and the required-for-settle value ever came from two separate
///      calls, the two numbers would differ and the sum of everything
///      accrued (excess + referral + payout) would no longer equal
///      msg.value. gasleft() is pure chain state, not storage, so it is
///      callable from a view function without violating the interface's
///      staticcall contract.
contract VaryingPriceStrategy is IPriceStrategy {
    function priceOf(address, address, uint256) external view override returns (uint256) {
        return gasleft();
    }
}

/// @dev A payable recipient whose receive() always reverts. Used to prove
///      pull payment isolates a hostile recipient: it cannot block a mint
///      that credits it, but its own withdraw() call fails since the
///      transfer to it reverts.
contract RevertingReceiver {
    receive() external payable {
        revert("RevertingReceiver: refuses ETH");
    }
}
