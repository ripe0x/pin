// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeploySurfaceV2} from "../../../script/DeploySurfaceV2.s.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {Launcher} from "../../../src/surface/v2/Launcher.sol";
import {MockRenderer} from "../mocks/SurfaceMocks.sol";

/// @notice Exercises DeploySurfaceV2.s.sol against every guard it enforces:
///         the chain allowlist, the mainnet deployer, the mainnet default
///         referrer, the DEPLOYER env check and the pause flag, then a full
///         launch and mint through a fresh deploy. Every run asserts the
///         tracked records are untouched: the script writes nothing (the
///         record comes from broadcast receipts in script/deploy.sh).
///
///         The mainnet-fork variant is gated like
///         test/surface/SurfaceMainnetDeployment.t.sol: set
///         RUN_MAINNET_FORK_TESTS=true and MAINNET_RPC_URL to run it.
contract DeploySurfaceV2Test is Test {
    address internal constant MAINNET_DEPLOYER = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;

    DeploySurfaceV2 internal script;
    address internal referrer = makeAddr("pnd");
    string internal mainnetBefore;
    string internal sepoliaBefore;

    function setUp() public {
        script = new DeploySurfaceV2();
        mainnetBefore = vm.readFile("deployments.mainnet.json");
        sepoliaBefore = vm.readFile("deployments.sepolia.json");
    }

    address internal signer = makeAddr("signer");

    function _cfg() internal view returns (DeploySurfaceV2.Config memory) {
        return DeploySurfaceV2.Config({expectedDeployer: address(0), defaultReferrer: referrer, landPaused: false});
    }

    function _assertRecordsUntouched() internal view {
        assertEq(vm.readFile("deployments.mainnet.json"), mainnetBefore, "mainnet record changed");
        assertEq(vm.readFile("deployments.sepolia.json"), sepoliaBefore, "sepolia record changed");
    }

    function test_LocalChain_DeployLaunchMint() public {
        vm.chainId(31337);
        DeploySurfaceV2.Deployment memory d = script.runWith(signer, _cfg());

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
        _assertRecordsUntouched();
    }

    function test_Wiring() public {
        vm.chainId(31337);
        DeploySurfaceV2.Deployment memory d = script.runWith(signer, _cfg());
        assertEq(CloneFactory(d.surfaceFactoryV2).implementation(), d.surfaceImplV2);
        assertEq(CloneFactory(d.saleFactoryV2).implementation(), d.saleImplV2);
        assertEq(CloneFactory(d.surfaceFactoryV2).deployer(), signer);
        assertEq(CloneFactory(d.saleFactoryV2).deployer(), signer);
        assertEq(Launcher(d.launcherV2).owner(), signer);
        assertEq(Launcher(d.launcherV2).defaultReferrer(), referrer);
        assertGt(d.allowlistGate.code.length, 0);
    }

    /// @dev The only test that touches the process env, so no parallel test
    ///      can observe it half-set.
    function test_EnvConfig_DefaultsAndRun() public {
        vm.chainId(31337);
        vm.setEnv("DEPLOYER", "");
        vm.setEnv("DEFAULT_REFERRER", "");
        vm.setEnv("LAND_PAUSED", "");
        DeploySurfaceV2.Config memory c = script.readConfig();
        assertEq(c.expectedDeployer, address(0));
        assertEq(c.defaultReferrer, address(0));
        assertTrue(c.landPaused, "lands paused by default");

        vm.setEnv("DEFAULT_REFERRER", vm.toString(referrer));
        vm.setEnv("LAND_PAUSED", "false");
        c = script.readConfig();
        assertEq(c.defaultReferrer, referrer);
        assertFalse(c.landPaused);

        DeploySurfaceV2.Deployment memory d = script.run();
        assertEq(Launcher(d.launcherV2).defaultReferrer(), referrer);
        assertFalse(CloneFactory(d.surfaceFactoryV2).paused());
        _assertRecordsUntouched();
    }

    function test_LandsPausedWhenAsked() public {
        vm.chainId(31337);
        DeploySurfaceV2.Config memory c = _cfg();
        c.landPaused = true;
        DeploySurfaceV2.Deployment memory d = script.runWith(signer, c);
        assertTrue(CloneFactory(d.surfaceFactoryV2).paused());
        assertTrue(CloneFactory(d.saleFactoryV2).paused());
    }

    function test_LandsUnpausedWhenAsked() public {
        vm.chainId(31337);
        DeploySurfaceV2.Deployment memory d = script.runWith(signer, _cfg());
        assertFalse(CloneFactory(d.surfaceFactoryV2).paused());
        assertFalse(CloneFactory(d.saleFactoryV2).paused());
    }

    function test_Guard_UnsupportedChain() public {
        vm.chainId(5);
        vm.expectRevert(abi.encodeWithSelector(DeploySurfaceV2.UnsupportedChain.selector, 5));
        script.runWith(signer, _cfg());
    }

    function test_Guard_MainnetRequiresDefaultReferrer() public {
        vm.chainId(1);
        DeploySurfaceV2.Config memory c = _cfg();
        c.defaultReferrer = address(0);
        vm.expectRevert(DeploySurfaceV2.DefaultReferrerRequired.selector);
        script.runWith(MAINNET_DEPLOYER, c);
    }

    function test_Guard_MainnetRequiresProtocolDeployer() public {
        vm.chainId(1);
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(DeploySurfaceV2.DeployerMismatch.selector, MAINNET_DEPLOYER, other));
        script.runWith(other, _cfg());
    }

    function test_Guard_MainnetPassesWithBoth() public {
        vm.chainId(1);
        DeploySurfaceV2.Config memory c = _cfg();
        c.landPaused = true;
        DeploySurfaceV2.Deployment memory d = script.runWith(MAINNET_DEPLOYER, c);
        assertEq(Launcher(d.launcherV2).owner(), MAINNET_DEPLOYER);
        assertTrue(CloneFactory(d.surfaceFactoryV2).paused());
        _assertRecordsUntouched();
    }

    function test_Guard_DeployerEnvMismatch() public {
        vm.chainId(11155111);
        address expected = makeAddr("expected");
        address actual = makeAddr("actual");
        DeploySurfaceV2.Config memory c = _cfg();
        c.expectedDeployer = expected;
        vm.expectRevert(abi.encodeWithSelector(DeploySurfaceV2.DeployerMismatch.selector, expected, actual));
        script.runWith(actual, c);
    }

    function test_Guard_DeployerEnvMatch() public {
        vm.chainId(11155111);
        address expected = makeAddr("expected");
        DeploySurfaceV2.Config memory c = _cfg();
        c.expectedDeployer = expected;
        script.runWith(expected, c);
        _assertRecordsUntouched();
    }

    function test_Guard_SepoliaAllowsZeroReferrer() public {
        vm.chainId(11155111);
        DeploySurfaceV2.Config memory c = _cfg();
        c.defaultReferrer = address(0);
        DeploySurfaceV2.Deployment memory d = script.runWith(signer, c);
        assertEq(Launcher(d.launcherV2).defaultReferrer(), address(0));
    }

    function test_MainnetFork_DeployPostflight() public {
        if (!vm.envOr("RUN_MAINNET_FORK_TESTS", false)) {
            emit log("skipping mainnet fork deploy test: set RUN_MAINNET_FORK_TESTS=true to run");
            vm.skip(true);
            return;
        }
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) revert("MAINNET_RPC_URL required when RUN_MAINNET_FORK_TESTS=true");
        vm.createSelectFork(rpc);
        script = new DeploySurfaceV2(); // the setUp instance lives on the pre-fork state
        vm.deal(MAINNET_DEPLOYER, 10 ether);
        DeploySurfaceV2.Config memory c = _cfg();
        c.landPaused = true;
        c.expectedDeployer = MAINNET_DEPLOYER;
        DeploySurfaceV2.Deployment memory d = script.runWith(MAINNET_DEPLOYER, c);
        assertTrue(CloneFactory(d.surfaceFactoryV2).paused());
        assertEq(CloneFactory(d.surfaceFactoryV2).deployer(), MAINNET_DEPLOYER);
        _assertRecordsUntouched();
    }
}
