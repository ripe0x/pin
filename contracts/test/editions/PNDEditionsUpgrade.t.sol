// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {PNDEditionsBase} from "./PNDEditionsBase.sol";
import {PNDEditionsV2Mock} from "./EditionsMocks.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";

contract PNDEditionsUpgradeTest is PNDEditionsBase {
    function test_editionsAreUpgradeableByDefault() public {
        PNDEditions p = _edition(_freeConfig());
        assertTrue(p.isUpgradeable());
        assertFalse(p.isSealed());
    }

    function test_ownerCanUpgradeAndStatePersists() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(2, address(0), "");

        PNDEditionsV2Mock v2 = new PNDEditionsV2Mock();
        vm.prank(artist);
        p.upgradeToAndCall(address(v2), "");

        assertEq(PNDEditionsV2Mock(address(p)).version(), 2);
        assertEq(p.ownerOf(1), collector);
        assertEq(p.balanceOf(collector), 2);
        assertEq(p.mintMarkOf(2).indexInEdition, 1);
    }

    function test_nonOwnerCannotUpgrade() public {
        PNDEditions p = _edition(_freeConfig());
        PNDEditionsV2Mock v2 = new PNDEditionsV2Mock();
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.upgradeToAndCall(address(v2), "");
    }

    function test_sealStopsUpgrades() public {
        PNDEditions p = _edition(_freeConfig());
        vm.prank(artist);
        p.seal();
        assertFalse(p.isUpgradeable());
        assertTrue(p.isSealed());

        PNDEditionsV2Mock v2 = new PNDEditionsV2Mock();
        vm.expectRevert(bytes("PND: sealed"));
        vm.prank(artist);
        p.upgradeToAndCall(address(v2), "");
    }

    function test_sealOnlyOwner() public {
        PNDEditions p = _edition(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.seal();
    }

    function test_doubleSealReverts() public {
        PNDEditions p = _edition(_freeConfig());
        vm.startPrank(artist);
        p.seal();
        vm.expectRevert(bytes("PND: already sealed"));
        p.seal();
        vm.stopPrank();
    }
}
