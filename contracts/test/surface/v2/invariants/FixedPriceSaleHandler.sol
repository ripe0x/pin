// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {FixedPriceSale} from "../../../../src/surface/v2/FixedPriceSale.sol";
import {Surface} from "../../../../src/surface/v2/Surface.sol";

/// @dev Mints through both entrypoints with assorted referrers, withdraws
///      through both payout paths, and changes price and payout recipient.
contract FixedPriceSaleHandler is Test {
    FixedPriceSale public sale;
    address public owner;
    address[5] public actors;

    Surface public token;
    bool public closed;
    bool public renounced;
    uint256 public mintedAtClose;
    uint256 public priceAtRenounce;

    uint256 public ghostPaidIn;
    uint256 public ghostWithdrawn;
    mapping(address => uint256) public credited;
    mapping(address => uint256) public paidOut;

    constructor(FixedPriceSale sale_, address owner_, address pnd) {
        sale = sale_;
        token = Surface(sale_.collection());
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
        try sale.mint{value: paid}(quantity) {
            _credit(paid, referrer);
        } catch {}
    }

    function mintWithReferral(uint256 payerSeed, uint256 toSeed, uint256 refSeed, uint256 quantity) external {
        quantity = bound(quantity, 1, 4);
        address payer = actors[payerSeed % 4];
        address referrer = actors[refSeed % 5];
        uint256 paid = sale.price() * quantity;
        vm.prank(payer);
        try sale.mintWithReferral{value: paid}(actors[toSeed % 4], quantity, referrer, "") {
            _credit(paid, referrer);
        } catch {}
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
        try sale.setPrice(price) {} catch {}
    }

    function setPayoutRecipient(uint256 seed) external {
        vm.prank(owner);
        try sale.setPayoutRecipient(actors[seed % 4]) {} catch {}
    }

    function setWalletCap(uint256 cap) external {
        cap = bound(cap, 0, 12);
        vm.prank(owner);
        try sale.setWalletCap(cap) {} catch {}
    }

    /// @dev Rare: closing or renouncing ends minting for the rest of the run,
    ///      so payouts must still balance afterwards.
    function close(uint256 chance) external {
        if (chance % 25 != 0) return;
        vm.prank(owner);
        try sale.close() {
            if (!closed) mintedAtClose = sale.totalMinted();
            closed = true;
        } catch {}
    }

    function renounce(uint256 chance) external {
        if (chance % 25 != 0 || renounced) return;
        vm.prank(owner);
        token.renounceOwnership();
        renounced = true;
        priceAtRenounce = sale.price();
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
