// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceV2Base} from "./SurfaceV2Base.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {ISurfaceV2} from "../../../src/surface/v2/interfaces/ISurfaceV2.sol";

/// @dev SurfaceV2's added self-custody guard: `_update` rejects any mint or
///      transfer landing a token at the collection's own address, since the
///      collection has no code path to move a token back out. See
///      docs/pnd-surface-v2-plan.md, "what v2 adds" item 1.
contract SurfaceV2TransferTest is SurfaceV2Base {
    function test_transferFrom_toSelf_reverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.SelfCustodyRejected.selector, 1));
        vm.prank(collector);
        c.transferFrom(collector, address(c), 1);

        // the token stays put: the revert did not partially apply
        assertEq(c.ownerOf(1), collector);
    }

    function test_safeTransferFrom_toSelf_reverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.SelfCustodyRejected.selector, 1));
        vm.prank(collector);
        c.safeTransferFrom(collector, address(c), 1);

        assertEq(c.ownerOf(1), collector);
    }

    function test_safeTransferFrom_withData_toSelf_reverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.SelfCustodyRejected.selector, 1));
        vm.prank(collector);
        c.safeTransferFrom(collector, address(c), 1, "");

        assertEq(c.ownerOf(1), collector);
    }

    /// @dev The guard runs through _update, which OZ's _mint routes through
    ///      too: a mint straight to the collection's own address is rejected
    ///      the same way a transfer to it is.
    function test_mintTo_selfAsRecipient_reverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);

        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.SelfCustodyRejected.selector, 1));
        c.mintTo(address(c), 1);
    }

    function test_mintToSeeded_selfAsRecipient_reverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);
        bytes32[] memory seeds = new bytes32[](1);

        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.SelfCustodyRejected.selector, 1));
        c.mintToSeeded(address(c), seeds);
    }

    // ── normal transfers, approvals, and approved-operator transfers ─────────

    function test_transfer_toOrdinaryAddress_unaffected() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.prank(collector);
        c.transferFrom(collector, stranger, 1);
        assertEq(c.ownerOf(1), stranger);
    }

    function test_approval_unaffected() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.prank(collector);
        c.approve(stranger, 1);
        assertEq(c.getApproved(1), stranger);
    }

    function test_approvedOperator_transfer_unaffected() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.prank(collector);
        c.approve(stranger, 1);
        vm.prank(stranger);
        c.transferFrom(collector, referrer, 1);
        assertEq(c.ownerOf(1), referrer);
    }

    function test_setApprovalForAll_operatorTransfer_unaffected() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 2);

        vm.prank(collector);
        c.setApprovalForAll(stranger, true);
        vm.prank(stranger);
        c.transferFrom(collector, referrer, 1);
        assertEq(c.ownerOf(1), referrer);
        assertEq(c.ownerOf(2), collector);
    }

    // ── burn is unaffected (to == address(0), not the guarded branch) ────────

    function test_burn_unaffected() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.prank(collector);
        c.burn(1);
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.ownerOf(1);
    }
}
