// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReleasesTestBase} from "./ReleasesTestBase.sol";
import {Release} from "../../src/releases/Release.sol";
import {GateMode, ReleaseParams} from "../../src/releases/IRelease.sol";
import {GreedyPayout, GreedySurface, LyingGate} from "./ReleasesMocks.sol";
import {RevertingReceiver} from "../RevertingReceiver.sol";

/// @notice The mint path makes zero external calls, so the reentrancy
///         story lives entirely in the two pull legs (zeroed before send)
///         and the BURN gate call (after all effects). These tests attack
///         each one.
contract ReleaseReentrancyTest is ReleasesTestBase {
    function test_withdraw_reentryCollectsOnceOnly() public {
        Release r = createDefault();
        GreedyPayout attacker = new GreedyPayout();
        attacker.setRelease(r);

        vm.prank(artist);
        r.setPayout(address(attacker));

        vm.prank(collector);
        r.mint{value: 5 * PRICE}(collector, 5, address(0));

        r.withdraw();

        // One payment, one failed inner attempt, books at zero.
        assertEq(attacker.received(), 5 * PRICE);
        assertEq(attacker.reentries(), 1);
        assertEq(r.artistBalance(), 0);
        assertEq(address(r).balance, 0);
    }

    function test_claimSurfaceFees_reentryCollectsOnceOnly() public {
        Release r = createDefault();
        GreedySurface attacker = new GreedySurface();
        attacker.setRelease(r);

        uint256 cost = 4 * (PRICE + SURFACE_FEE);
        vm.prank(collector);
        r.mint{value: cost}(collector, 4, address(attacker));

        r.claimSurfaceFees(address(attacker));

        assertEq(attacker.received(), 4 * SURFACE_FEE);
        assertEq(attacker.reentries(), 1);
        assertEq(r.owed(address(attacker)), 0);
        // The artist's leg never moved.
        assertEq(r.artistBalance(), 4 * PRICE);
        assertEq(address(r).balance, 4 * PRICE);
    }

    function test_lyingGate_corruptsOnlyItsOwnGatingNeverFunds() public {
        // The documented trust boundary: a release trusts the gate it
        // names. A hostile gate that lies about ownership and reenters
        // mintGated from burn() can mint extra tokens on ITS release —
        // and nothing else. Funds accounting stays exact; no other
        // contract is reachable.
        LyingGate gate = new LyingGate();

        ReleaseParams memory p = defaultParams();
        p.price = 0; // free, so the reentrant call needs no value
        p.gateToken = address(gate);
        p.gateMode = GateMode.BURN;
        Release r = createRelease(p);

        gate.setTarget(r);
        gate.setClaimedOwner(1, collector);
        gate.setClaimedOwner(999, address(gate));

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(collector);
        r.mintGated(collector, ids, address(0));

        // The gate stole itself an extra token of the release that
        // trusted it. The protocol's money invariants are untouched.
        assertTrue(gate.reentered());
        assertEq(r.totalMinted(), 2);
        assertEq(r.ownerOf(1), collector);
        assertEq(r.ownerOf(2), address(gate));
        assertEq(address(r).balance, 0);
        assertEq(r.artistBalance(), 0);
    }

    function test_mintToNonReceiverContractSucceeds() public {
        // _mint, not _safeMint: no receiver hook, no callback, no
        // reentrancy vector. A contract that can't handle a 721 receiving
        // one is its deployer's documented problem.
        Release r = createDefault();
        RevertingReceiver nonReceiver = new RevertingReceiver();

        vm.prank(collector);
        r.mint{value: PRICE}(address(nonReceiver), 1, address(0));
        assertEq(r.ownerOf(1), address(nonReceiver));
    }
}
