// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {PNDEditionsBase} from "./PNDEditionsBase.sol";
import {MockMintHook} from "./EditionsMocks.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {EditionConfig, EditionKind} from "../../src/editions/PNDEditionsTypes.sol";

contract PNDEditionsHooksTest is PNDEditionsBase {
    MockMintHook internal hook;

    function setUp() public override {
        super.setUp();
        hook = new MockMintHook();
    }

    function test_hook_calledBeforeAndAfter() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(artist);
        p.setMintHook(address(hook));
        assertEq(p.mintHook(), address(hook));

        vm.prank(collector);
        p.mintWithRewards(3, surface, bytes("payload"));

        assertEq(hook.beforeCount(), 1);
        assertEq(hook.afterCount(), 1);
        assertEq(hook.lastMinter(), collector);
        assertEq(hook.lastFirstTokenId(), 1);
        assertEq(hook.lastQuantity(), 3);
        assertEq(hook.lastSurface(), surface);
        assertEq(hook.recordedData(1), bytes("payload"));
    }

    function test_hook_gatesMintOnWrongSelector() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(artist);
        p.setMintHook(address(hook));
        hook.setAllow(false);
        vm.expectRevert(bytes("PND: hook rejected"));
        vm.prank(collector);
        p.mint(1);
    }

    function test_hook_revertBubblesUp() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(artist);
        p.setMintHook(address(hook));
        hook.setRevertBefore(true);
        vm.expectRevert(bytes("hook: revert"));
        vm.prank(collector);
        p.mint(1);
    }

    function test_hook_configuredAtDeploy() public {
        // A hook can be wired in the EditionConfig at createEdition time.
        MockMintHook deployHook = new MockMintHook();
        EditionConfig memory cfg;
        cfg.artworkURI = "ipfs://Qm";
        cfg.kind = EditionKind.Standalone;
        cfg.mintHook = address(deployHook);
        PNDEditions p = _edition(cfg);
        assertEq(p.mintHook(), address(deployHook));

        vm.prank(collector);
        p.mint(1);
        assertEq(deployHook.beforeCount(), 1);
        assertEq(deployHook.afterCount(), 1);
    }

    function test_hook_onlyOwnerCanSet() public {
        PNDEditions p = _edition(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.setMintHook(address(hook));
    }
}
