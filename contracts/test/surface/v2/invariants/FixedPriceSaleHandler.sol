// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {FixedPriceSale} from "../../../../src/surface/v2/FixedPriceSale.sol";
import {Surface} from "../../../../src/surface/v2/Surface.sol";
import {IMinter} from "../../../../src/surface/v2/interfaces/IMinter.sol";

/// @dev Drives both mint and payout paths, mutable limits, closure, and
///      renounce while accounting for every successful payment.
contract FixedPriceSaleHandler is Test {
    FixedPriceSale public sale;
    Surface public token;
    address public owner;
    address[5] public actors;

    uint256 public ghostPaidIn;
    uint256 public ghostWithdrawn;
    uint256 public ghostSuccessfulMints;
    uint256 public ghostCapRejections;
    uint256 public ghostWithdrawalCalls;
    uint256 public ghostCloses;
    uint256 public ghostRenounces;
    uint256 public mintedAtClose;
    uint256 public priceAtRenounce;
    mapping(address => uint256) public credited;
    mapping(address => uint256) public paidOut;

    constructor(FixedPriceSale sale_, Surface token_, address owner_, address pnd) {
        sale = sale_;
        token = token_;
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
        if (!_canMint(payer, quantity)) return;
        uint256 paid = sale.price() * quantity;
        address referrer = sale.defaultReferrer();
        vm.prank(payer);
        sale.mint{value: paid}(quantity);
        _credit(paid, referrer);
        ghostSuccessfulMints++;
    }

    function mintWithReferral(uint256 payerSeed, uint256 toSeed, uint256 refSeed, uint256 quantity) external {
        quantity = bound(quantity, 1, 4);
        address payer = actors[payerSeed % 4];
        address to = actors[toSeed % 4];
        if (!_canMint(to, quantity)) return;
        address referrer = actors[refSeed % 5];
        uint256 paid = sale.price() * quantity;
        vm.prank(payer);
        sale.mintWithReferral{value: paid}(to, quantity, referrer, "");
        _credit(paid, referrer);
        ghostSuccessfulMints++;
    }

    function _canMint(address to, uint256 quantity) internal view returns (bool) {
        if (sale.closed()) return false;
        uint256 maxMints = sale.maxMints();
        if (maxMints != 0 && sale.totalMinted() + quantity > maxMints) return false;
        uint256 walletCap = sale.walletCap();
        if (walletCap != 0 && sale.mintedBy(to) + quantity > walletCap) return false;
        uint256 supplyCap = token.supplyCap();
        (,,,,, uint256 mintedEver) = token.config();
        return supplyCap == 0 || mintedEver + quantity <= supplyCap;
    }

    /// @dev An exact max-mint boundary probe; its rejection must precede
    ///      wallet and payment checks.
    function probeMaxMintsCap() external {
        if (token.owner() != owner || sale.closed() || sale.totalMinted() == 0) return;
        uint256 minted = sale.totalMinted();
        uint256 price = sale.price();
        vm.prank(owner);
        sale.setMaxMints(minted);
        vm.expectRevert(abi.encodeWithSelector(IMinter.MaxMintsExceeded.selector, minted, minted + 1));
        vm.prank(actors[2]);
        sale.mint{value: price}(1);
        ghostCapRejections++;
    }

    function withdraw(uint256 seed) external {
        address account = actors[seed % 4];
        uint256 owed = sale.pendingWithdrawal(account);
        if (owed == 0) return;
        sale.withdraw(account);
        ghostWithdrawn += owed;
        paidOut[account] += owed;
        ghostWithdrawalCalls++;
    }

    function withdrawTo(uint256 seed, uint256 toSeed) external {
        address account = actors[seed % 4];
        uint256 owed = sale.pendingWithdrawal(account);
        if (owed == 0) return;
        vm.prank(account);
        sale.withdrawTo(actors[toSeed % 4]);
        ghostWithdrawn += owed;
        paidOut[account] += owed;
        ghostWithdrawalCalls++;
    }

    function setPrice(uint256 price) external {
        if (token.owner() != owner) return;
        price = bound(price, 0, 3 ether);
        vm.prank(owner);
        sale.setPrice(price);
    }

    function setPayoutRecipient(uint256 seed) external {
        if (token.owner() != owner) return;
        vm.prank(owner);
        sale.setPayoutRecipient(actors[seed % 4]);
    }

    function setMaxMints(uint256 headroom) external {
        if (token.owner() != owner) return;
        headroom = bound(headroom, 0, 8);
        uint256 nextMax = sale.totalMinted() + headroom;
        vm.prank(owner);
        sale.setMaxMints(nextMax);
    }

    function setWalletCap(uint256 cap) external {
        if (token.owner() != owner) return;
        cap = bound(cap, 0, 8);
        vm.prank(owner);
        sale.setWalletCap(cap);
    }

    function close(uint256 chance) external {
        if (token.owner() != owner || sale.closed() || chance % 20 != 0) return;
        vm.prank(owner);
        sale.close();
        mintedAtClose = sale.totalMinted();
        ghostCloses++;
    }

    function renounce(uint256 chance) external {
        if (token.owner() != owner || chance % 20 != 0) return;
        vm.prank(owner);
        token.renounceOwnership();
        priceAtRenounce = sale.price();
        ghostRenounces++;
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
