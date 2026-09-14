// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceFactoryV2} from "../../../src/surface/v2/SurfaceFactoryV2.sol";
import {FixedPriceMinterV2} from "../../../src/surface/v2/minters/FixedPriceMinterV2.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";

import {FixedPriceMinter, FixedPriceMinterInitParams} from "../../../src/surface/minters/FixedPriceMinter.sol";
import {IMinter} from "../../../src/surface/interfaces/IMinter.sol";
import {ISurfaceV2} from "../../../src/surface/v2/interfaces/ISurfaceV2.sol";

import {MockRenderer} from "../mocks/SurfaceMocks.sol";

/// @title SurfaceV2V1MinterCompatTest
/// @notice Proof that the v1 canonical minter (FixedPriceMinter) works
///         against a SurfaceV2 collection unmodified. FixedPriceMinter only
///         calls two things on its bound collection: ISurfaceAuth.owner/
///         isAdmin at initialize() and ISurface.mintTo(address,uint256) at
///         sale time, both of which SurfaceV2 implements with the identical
///         selector and return shape.
contract SurfaceV2V1MinterCompatTest is Test {
    SurfaceV2 internal impl;
    SurfaceFactoryV2 internal factory;
    SurfaceV2 internal collection;
    FixedPriceMinter internal minterImpl;
    FixedPriceMinter internal minter;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal referrer = makeAddr("referrer");

    uint256 internal constant PRICE = 0.01 ether;

    function setUp() public {
        impl = new SurfaceV2();
        factory = new SurfaceFactoryV2(
            address(impl), address(new FixedPriceMinterV2()), address(new MockRenderer()), address(0)
        );

        SurfaceConfig memory cfg;
        collection = SurfaceV2(
            factory.createSurfaceCustom(
                "V1 Minter On V2", "V1M2", artist, cfg, new address[](0), address(0), new address[](0), address(0)
            )
        );

        minterImpl = new FixedPriceMinter();
        minter = FixedPriceMinter(Clones.clone(address(minterImpl)));

        FixedPriceMinterInitParams memory p;
        p.collection = address(collection);
        p.price = PRICE;
        p.payoutRecipient = artist;
        vm.prank(artist);
        minter.initialize(p);

        vm.prank(artist);
        collection.setMinter(address(minter), true);
    }

    function test_v1Minter_sellsOnV2Collection() public {
        vm.deal(collector, PRICE);

        vm.expectEmit(true, true, false, true, address(collection));
        emit ISurfaceV2.Minted(address(minter), collector, 1, 1, 1);
        vm.expectEmit(true, true, true, true, address(minter));
        emit IMinter.Sold(collector, collector, address(0), 1, PRICE, 1);

        vm.prank(collector);
        minter.mint{value: PRICE}(1);

        assertEq(collection.ownerOf(1), collector, "token landed with the buyer");
        assertEq(collection.totalSupply(), 1, "one token minted");
    }

    /// @notice A referral purchase through the v1 minter still splits proceeds
    ///         correctly against a v2 collection: the referral share accrues
    ///         to the referrer and the remainder to the payout recipient, and
    ///         the mint lands the same as a direct purchase.
    function test_v1Minter_referralPurchase_paysReferrerAndArtist() public {
        vm.deal(collector, PRICE);
        uint256 referralCut = (PRICE * minter.referralShareBps()) / 10_000;
        uint256 artistCut = PRICE - referralCut;

        vm.prank(collector);
        minter.mint{value: PRICE}(collector, 1, referrer, "");

        assertEq(collection.ownerOf(1), collector, "token landed with the buyer");
        assertEq(minter.pendingWithdrawal(referrer), referralCut, "referral share accrues to the referrer");
        assertEq(minter.pendingWithdrawal(artist), artistCut, "remaining proceeds accrue to the payout recipient");
    }

    function test_v1Minter_payoutReachesArtist() public {
        vm.deal(collector, PRICE);
        vm.prank(collector);
        minter.mint{value: PRICE}(1);

        assertEq(minter.pendingWithdrawal(artist), PRICE, "sale proceeds accrue to the payout recipient");

        uint256 before = artist.balance;
        minter.withdraw(artist);
        assertEq(artist.balance - before, PRICE, "withdraw pays the artist the full sale amount");
    }
}
