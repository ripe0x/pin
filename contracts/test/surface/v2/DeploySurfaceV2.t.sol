// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeploySurfaceV2} from "../../../script/DeploySurfaceV2.s.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {Launcher} from "../../../src/surface/v2/Launcher.sol";
import {MockRenderer} from "../mocks/SurfaceMocks.sol";

/// @notice Exercises DeploySurfaceV2.s.sol on a local chain: the postflight
///         assertions inside run(), then one launch and mint through the
///         freshly deployed system.
contract DeploySurfaceV2Test is Test {
    function test_LocalChain_DeployLaunchMint() public {
        vm.chainId(31337);
        vm.setEnv("LAND_PAUSED", "false");
        vm.setEnv("DEPLOYER", "");
        address referrer = makeAddr("pnd");
        vm.setEnv("DEFAULT_REFERRER", vm.toString(referrer));

        DeploySurfaceV2.Deployment memory d = new DeploySurfaceV2().run();

        address artist = makeAddr("artist");
        (address collection, address sale) = Launcher(d.launcherV2)
            .launch(
                Launcher.TokenParams("Test", "TST", artist, address(new MockRenderer()), 0, 500, address(0)),
                Launcher.SaleParams(0.01 ether, 0, 0, 0, 0, address(0), address(0))
            );
        assertTrue(CloneFactory(d.surfaceFactoryV2).isInstance(collection));
        assertTrue(CloneFactory(d.saleFactoryV2).isInstance(sale));

        address collector = makeAddr("collector");
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        FixedPriceSale(sale).mint{value: 0.01 ether}(1);

        assertEq(Surface(collection).ownerOf(1), collector);
        assertEq(FixedPriceSale(sale).pendingWithdrawal(referrer), 0.0005 ether);
        assertEq(FixedPriceSale(sale).pendingWithdrawal(artist), 0.0095 ether);
    }
}
