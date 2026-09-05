// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {SurfaceV2Base} from "./SurfaceV2Base.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {ISurfaceV2} from "../../../src/surface/v2/interfaces/ISurfaceV2.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";

/// @dev lockRoyalty (one-way, optional) and seal() (owner-only, engages
///      every remaining lock and renounces in one call). Ported from
///      docs/pnd-surface-v2-plan.md's spec for the two behaviors v2 adds
///      over v1; v1 has no royalty lock and no seal().
contract SurfaceV2SealTest is SurfaceV2Base {
    address internal admin = makeAddr("admin");

    // ── lockRoyalty ───────────────────────────────────────────────────────────

    function test_lockRoyalty_isOneWay() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertFalse(c.isRoyaltyLocked());

        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceV2.RoyaltyLocked();
        vm.prank(artist);
        c.lockRoyalty();
        assertTrue(c.isRoyaltyLocked());

        vm.expectRevert(ISurfaceV2.RoyaltyIsLocked.selector);
        vm.prank(artist);
        c.setRoyalty(100, artist);

        // one-way: locking twice reverts rather than silently re-emitting
        vm.expectRevert(ISurfaceV2.RoyaltyIsLocked.selector);
        vm.prank(artist);
        c.lockRoyalty();
    }

    function test_lockRoyalty_onlyOwnerOrAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.lockRoyalty();
    }

    function test_lockRoyalty_admin() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);
        vm.prank(admin);
        c.lockRoyalty();
        assertTrue(c.isRoyaltyLocked());
    }

    // ── seal(): owner-only ────────────────────────────────────────────────────

    function test_seal_ownerOnly() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", admin));
        vm.prank(admin);
        c.seal();

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        c.seal();
    }

    // ── seal(): engages every un-engaged lock + renounces ─────────────────────

    function test_seal_engagesAllLocksAndRenounces() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertFalse(c.isRendererLocked());
        assertFalse(c.isSupplyLocked());
        assertFalse(c.isMinterLocked());
        assertFalse(c.isRoyaltyLocked());

        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceV2.RendererLocked();
        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceV2.SupplyLocked();
        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceV2.MinterLocked();
        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceV2.RoyaltyLocked();
        vm.prank(artist);
        c.seal();

        assertTrue(c.isRendererLocked());
        assertTrue(c.isSupplyLocked());
        assertTrue(c.isMinterLocked());
        assertTrue(c.isRoyaltyLocked());
        assertEq(c.owner(), address(0));
    }

    /// @dev seal() must not re-emit a lock event for a lock already engaged
    ///      before the call: pre-lock renderer and supply, then seal, and
    ///      assert exactly one MinterLocked/RoyaltyLocked log and zero
    ///      RendererLocked/SupplyLocked logs from the seal() call itself.
    function test_seal_emitsOnlyForPreviouslyUnengagedLocks() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.lockRenderer();
        c.lockSupply();
        vm.stopPrank();

        vm.recordLogs();
        vm.prank(artist);
        c.seal();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 rendererLockedCount;
        uint256 supplyLockedCount;
        uint256 minterLockedCount;
        uint256 royaltyLockedCount;
        bytes32 rendererTopic = keccak256("RendererLocked()");
        bytes32 supplyTopic = keccak256("SupplyLocked()");
        bytes32 minterTopic = keccak256("MinterLocked()");
        bytes32 royaltyTopic = keccak256("RoyaltyLocked()");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(c)) continue;
            bytes32 topic0 = logs[i].topics[0];
            if (topic0 == rendererTopic) rendererLockedCount++;
            else if (topic0 == supplyTopic) supplyLockedCount++;
            else if (topic0 == minterTopic) minterLockedCount++;
            else if (topic0 == royaltyTopic) royaltyLockedCount++;
        }

        assertEq(rendererLockedCount, 0, "renderer already locked: no re-emit");
        assertEq(supplyLockedCount, 0, "supply already locked: no re-emit");
        assertEq(minterLockedCount, 1, "minter engaged by seal: emits once");
        assertEq(royaltyLockedCount, 1, "royalty engaged by seal: emits once");
    }

    /// @dev Sealing with zero granted minters permanently ends minting.
    function test_seal_withNoMinters_endsMintingForever() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.seal();

        assertTrue(c.isMinterLocked());
        assertFalse(c.isMinter(address(this)));
        vm.expectRevert(ISurfaceV2.NotMinter.selector);
        c.mintTo(collector, 1);
    }

    /// @dev A minter granted before seal() keeps its authority after.
    function test_seal_grantedMinterKeepsMintingAfter() public {
        SurfaceConfig memory cfg = _freeConfig();
        SurfaceV2 c = _collection(cfg);
        address minter = makeAddr("minter");
        vm.startPrank(artist);
        c.setMinter(minter, true);
        c.seal();
        vm.stopPrank();

        vm.prank(minter);
        c.mintTo(collector, 1);
        assertEq(c.ownerOf(1), collector);
    }

    /// @dev Every owner-or-admin mutator reverts once sealed: owner() == 0
    ///      means onlyOwnerOrAdmin's owner-branch can never match and no
    ///      admin grant can be valid (isAdmin requires grantedBy == owner()).
    function test_seal_allMutatorsRevertAfter() public {
        SurfaceConfig memory cfg = _freeConfig();
        SurfaceV2 c = _collection(cfg);
        vm.prank(artist);
        c.seal();

        bytes memory unauth = abi.encodeWithSelector(ISurfaceV2.NotAuthorized.selector);

        vm.startPrank(artist);
        vm.expectRevert(unauth);
        c.setRenderer(makeAddr("r"));
        vm.expectRevert(unauth);
        c.setMinter(makeAddr("m"), true);
        vm.expectRevert(unauth);
        c.setRoyalty(100, artist);
        vm.expectRevert(unauth);
        c.setSupplyCap(1);
        vm.expectRevert(unauth);
        c.setPrimaryMinter(address(0));
        vm.expectRevert(unauth);
        c.setCreators(new address[](0), true);
        vm.expectRevert(unauth);
        c.notifyMetadataUpdate(1, 1);
        vm.expectRevert(unauth);
        c.lockRenderer();
        vm.expectRevert(unauth);
        c.lockSupply();
        vm.expectRevert(unauth);
        c.lockRoyalty();
        vm.expectRevert(unauth);
        c.rescueStrayETH(artist);
        vm.stopPrank();

        // seal() itself, addAdmin, and transferOwnership are Ownable's
        // onlyOwner: they revert OwnableUnauthorizedAccount, not NotAuthorized.
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", artist));
        vm.prank(artist);
        c.seal();
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", artist));
        vm.prank(artist);
        c.addAdmin(admin);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", artist));
        vm.prank(artist);
        c.transferOwnership(admin);
    }

    // ── permanence(): truth table before/after each lock and after seal ──────

    function test_permanence_truthTable() public {
        SurfaceV2 c = _collection(_freeConfig());

        (
            bool rendererLocked,
            bool supplyLocked,
            bool minterLocked,
            bool royaltyLocked,
            bool sealed_,
            uint256 version_
        ) = c.permanence();
        assertFalse(rendererLocked);
        assertFalse(supplyLocked);
        assertFalse(minterLocked);
        assertFalse(royaltyLocked);
        assertFalse(sealed_);
        assertEq(version_, 2);

        vm.prank(artist);
        c.lockRenderer();
        (rendererLocked, supplyLocked, minterLocked, royaltyLocked, sealed_,) = c.permanence();
        assertTrue(rendererLocked);
        assertFalse(supplyLocked);
        assertFalse(minterLocked);
        assertFalse(royaltyLocked);
        assertFalse(sealed_);

        vm.prank(artist);
        c.lockSupply();
        (rendererLocked, supplyLocked, minterLocked, royaltyLocked, sealed_,) = c.permanence();
        assertTrue(rendererLocked);
        assertTrue(supplyLocked);
        assertFalse(minterLocked);
        assertFalse(royaltyLocked);
        assertFalse(sealed_);

        vm.prank(artist);
        c.lockMinter();
        (rendererLocked, supplyLocked, minterLocked, royaltyLocked, sealed_,) = c.permanence();
        assertTrue(rendererLocked);
        assertTrue(supplyLocked);
        assertTrue(minterLocked);
        assertFalse(royaltyLocked);
        assertFalse(sealed_);

        vm.prank(artist);
        c.lockRoyalty();
        (rendererLocked, supplyLocked, minterLocked, royaltyLocked, sealed_,) = c.permanence();
        assertTrue(rendererLocked);
        assertTrue(supplyLocked);
        assertTrue(minterLocked);
        assertTrue(royaltyLocked);
        assertFalse(sealed_, "every lock engaged manually is not itself a seal");

        vm.prank(artist);
        c.seal();
        (rendererLocked, supplyLocked, minterLocked, royaltyLocked, sealed_, version_) = c.permanence();
        assertTrue(rendererLocked);
        assertTrue(supplyLocked);
        assertTrue(minterLocked);
        assertTrue(royaltyLocked);
        assertTrue(sealed_);
        assertEq(version_, 2);
    }

    function test_permanence_sealFromFreshCollection() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.seal();
        (
            bool rendererLocked,
            bool supplyLocked,
            bool minterLocked,
            bool royaltyLocked,
            bool sealed_,
            uint256 version_
        ) = c.permanence();
        assertTrue(rendererLocked);
        assertTrue(supplyLocked);
        assertTrue(minterLocked);
        assertTrue(royaltyLocked);
        assertTrue(sealed_);
        assertEq(version_, 2);
    }
}
