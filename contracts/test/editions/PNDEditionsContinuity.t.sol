// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {PNDEditionsBase} from "./PNDEditionsBase.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {PNDPerWalletCapHook} from "../../src/editions/hooks/PNDPerWalletCapHook.sol";
import {PNDAllowlistHook} from "../../src/editions/hooks/PNDAllowlistHook.sol";
import {PNDHoldsEditionHook} from "../../src/editions/hooks/PNDHoldsEditionHook.sol";
import {EdgeType, Ref, RefKind} from "../../src/editions/PNDEditionsTypes.sol";

/// @dev Phase 2 primitives: the bilateral Edition Graph handshake and the
///      reference mint-hook library (public-good gating contracts).
contract PNDEditionsContinuityTest is PNDEditionsBase {
    // ── bilateral graph handshake ───────────────────────────────────────────

    function test_graph_handshakeVerifiesMutualEdge() public {
        PNDEditions a = _edition(_freeConfig());
        PNDEditions b = _edition(_freeConfig());

        // A claims it is a phase of B.
        Ref memory refToB = Ref(1, address(b), 0, RefKind.Edition);
        vm.prank(artist);
        a.addEdge(EdgeType.PhaseOf, refToB);

        // Before B acknowledges, the relationship is only "claimed".
        Ref memory refToA = Ref(1, address(a), 0, RefKind.Edition);
        assertFalse(b.isEdgeAcknowledged(EdgeType.PhaseOf, refToA));

        // B acknowledges A's inbound edge -> now verifiable as mutual.
        vm.prank(artist);
        b.acknowledgeEdge(EdgeType.PhaseOf, refToA, true);
        assertTrue(b.isEdgeAcknowledged(EdgeType.PhaseOf, refToA));

        // Revocable.
        vm.prank(artist);
        b.acknowledgeEdge(EdgeType.PhaseOf, refToA, false);
        assertFalse(b.isEdgeAcknowledged(EdgeType.PhaseOf, refToA));
    }

    function test_graph_acknowledgeOnlyOwner() public {
        PNDEditions b = _edition(_freeConfig());
        Ref memory refToA = Ref(1, makeAddr("a"), 0, RefKind.Edition);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        b.acknowledgeEdge(EdgeType.PhaseOf, refToA, true);
    }

    // ── PNDPerWalletCapHook (fair capped drops, M4) ──────────────────────────

    function test_hook_perWalletCap() public {
        PNDEditions p = _edition(_freeConfig());
        PNDPerWalletCapHook hook = new PNDPerWalletCapHook();
        vm.startPrank(artist);
        p.setMintHook(address(hook));
        hook.setCap(address(p), 2);
        vm.stopPrank();

        vm.prank(collector);
        p.mint(2); // at the cap
        assertEq(hook.mintedBy(address(p), collector), 2);

        vm.expectRevert(bytes("PND: wallet cap"));
        vm.prank(collector);
        p.mint(1); // over the cap

        // A different wallet has its own allowance.
        vm.prank(stranger);
        p.mint(2);
        assertEq(p.balanceOf(stranger), 2);
    }

    function test_hook_perWalletCap_configOnlyEditionOwner() public {
        PNDEditions p = _edition(_freeConfig());
        PNDPerWalletCapHook hook = new PNDPerWalletCapHook();
        vm.expectRevert(bytes("PND: not edition owner"));
        vm.prank(stranger);
        hook.setCap(address(p), 1);
    }

    // ── PNDAllowlistHook (presale, Merkle) ───────────────────────────────────

    function test_hook_allowlist() public {
        PNDEditions p = _edition(_freeConfig());
        PNDAllowlistHook hook = new PNDAllowlistHook();

        // Tree of [collector, dummy]; collector is allowlisted, stranger is not.
        address dummy = makeAddr("dummy");
        bytes32 lc = _leaf(collector);
        bytes32 ld = _leaf(dummy);
        bytes32 root = _hashPair(lc, ld);

        vm.startPrank(artist);
        p.setMintHook(address(hook));
        hook.setRoot(address(p), root);
        vm.stopPrank();

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = ld; // sibling of collector's leaf
        bytes memory ok = abi.encode(proof);

        vm.prank(collector);
        p.mintWithRewards(1, address(0), ok); // allowlisted -> passes
        assertEq(p.balanceOf(collector), 1);

        // stranger presents collector's proof; their leaf doesn't match -> revert.
        vm.expectRevert(bytes("PND: not allowlisted"));
        vm.prank(stranger);
        p.mintWithRewards(1, address(0), ok);
    }

    // ── PNDHoldsEditionHook (continuity: reward holders of edition A) ─────────

    function test_hook_holdsEdition_continuity() public {
        // Edition A: the prior work. collector holds one; stranger does not.
        PNDEditions a = _edition(_freeConfig());
        vm.prank(collector);
        a.mint(1);

        // Edition B: gated on holding A.
        PNDEditions b = _edition(_freeConfig());
        PNDHoldsEditionHook hook = new PNDHoldsEditionHook();
        vm.startPrank(artist);
        b.setMintHook(address(hook));
        hook.setRequired(address(b), address(a));
        vm.stopPrank();

        vm.prank(collector);
        b.mint(1); // holds A -> allowed
        assertEq(b.balanceOf(collector), 1);

        vm.expectRevert(bytes("PND: must hold required edition"));
        vm.prank(stranger);
        b.mint(1); // holds no A -> blocked
    }

    // ── merkle helpers (OpenZeppelin standard-merkle-tree leaf format) ────────

    function _leaf(address a) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
