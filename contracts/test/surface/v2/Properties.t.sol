// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceV2Base} from "./SurfaceV2Base.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {ISurface} from "../../../src/surface/v2/interfaces/ISurface.sol";

/// @notice Arithmetic and addressing properties, fuzzed across the full input
///         range. (Written for halmos first; halmos 0.3.3 cannot deploy
///         contracts built on OZ's upgradeable Initializable, so they run
///         as fuzz tests: sampled, not proved.)
contract SurfaceV2PropertiesTest is SurfaceV2Base {
    Surface internal token;
    FixedPriceSale internal sale;

    function setUp() public override {
        super.setUp();
        (token, sale) = _launch();
    }

    /// @dev referral + payout == paid; referral is exactly 5% rounded down.
    function testFuzz_settlementSplit(uint96 price, uint8 quantity, address payer, address referrer) public {
        quantity = uint8(bound(quantity, 1, 5));
        vm.assume(payer != address(0) && payer.code.length == 0 && payer != address(token));
        vm.assume(referrer != artist);
        vm.prank(artist);
        sale.setPrice(price);
        uint256 paid = uint256(price) * quantity;
        vm.deal(payer, paid);
        vm.prank(payer);
        sale.mintWithReferral{value: paid}(payer, quantity, referrer, "");
        uint256 referral = referrer == address(0) ? 0 : (paid * 500) / 10_000;
        assertEq(sale.pendingWithdrawal(artist), paid - referral);
        if (referrer != address(0)) assertEq(sale.pendingWithdrawal(referrer), referral);
        assertEq(address(sale).balance, paid);
    }

    /// @dev royaltyInfo never reverts and never exceeds half the sale price.
    function testFuzz_royaltyBounded(uint16 bps, uint256 salePrice) public {
        bps = uint16(bound(bps, 0, 5000));
        vm.prank(artist);
        token.setRoyalty(bps, artist);
        (, uint256 amount) = token.royaltyInfo(1, salePrice);
        assertLe(amount, salePrice / 2);
        assertEq(amount, salePrice / 10_000 * bps + (salePrice % 10_000) * bps / 10_000);
    }

    /// @dev A nonzero cap can never be set below the lifetime mint count.
    function testFuzz_supplyCapFloor(uint8 minted, uint256 cap) public {
        minted = uint8(bound(minted, 1, 20));
        _mint(sale, collector, minted);
        vm.prank(artist);
        if (cap != 0 && cap < minted) {
            vm.expectRevert(abi.encodeWithSelector(ISurface.BadSupplyCap.selector, uint256(minted), cap));
            token.setSupplyCap(cap);
        } else {
            token.setSupplyCap(cap);
            assertEq(token.supplyCap(), cap);
        }
    }

    /// @dev Addresses are namespaced by caller: two callers never collide,
    ///      and a create never collides with a createDeterministic.
    function testFuzz_predictNamespaced(address a, address b, bytes32 s1, bytes32 s2) public view {
        vm.assume(a != b);
        assertTrue(saleFactory.predict(s1, a) != saleFactory.predict(s2, b));
        assertTrue(saleFactory.predictCreate(a) != saleFactory.predictCreate(b));
        assertTrue(saleFactory.predict(s1, a) != saleFactory.predictCreate(b));
        assertTrue(saleFactory.predict(s1, a) != saleFactory.predictCreate(a));
    }
}
