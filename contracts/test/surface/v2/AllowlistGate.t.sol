// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceV2Base} from "./SurfaceV2Base.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {AllowlistGate} from "../../../src/surface/v2/AllowlistGate.sol";

contract AllowlistGateTest is SurfaceV2Base {
    Surface internal token;
    Surface internal other;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    bytes32 internal rootAB;

    function setUp() public override {
        super.setUp();
        token = _token(makeAddr("minter"));
        other = _token(makeAddr("minter"));
        rootAB = _hashPair(_leaf(alice), _leaf(bob));
    }

    function _proof(bytes32 sibling) internal pure returns (bytes memory) {
        bytes32[] memory p = new bytes32[](1);
        p[0] = sibling;
        return abi.encode(p);
    }

    function test_setRoot_ownerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(AllowlistGate.NotAuthorized.selector);
        allowlist.setRoot(address(token), rootAB);
        vm.expectEmit(address(allowlist));
        emit AllowlistGate.RootSet(address(token), rootAB);
        vm.prank(artist);
        allowlist.setRoot(address(token), rootAB);
        assertEq(allowlist.root(address(token)), rootAB);
    }

    function test_setRoot_followsOwnershipAndRenounce() public {
        vm.prank(artist);
        token.transferOwnership(stranger);
        vm.prank(artist);
        vm.expectRevert(AllowlistGate.NotAuthorized.selector);
        allowlist.setRoot(address(token), rootAB);
        vm.prank(stranger);
        allowlist.setRoot(address(token), rootAB);
        vm.prank(stranger);
        token.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(AllowlistGate.NotAuthorized.selector);
        allowlist.setRoot(address(token), bytes32(0));
    }

    function test_rootIsPerCollection() public {
        vm.prank(artist);
        allowlist.setRoot(address(token), rootAB);
        assertTrue(allowlist.check(address(token), alice, 1, _proof(_leaf(bob))));
        assertFalse(allowlist.check(address(other), alice, 1, _proof(_leaf(bob))), "other collection has no root");
    }

    function test_leafFormat_standardMerkleTree() public {
        vm.prank(artist);
        allowlist.setRoot(address(token), rootAB);
        assertTrue(allowlist.check(address(token), alice, 1, _proof(_leaf(bob))));
        assertTrue(allowlist.check(address(token), bob, 5, _proof(_leaf(alice))));
        assertFalse(allowlist.check(address(token), carol, 1, _proof(_leaf(bob))));
        // A single-hash leaf (not the standard double hash) does not verify.
        bytes32 singleA = keccak256(abi.encode(alice));
        bytes32 singleB = keccak256(abi.encode(bob));
        vm.prank(artist);
        allowlist.setRoot(address(token), _hashPair(singleA, singleB));
        assertFalse(allowlist.check(address(token), alice, 1, _proof(singleB)));
    }

    function test_singleLeafTree_emptyProof() public {
        vm.prank(artist);
        allowlist.setRoot(address(token), _leaf(alice));
        assertTrue(allowlist.check(address(token), alice, 1, abi.encode(new bytes32[](0))));
        assertFalse(allowlist.check(address(token), bob, 1, abi.encode(new bytes32[](0))));
    }

    function test_emptyData_failsCleanly() public {
        vm.prank(artist);
        allowlist.setRoot(address(token), rootAB);
        assertFalse(allowlist.check(address(token), alice, 1, ""));
    }

    function test_unsetRoot_fails() public view {
        assertFalse(allowlist.check(address(token), alice, 1, _proof(_leaf(bob))));
    }
}
