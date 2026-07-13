// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";
import {RecordingHook, RejectingSelectorHook, RevertingHook} from "./mocks/CollectionMocks.sol";

import {Collection} from "../../src/collection/Collection.sol";
import {HookChain} from "../../src/collection/hooks/HookChain.sol";
import {AllowlistHook} from "../../src/collection/hooks/AllowlistHook.sol";
import {PerWalletCapHook} from "../../src/collection/hooks/PerWalletCapHook.sol";
import {HookBase} from "../../src/collection/hooks/HookBase.sol";

/// @dev HookChain: one hook slot, several gates. The chain is born final
///      (collection + hook list fixed at construction), forwards
///      ICollectionAuth to its collection so sub-hook config lands on the
///      right people, and fans beforeMint/afterMint out in order.
contract CollectionHookChainTest is CollectionBase {
    Collection internal c;

    function setUp() public override {
        super.setUp();
        c = _collection(_freeConfig());
    }

    function _chain(address[] memory hooks) internal returns (HookChain chain) {
        chain = new HookChain(address(c), hooks);
        vm.prank(artist);
        c.setMintHook(address(chain));
    }

    // ── the motivating case: allowlist AND per-wallet cap ───────────────────

    function test_chain_allowlistAndCap_bothEnforce() public {
        AllowlistHook allow = new AllowlistHook();
        PerWalletCapHook cap = new PerWalletCapHook();
        address[] memory hooks = new address[](2);
        hooks[0] = address(allow);
        hooks[1] = address(cap);
        HookChain chain = _chain(hooks);

        // Sub-hook config is keyed by the CHAIN (it is their msg.sender), and
        // the artist's key opens it because the chain forwards auth.
        bytes32 leafCollector = keccak256(bytes.concat(keccak256(abi.encode(collector))));
        bytes32 leafStranger = keccak256(bytes.concat(keccak256(abi.encode(stranger))));
        bytes32 root = leafCollector < leafStranger
            ? keccak256(abi.encodePacked(leafCollector, leafStranger))
            : keccak256(abi.encodePacked(leafStranger, leafCollector));
        vm.prank(artist);
        allow.setRoot(address(chain), root);
        vm.prank(artist);
        cap.setCap(address(chain), 1);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafStranger;

        // Allowlisted + under cap: passes both gates.
        vm.prank(collector);
        c.mintWithReferral(1, address(0), abi.encode(proof));
        assertEq(c.balanceOf(collector), 1);

        // Same wallet again: allowlist passes, cap refuses.
        vm.expectRevert(abi.encodeWithSelector(PerWalletCapHook.WalletCapExceeded.selector, 1, 2));
        vm.prank(collector);
        c.mintWithReferral(1, address(0), abi.encode(proof));

        // Not allowlisted: first gate refuses before the cap is consulted.
        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = leafCollector;
        vm.expectRevert(AllowlistHook.NotAllowlisted.selector);
        vm.prank(makeAddr("notInTree"));
        c.mintWithReferral(1, address(0), abi.encode(badProof));
    }

    // ── fan-out mechanics ────────────────────────────────────────────────────

    function test_chain_runsHooksInOrder_beforeAndAfter() public {
        RecordingHook first = new RecordingHook();
        RecordingHook second = new RecordingHook();
        address[] memory hooks = new address[](2);
        hooks[0] = address(first);
        hooks[1] = address(second);
        _chain(hooks);

        vm.prank(collector);
        c.mintWithReferral(2, referrer, bytes("payload"));

        assertEq(first.beforeCallCount(), 1);
        assertEq(second.beforeCallCount(), 1);
        assertEq(first.afterCallCount(), 1);
        assertEq(second.afterCallCount(), 1);
        (address m, uint256 q, uint256 fid, address r, bytes memory data) = second.beforeCalls(0);
        assertEq(m, collector);
        assertEq(q, 2);
        assertEq(fid, 1);
        assertEq(r, referrer);
        assertEq(data, bytes("payload"));
    }

    function test_chain_wrongSelectorSubHook_revertsNamingIt() public {
        RejectingSelectorHook bad = new RejectingSelectorHook();
        address[] memory hooks = new address[](1);
        hooks[0] = address(bad);
        HookChain chain = _chain(hooks);

        vm.expectRevert(abi.encodeWithSelector(HookChain.ChainedHookRejected.selector, address(bad)));
        vm.prank(collector);
        c.mint(1);
        // silence unused warning
        chain;
    }

    function test_chain_revertingSubHook_reasonBubbles() public {
        RevertingHook bad = new RevertingHook();
        address[] memory hooks = new address[](1);
        hooks[0] = address(bad);
        _chain(hooks);

        vm.expectRevert(bytes("hook: nope"));
        vm.prank(collector);
        c.mint(1);
    }

    function test_chain_empty_isPassThrough() public {
        _chain(new address[](0));
        vm.prank(collector);
        c.mint(1);
        assertEq(c.balanceOf(collector), 1);
    }

    // ── the chain is born final and collection-bound ─────────────────────────

    function test_chain_onlyItsCollectionMayCall() public {
        RecordingHook rec = new RecordingHook();
        address[] memory hooks = new address[](1);
        hooks[0] = address(rec);
        HookChain chain = _chain(hooks);

        vm.expectRevert(HookChain.NotCollection.selector);
        vm.prank(stranger);
        chain.beforeMint(stranger, 1, 1, address(0), "");
        vm.expectRevert(HookChain.NotCollection.selector);
        vm.prank(stranger);
        chain.afterMint(stranger, 1, 1, address(0), "");
        assertEq(rec.beforeCallCount(), 0, "nothing reached the sub-hook");
    }

    function test_chain_constructorGuards() public {
        address[] memory none = new address[](0);
        vm.expectRevert(HookChain.CollectionRequired.selector);
        new HookChain(address(0), none);
        vm.expectRevert(HookChain.CollectionRequired.selector);
        new HookChain(makeAddr("eoa"), none);

        address[] memory withZero = new address[](1);
        vm.expectRevert(HookChain.ZeroHook.selector);
        new HookChain(address(c), withZero);

        address[] memory withEoa = new address[](1);
        withEoa[0] = makeAddr("eoaHook");
        vm.expectRevert(abi.encodeWithSelector(HookChain.HookNotContract.selector, withEoa[0]));
        new HookChain(address(c), withEoa);
    }

    function test_chain_hooksViewReportsOrder() public {
        RecordingHook a = new RecordingHook();
        RecordingHook b = new RecordingHook();
        address[] memory hooks = new address[](2);
        hooks[0] = address(a);
        hooks[1] = address(b);
        HookChain chain = new HookChain(address(c), hooks);
        address[] memory got = chain.hooks();
        assertEq(got.length, 2);
        assertEq(got[0], address(a));
        assertEq(got[1], address(b));
    }

    // ── auth forwarding ──────────────────────────────────────────────────────

    function test_chain_forwardsAuth_ownerAdminAndStranger() public {
        HookChain chain = new HookChain(address(c), new address[](0));
        assertEq(chain.owner(), artist);
        assertTrue(chain.isAdmin(artist), "owner counts (forwarded isAdmin)");

        address admin = makeAddr("admin");
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(chain.isAdmin(admin));
        assertFalse(chain.isAdmin(stranger));

        // The forwarded auth is what lets the artist configure a stock hook
        // keyed by the chain — and keeps strangers out of it.
        AllowlistHook allow = new AllowlistHook();
        vm.prank(artist);
        allow.setRoot(address(chain), bytes32(uint256(1)));
        assertEq(allow.rootOf(address(chain)), bytes32(uint256(1)));
        vm.expectRevert(HookBase.NotCollectionAdmin.selector);
        vm.prank(stranger);
        allow.setRoot(address(chain), bytes32(uint256(2)));
    }
}
