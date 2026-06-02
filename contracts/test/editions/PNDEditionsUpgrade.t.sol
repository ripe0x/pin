// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {PNDEditionsBase} from "./PNDEditionsBase.sol";
import {PNDEditionsV2Mock} from "./EditionsMocks.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {ProjectMode} from "../../src/editions/PNDEditionsTypes.sol";

contract PNDEditionsUpgradeTest is PNDEditionsBase {
    // ── immutable clone: no upgrade path ──────────────────────────────────────

    function test_immutable_cannotUpgrade() public {
        PNDEditions p = _project(ProjectMode.ImmutableClone);
        assertFalse(p.isUpgradeable());
        PNDEditionsV2Mock v2 = new PNDEditionsV2Mock();
        vm.expectRevert(); // UUPSUnauthorizedCallContext on a 1167 clone
        vm.prank(artist);
        p.upgradeToAndCall(address(v2), "");
    }

    function test_immutable_cannotSeal() public {
        PNDEditions p = _project(ProjectMode.ImmutableClone);
        vm.expectRevert(bytes("PND: not upgradeable"));
        vm.prank(artist);
        p.seal();
    }

    // ── upgradeable proxy: opt-in ───────────────────────────────────────────────

    function test_upgradeable_ownerCanUpgradeAndStatePersists() public {
        PNDEditions p = _project(ProjectMode.Upgradeable);
        assertTrue(p.isUpgradeable());

        uint256 id = _createRelease(p, _freeReleaseConfig());
        vm.prank(collector);
        p.mint(id, 2, address(0), "");

        PNDEditionsV2Mock v2 = new PNDEditionsV2Mock();
        vm.prank(artist);
        p.upgradeToAndCall(address(v2), "");

        // new behavior available, old state preserved
        assertEq(PNDEditionsV2Mock(address(p)).version(), 2);
        assertEq(p.ownerOf(1), collector);
        assertEq(p.balanceOf(collector), 2);
        assertEq(p.totalReleases(), 1);
        assertEq(p.mintMarkOf(2).indexInRelease, 1);
    }

    function test_upgradeable_nonOwnerCannotUpgrade() public {
        PNDEditions p = _project(ProjectMode.Upgradeable);
        PNDEditionsV2Mock v2 = new PNDEditionsV2Mock();
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.upgradeToAndCall(address(v2), "");
    }

    function test_upgradeable_sealStopsUpgrades() public {
        PNDEditions p = _project(ProjectMode.Upgradeable);
        vm.prank(artist);
        p.seal();
        assertFalse(p.isUpgradeable());
        assertTrue(p.isSealed());

        PNDEditionsV2Mock v2 = new PNDEditionsV2Mock();
        vm.expectRevert(bytes("PND: not upgradeable"));
        vm.prank(artist);
        p.upgradeToAndCall(address(v2), "");
    }

    function test_upgradeable_sealOnlyOwner() public {
        PNDEditions p = _project(ProjectMode.Upgradeable);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.seal();
    }
}
