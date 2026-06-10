// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReleasesTestBase} from "./ReleasesTestBase.sol";
import {Release} from "../../src/releases/Release.sol";
import {
    GateMode,
    IRelease,
    ReleaseParams,
    ReleaseStatus
} from "../../src/releases/IRelease.sol";
import {BurnableGate} from "./ReleasesMocks.sol";
import {MockERC721} from "../MockERC721.sol";

contract ReleaseGatesTest is ReleasesTestBase {
    MockERC721 internal holdGate; // vanilla 721, no burn — HOLD works on it
    BurnableGate internal burnGate;

    function setUp() public override {
        super.setUp();
        holdGate = new MockERC721();
        burnGate = new BurnableGate();
        holdGate.mint(collector, 1);
        holdGate.mint(collector, 2);
        holdGate.mint(other, 3);
        burnGate.mint(collector, 1);
        burnGate.mint(collector, 2);
        burnGate.mint(other, 3);
    }

    function _gated(address gate, GateMode mode, uint256 price_)
        internal
        returns (Release)
    {
        ReleaseParams memory p = defaultParams();
        p.gateToken = gate;
        p.gateMode = mode;
        p.price = price_;
        return createRelease(p);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids(uint256 a, uint256 b)
        internal
        pure
        returns (uint256[] memory ids)
    {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }

    // ── Mode exclusivity ─────────────────────────────────────────────────

    function test_gatedReleaseRejectsPlainMint() public {
        Release b = _gated(address(holdGate), GateMode.HOLD, PRICE);
        vm.prank(collector);
        vm.expectRevert("release is gated");
        b.mint{value: PRICE}(collector, 1, address(0));
    }

    function test_ungatedReleaseRejectsMintGated() public {
        Release plain = createDefault();
        vm.prank(collector);
        vm.expectRevert("release is not gated");
        plain.mintGated{value: PRICE}(collector, _ids(1), address(0));
    }

    function test_mintGated_emptySourcesReverts() public {
        Release b = _gated(address(holdGate), GateMode.HOLD, PRICE);
        vm.prank(collector);
        vm.expectRevert("no source tokens");
        b.mintGated{value: 0}(collector, new uint256[](0), address(0));
    }

    // ── HOLD ─────────────────────────────────────────────────────────────

    function test_hold_claimMintsAndMarksUsed() public {
        Release b = _gated(address(holdGate), GateMode.HOLD, PRICE);

        vm.prank(collector);
        vm.expectEmit();
        emit IRelease.Minted(collector, address(0), 1, 2, 2 * PRICE, 0);
        vm.expectEmit();
        emit IRelease.Claimed(1, 1);
        vm.expectEmit();
        emit IRelease.Claimed(2, 2);
        b.mintGated{value: 2 * PRICE}(collector, _ids(1, 2), address(0));

        assertEq(b.balanceOf(collector), 2);
        assertTrue(b.gateUsed(1));
        assertTrue(b.gateUsed(2));
        // The gate tokens are untouched.
        assertEq(holdGate.ownerOf(1), collector);
        assertEq(holdGate.ownerOf(2), collector);
    }

    function test_hold_oncePerSourceTokenEver() public {
        Release b = _gated(address(holdGate), GateMode.HOLD, PRICE);

        vm.prank(collector);
        b.mintGated{value: PRICE}(collector, _ids(1), address(0));

        vm.prank(collector);
        vm.expectRevert("source already used");
        b.mintGated{value: PRICE}(collector, _ids(1), address(0));

        // Selling the spent token doesn't refresh its claim.
        vm.prank(collector);
        holdGate.transferFrom(collector, other, 1);
        vm.prank(other);
        vm.expectRevert("source already used");
        b.mintGated{value: PRICE}(other, _ids(1), address(0));
    }

    function test_hold_duplicateIdsInOneCallRevert() public {
        Release b = _gated(address(holdGate), GateMode.HOLD, PRICE);
        vm.prank(collector);
        vm.expectRevert("source already used");
        b.mintGated{value: 2 * PRICE}(collector, _ids(1, 1), address(0));
    }

    function test_hold_callerMustOwnSource() public {
        Release b = _gated(address(holdGate), GateMode.HOLD, PRICE);

        vm.prank(collector);
        vm.expectRevert("not source owner");
        b.mintGated{value: PRICE}(collector, _ids(3), address(0)); // other's

        // Approval is not ownership: an operator can move the token, not
        // spend its claim.
        vm.prank(collector);
        holdGate.setApprovalForAll(other, true);
        vm.prank(other);
        vm.expectRevert("not source owner");
        b.mintGated{value: PRICE}(other, _ids(1), address(0));
    }

    function test_hold_claimRightTravelsWithToken() public {
        Release b = _gated(address(holdGate), GateMode.HOLD, PRICE);

        // Unclaimed token sold: the buyer holds the claim now.
        vm.prank(collector);
        holdGate.transferFrom(collector, other, 1);
        vm.prank(other);
        b.mintGated{value: PRICE}(other, _ids(1), address(0));
        assertEq(b.balanceOf(other), 1);
    }

    function test_hold_pricingAndSurfaceRulesApply() public {
        Release b = _gated(address(holdGate), GateMode.HOLD, PRICE);

        // Gated mints pay like any mint: price + fee when surfaced…
        vm.prank(collector);
        b.mintGated{value: PRICE + SURFACE_FEE}(collector, _ids(1), pnd);
        assertEq(b.artistBalance(), PRICE);
        assertEq(b.owed(pnd), SURFACE_FEE);

        // …and a free gated release is gas only, fee impossible.
        Release freeGated = _gated(address(holdGate), GateMode.HOLD, 0);
        vm.prank(collector);
        freeGated.mintGated(collector, _ids(2), pnd);
        assertEq(freeGated.owed(pnd), 0);
        assertEq(address(freeGated).balance, 0);
    }

    function test_hold_windowAndCapApply() public {
        ReleaseParams memory p = defaultParams();
        p.gateToken = address(holdGate);
        p.gateMode = GateMode.HOLD;
        p.maxSupply = 1;
        Release b = createRelease(p);

        vm.prank(collector);
        vm.expectRevert("exceeds max supply");
        b.mintGated{value: 2 * PRICE}(collector, _ids(1, 2), address(0));

        vm.warp(b.endTime());
        vm.prank(collector);
        vm.expectRevert("release ended");
        b.mintGated{value: PRICE}(collector, _ids(1), address(0));
    }

    // ── BURN ─────────────────────────────────────────────────────────────

    function test_burn_claimBurnsSourceAndMints() public {
        Release b = _gated(address(burnGate), GateMode.BURN, PRICE);

        vm.startPrank(collector);
        burnGate.setApprovalForAll(address(b), true);
        vm.expectEmit();
        emit IRelease.Claimed(1, 1);
        b.mintGated{value: PRICE}(collector, _ids(1), address(0));
        vm.stopPrank();

        assertEq(b.ownerOf(1), collector);
        // The source is gone — a real burn, not a dead-address parking.
        vm.expectRevert();
        burnGate.ownerOf(1);
    }

    function test_burn_requiresApprovalToRelease() public {
        Release b = _gated(address(burnGate), GateMode.BURN, PRICE);
        // Caller owns the source but never approved the release on the
        // gate: the gate's own burn auth rejects it.
        vm.prank(collector);
        vm.expectRevert();
        b.mintGated{value: PRICE}(collector, _ids(1), address(0));
    }

    function test_burn_callerMustOwnSource() public {
        Release b = _gated(address(burnGate), GateMode.BURN, PRICE);
        vm.startPrank(collector);
        burnGate.setApprovalForAll(address(b), true);
        vm.expectRevert("not source owner");
        b.mintGated{value: PRICE}(collector, _ids(3), address(0)); // other's
        vm.stopPrank();
    }

    function test_burn_duplicateIdsRevertOnSecondBurn() public {
        Release b = _gated(address(burnGate), GateMode.BURN, PRICE);
        vm.startPrank(collector);
        burnGate.setApprovalForAll(address(b), true);
        // Both ownerOf checks pass (still owned at validation); the
        // second burn of the same id reverts the whole claim.
        vm.expectRevert();
        b.mintGated{value: 2 * PRICE}(collector, _ids(1, 1), address(0));
        vm.stopPrank();
        // Nothing happened: atomic.
        assertEq(burnGate.ownerOf(1), collector);
        assertEq(b.totalMinted(), 0);
    }

    function test_burn_gateWithoutBurnFunctionRevertsClean() public {
        // A BURN release naming a gate with no burn(uint256) is created-
        // but-unclaimable: documented failure, harms no collector, the
        // artist closes and redeploys.
        Release b = _gated(address(holdGate), GateMode.BURN, PRICE);
        vm.startPrank(collector);
        holdGate.setApprovalForAll(address(b), true);
        vm.expectRevert();
        b.mintGated{value: PRICE}(collector, _ids(1), address(0));
        vm.stopPrank();
        assertEq(b.totalMinted(), 0);
    }

    // ── Continuation, end to end across releases ─────────────────────────

    function test_continuation_holdThenBurnAcrossReleases() public {
        // Release A: a plain open edition.
        ReleaseParams memory pa = defaultParams();
        pa.name = "A";
        Release a = createRelease(pa);
        vm.prank(collector);
        a.mint{value: 2 * PRICE}(collector, 2, address(0)); // A#1, A#2

        // Release B: hold a token from A to mint. A is untouched.
        ReleaseParams memory pb = defaultParams();
        pb.name = "B";
        pb.gateToken = address(a);
        pb.gateMode = GateMode.HOLD;
        pb.price = 0; // free follow-on
        Release b = createRelease(pb);

        vm.prank(collector);
        b.mintGated(collector, _ids(1), address(0)); // A#1 claims B#1
        assertEq(b.ownerOf(1), collector);
        assertEq(a.ownerOf(1), collector);
        assertTrue(b.gateUsed(1));

        // Release C: burn a token from A to mint. Works because every
        // Release exposes burn(uint256) with operator approval.
        ReleaseParams memory pc = defaultParams();
        pc.name = "C";
        pc.gateToken = address(a);
        pc.gateMode = GateMode.BURN;
        pc.price = 0;
        Release c = createRelease(pc);

        vm.startPrank(collector);
        a.setApprovalForAll(address(c), true);
        c.mintGated(collector, _ids(2), address(0)); // A#2 burned for C#1
        vm.stopPrank();

        assertEq(c.ownerOf(1), collector);
        assertEq(a.totalSupply(), 1); // A#2 is really gone
        assertEq(a.totalMinted(), 2); // history intact

        // A#1's full story is now: minted on A, claimed B#1 (A untouched),
        // while A#2 was burned for C#1 — all of it events, none of it
        // token state.
    }

    function test_continuation_supplyOfFollowOnBoundedByGate() public {
        // HOLD with per-token claims: B can never out-mint A's supply.
        ReleaseParams memory pa = defaultParams();
        Release a = createRelease(pa);
        vm.prank(collector);
        a.mint{value: 3 * PRICE}(collector, 3, address(0));

        ReleaseParams memory pb = defaultParams();
        pb.gateToken = address(a);
        pb.gateMode = GateMode.HOLD;
        pb.price = 0;
        Release b = createRelease(pb);

        vm.startPrank(collector);
        uint256[] memory ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (1, 2, 3);
        b.mintGated(collector, ids, address(0));

        // Every A token spent; no path to a 4th B.
        vm.expectRevert("source already used");
        b.mintGated(collector, _ids(1), address(0));
        vm.stopPrank();
        assertEq(b.totalMinted(), a.totalMinted());
    }
}
