// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeploySurfaceV2} from "../../../script/DeploySurfaceV2.s.sol";
import {SurfaceFactoryV2, SaleConfig} from "../../../src/surface/v2/SurfaceFactoryV2.sol";
import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";
import {FixedPriceMinterV2} from "../../../src/surface/v2/minters/FixedPriceMinterV2.sol";

/// @notice Exercises DeploySurfaceV2.s.sol end to end: the postflight
///         assertions inside run() itself, then one createSurface + mint
///         through the freshly deployed factory. Two variants:
///
///         - test_LocalChain_* runs against chain id 31337 with no RPC, so it
///           always runs under a plain `forge test`.
///         - test_MainnetFork_* forks mainnet to prove the script also passes
///           its chain-specific postflight (the deployer check, catalog
///           reuse) against real mainnet state. Gated the same way as
///           test/surface/SurfaceMainnetDeployment.t.sol: set
///           RUN_MAINNET_FORK_TESTS=true and MAINNET_RPC_URL to run it.
contract DeploySurfaceV2Test is Test {
    // Mirrors deployments.mainnet.json (chainId 1): the live Catalog public
    // good this script reuses on a mainnet fork, and the deployer whose
    // check the script enforces on chain id 1.
    address internal constant MAINNET_CATALOG = 0x467a9c39e03C595EC3075D856f19C7386b6b915d;
    address internal constant MAINNET_DEPLOYER = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;

    function setUp() public {
        // Only this test's own scratch files, never a real deployment record
        // that may already sit in deployments/ from a prior anvil/sepolia run.
        if (vm.isFile("deployments/31337-test.json")) vm.removeFile("deployments/31337-test.json");
        if (vm.isFile("deployments/1-test.json")) vm.removeFile("deployments/1-test.json");
    }

    function test_LocalChain_DeployAndE2EMint() public {
        vm.chainId(31337);
        string memory path = "deployments/31337-test.json";
        vm.setEnv("DEPLOY_RECORD_PATH", path);
        vm.setEnv("LAND_PAUSED", "false");
        vm.setEnv("CATALOG", "");
        vm.setEnv("RENDER_ASSETS", "");
        vm.setEnv("DEFAULT_RENDERER", "");
        vm.setEnv("DEPLOYER", "");

        DeploySurfaceV2 deployer = new DeploySurfaceV2();
        DeploySurfaceV2.Deployment memory d = deployer.run();

        assertGt(d.surfaceFactoryV2.code.length, 0, "factory has no code");
        assertGt(d.catalog.code.length, 0, "catalog has no code (local chain deploys one)");
        assertTrue(vm.isFile(path), "record was not written");

        SurfaceFactoryV2 factory = SurfaceFactoryV2(d.surfaceFactoryV2);
        assertFalse(factory.paused(), "factory should land unpaused (LAND_PAUSED=false)");

        _mintThroughFreshFactory(factory, d.defaultRenderer);
    }

    function test_MainnetFork_DeployPostflight() public {
        if (!vm.envOr("RUN_MAINNET_FORK_TESTS", false)) {
            emit log("skipping mainnet fork deploy test: set RUN_MAINNET_FORK_TESTS=true to run");
            vm.skip(true);
            return;
        }
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            revert("MAINNET_RPC_URL required when RUN_MAINNET_FORK_TESTS=true");
        }
        vm.createSelectFork(rpc);

        string memory path = "deployments/1-test.json";
        vm.setEnv("DEPLOY_RECORD_PATH", path);
        vm.setEnv("LAND_PAUSED", "true");
        vm.setEnv("CATALOG", vm.toString(MAINNET_CATALOG));
        vm.setEnv("RENDER_ASSETS", "");
        vm.setEnv("DEFAULT_RENDERER", "");
        vm.setEnv("DEPLOYER", vm.toString(MAINNET_DEPLOYER));

        vm.startPrank(MAINNET_DEPLOYER, MAINNET_DEPLOYER);
        DeploySurfaceV2 deployer = new DeploySurfaceV2();
        DeploySurfaceV2.Deployment memory d = deployer.run();
        vm.stopPrank();

        assertEq(d.catalog, MAINNET_CATALOG, "should reuse the live mainnet Catalog");
        assertGt(d.surfaceFactoryV2.code.length, 0, "factory has no code");
        assertTrue(SurfaceFactoryV2(d.surfaceFactoryV2).paused(), "factory should land paused");
        assertEq(SurfaceFactoryV2(d.surfaceFactoryV2).deployer(), MAINNET_DEPLOYER, "deployer mismatch");
    }

    function _mintThroughFreshFactory(SurfaceFactoryV2 factory, address renderer) internal {
        address artist = makeAddr("artist");
        SurfaceConfig memory cfg = SurfaceConfig({
            supplyCap: 0,
            royaltyBps: 0,
            royaltyReceiver: address(0),
            renderer: renderer,
            rendererLocked: false,
            supplyLocked: false
        });
        SaleConfig memory sale = SaleConfig({
            price: 0.01 ether,
            mintStart: 0,
            mintEnd: 0,
            payoutRecipient: address(0),
            maxMints: 0,
            allowlistRoot: bytes32(0),
            walletCap: 0
        });

        (address collection, address minter) =
            factory.createSurface("Test Surface", "TST", artist, cfg, sale, new address[](0), address(0));

        assertTrue(factory.isSurface(collection), "collection not recorded by the factory");

        address collector = makeAddr("collector");
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        FixedPriceMinterV2(minter).mint{value: 0.01 ether}(1);

        SurfaceV2 token = SurfaceV2(collection);
        assertEq(token.ownerOf(1), collector, "mint did not land at the collector");
        assertEq(token.totalSupply(), 1, "collection should report one mint");
    }
}
