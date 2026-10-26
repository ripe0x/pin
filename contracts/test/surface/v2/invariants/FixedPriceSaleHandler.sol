// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {FixedPriceSale} from "../../../../src/surface/v2/FixedPriceSale.sol";

/// @dev Mints through both entrypoints with assorted referrers, withdraws
///      through both payout paths, and changes price and payout recipient.
contract FixedPriceSaleHandler is Test {
    FixedPriceSale public sale;
    address public owner;
    address[5] public actors;

    uint256 public ghostPaidIn;
    uint256 public ghostWithdrawn;
    mapping(address => uint256) public credited;
    mapping(address => uint256) public paidOut;

    constructor(FixedPriceSale sale_, address owner_, address pnd) {
        sale = sale_;
        owner = owner_;
        actors = [owner_, pnd, makeAddr("a2"), makeAddr("a3"), address(0)];
        for (uint256 i = 0; i < 4; i++) {
            vm.deal(actors[i], 1_000 ether);
        }
    }

    function _credit(uint256 paid, address referrer) internal {
        uint256 referral = referrer == address(0) ? 0 : (paid * 500) / 10_000;
        credited[referrer] += referral;
        credited[sale.payoutRecipient()] += paid - referral;
        ghostPaidIn += paid;
    }

    function mint(uint256 payerSeed, uint256 quantity) external {
        quantity = bound(quantity, 1, 4);
        address payer = actors[payerSeed % 4];
        uint256 paid = sale.price() * quantity;
        address referrer = sale.defaultReferrer();
        vm.prank(payer);
        sale.mint{value: paid}(quantity);
        _credit(paid, referrer);
    }

    function mintWithReferral(uint256 payerSeed, uint256 toSeed, uint256 refSeed, uint256 quantity) external {
        quantity = bound(quantity, 1, 4);
        address payer = actors[payerSeed % 4];
        address referrer = actors[refSeed % 5];
        uint256 paid = sale.price() * quantity;
        vm.prank(payer);
        sale.mintWithReferral{value: paid}(actors[toSeed % 4], quantity, referrer, "");
        _credit(paid, referrer);
    }

    function withdraw(uint256 seed) external {
        address account = actors[seed % 4];
        uint256 owed = sale.pendingWithdrawal(account);
        if (owed == 0) return;
        sale.withdraw(account);
        ghostWithdrawn += owed;
        paidOut[account] += owed;
    }

    function withdrawTo(uint256 seed, uint256 toSeed) external {
        address account = actors[seed % 4];
        uint256 owed = sale.pendingWithdrawal(account);
        if (owed == 0) return;
        vm.prank(account);
        sale.withdrawTo(actors[toSeed % 4]);
        ghostWithdrawn += owed;
        paidOut[account] += owed;
    }

    function setPrice(uint256 price) external {
        price = bound(price, 0, 3 ether);
        vm.prank(owner);
        sale.setPrice(price);
    }

    function setPayoutRecipient(uint256 seed) external {
        vm.prank(owner);
        sale.setPayoutRecipient(actors[seed % 4]);
    }

    function pendingSum() external view returns (uint256 sum) {
        for (uint256 i = 0; i < 5; i++) {
            sum += sale.pendingWithdrawal(actors[i]);
        }
    }

    function actorCount() external pure returns (uint256) {
        return 5;
    }
}
