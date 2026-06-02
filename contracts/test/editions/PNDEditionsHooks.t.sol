// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {PNDEditionsBase} from "./PNDEditionsBase.sol";
import {MockMintHook} from "./EditionsMocks.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";

contract PNDEditionsHooksTest is PNDEditionsBase {
    MockMintHook internal hook;

    function setUp() public override {
        super.setUp();
        hook = new MockMintHook();
    }

    function test_hook_calledBeforeAndAfter() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(artist);
        p.setProjectMintHook(address(hook));
        assertEq(p.mintHookOf(id), address(hook));

        vm.prank(collector);
        p.mint(id, 3, surface, bytes("payload"));

        assertEq(hook.beforeCount(), 1);
        assertEq(hook.afterCount(), 1);
        assertEq(hook.lastMinter(), collector);
        assertEq(hook.lastFirstTokenId(), 1);
        assertEq(hook.lastQuantity(), 3);
        assertEq(hook.lastSurface(), surface);
        // afterMint recorded the custom data keyed by firstTokenId
        assertEq(hook.recordedData(1), bytes("payload"));
    }

    function test_hook_gatesMintOnWrongSelector() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(artist);
        p.setProjectMintHook(address(hook));

        hook.setAllow(false);
        vm.expectRevert(bytes("PND: hook rejected"));
        vm.prank(collector);
        p.mint(id, 1, address(0), "");
    }

    function test_hook_revertBubblesUp() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(artist);
        p.setProjectMintHook(address(hook));

        hook.setRevertBefore(true);
        vm.expectRevert(bytes("hook: revert"));
        vm.prank(collector);
        p.mint(id, 1, address(0), "");
    }

    function test_hook_releaseOverrideBeatsProject() public {
        PNDEditions p = _immutableProject();
        uint256 id = _createRelease(p, _freeReleaseConfig());
        MockMintHook releaseHook = new MockMintHook();

        vm.prank(artist);
        p.setProjectMintHook(address(hook));
        vm.prank(artist);
        p.setReleaseMintHook(id, address(releaseHook));
        assertEq(p.mintHookOf(id), address(releaseHook));

        vm.prank(collector);
        p.mint(id, 1, address(0), "");
        assertEq(releaseHook.beforeCount(), 1);
        assertEq(hook.beforeCount(), 0); // project hook not used for this release
    }

    function test_hook_onlyOwnerCanSet() public {
        PNDEditions p = _immutableProject();
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.setProjectMintHook(address(hook));
    }
}
