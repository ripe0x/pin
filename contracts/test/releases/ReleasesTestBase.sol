// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Release} from "../../src/releases/Release.sol";
import {ReleaseFactory} from "../../src/releases/ReleaseFactory.sol";
import {GateMode, ReleaseParams} from "../../src/releases/IRelease.sol";

/// @notice Shared fixture: a factory with the planned mainnet constants and
///         a params builder tests tweak per case.
abstract contract ReleasesTestBase is Test {
    uint256 internal constant MAX_SURFACE_FEE = 0.002 ether;
    uint256 internal constant SURFACE_FEE = 0.0005 ether;
    uint256 internal constant PRICE = 0.01 ether;

    // A realistic clock; foundry's default timestamp of 1 hides
    // window-boundary bugs.
    uint64 internal constant T0 = 1_780_000_000;

    address internal pnd = makeAddr("pnd"); // factory owner + PND's surface
    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal other = makeAddr("other");
    address internal surface = makeAddr("surface");

    ReleaseFactory internal factory;

    function setUp() public virtual {
        vm.warp(T0);
        factory = new ReleaseFactory(pnd, MAX_SURFACE_FEE, SURFACE_FEE);
        vm.deal(collector, 1_000 ether);
        vm.deal(other, 1_000 ether);
        vm.deal(artist, 10 ether);
    }

    /// @notice A priced, ungated, uncapped 3-day release starting now.
    function defaultParams() internal view returns (ReleaseParams memory p) {
        p = ReleaseParams({
            name: "Test Release",
            symbol: "TEST",
            price: PRICE,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 3 days),
            maxSupply: 0,
            gateToken: address(0),
            gateMode: GateMode.NONE,
            payout: address(0),
            royaltyReceiver: address(0),
            royaltyBps: 500,
            uri: "ipfs://meta.json",
            uriPerToken: false,
            renderer: address(0),
            contractURI: "ipfs://contract.json"
        });
    }

    function createRelease(ReleaseParams memory p) internal returns (Release) {
        vm.prank(artist);
        return Release(factory.createRelease(p));
    }

    function createDefault() internal returns (Release) {
        return createRelease(defaultParams());
    }

    /// @dev Exact value owed for a mint of `quantity` on release `r`
    ///      through `surface_`.
    function costOf(Release r, uint256 quantity, address surface_)
        internal
        view
        returns (uint256)
    {
        uint256 fee = (r.price() == 0 || surface_ == address(0))
            ? 0
            : r.surfaceFee() * quantity;
        return r.price() * quantity + fee;
    }
}
