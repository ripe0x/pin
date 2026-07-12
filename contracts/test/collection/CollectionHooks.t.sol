// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";
import {
    RevertingHook,
    RejectingSelectorHook,
    AcceptingHook,
    RecordingHook,
    MockMinter
} from "./mocks/CollectionMocks.sol";

import {Collection} from "../../src/collection/Collection.sol";
import {PooledCollection} from "../../src/collection/PooledCollection.sol";
import {ICollection} from "../../src/collection/interfaces/ICollection.sol";
import {ICollectionCore} from "../../src/collection/interfaces/ICollectionCore.sol";
import {IPooledCollection} from "../../src/collection/interfaces/IPooledCollection.sol";
import {CollectionConfig} from "../../src/collection/CollectionTypes.sol";

import {AllowlistHook} from "../../src/collection/hooks/AllowlistHook.sol";
import {GateHook} from "../../src/collection/hooks/GateHook.sol";
import {HookBase} from "../../src/collection/hooks/HookBase.sol";
import {HoldsCollectionHook} from "../../src/collection/hooks/HoldsCollectionHook.sol";
import {PerWalletCapHook} from "../../src/collection/hooks/PerWalletCapHook.sol";

/// @dev Exercises the four stock hooks (src/collection/hooks/) on the paid
///      path, plus the hook-forwarding guarantee that ties every mint path
///      (paid built-in AND both extension entrypoints) through the same
///      beforeMint/afterMint contract, with identical argument semantics.
contract CollectionHooksTest is CollectionBase {
    RevertingHook internal revertingHook;
    RejectingSelectorHook internal rejectingSelectorHook;
    AcceptingHook internal acceptingHook;
    RecordingHook internal recordingHook;
    MockMinter internal minter;

    function setUp() public override {
        super.setUp();
        revertingHook = new RevertingHook();
        rejectingSelectorHook = new RejectingSelectorHook();
        acceptingHook = new AcceptingHook();
        recordingHook = new RecordingHook();
        minter = new MockMinter();
    }

    // ── generic hook wiring on the paid path ─────────────────────────────────

    function test_hook_calledBeforeAndAfter_onPaidMint() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMintHook(address(recordingHook));
        assertEq(c.mintHook(), address(recordingHook));

        vm.prank(collector);
        c.mintWithReferral(3, referrer, bytes("payload"));

        assertEq(recordingHook.beforeCallCount(), 1);
        assertEq(recordingHook.afterCallCount(), 1);
        (address m, uint256 q, uint256 fid, address s, bytes memory data) = _decodeBefore(recordingHook, 0);
        assertEq(m, collector);
        assertEq(q, 3);
        assertEq(fid, 1);
        assertEq(s, referrer);
        assertEq(data, bytes("payload"));
    }

    function test_hook_rejection_revertsMint_gasOnly() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMintHook(address(revertingHook));
        vm.expectRevert(bytes("hook: nope"));
        vm.prank(collector);
        c.mint(1);
    }

    function test_hook_rejection_wrongSelectorReverts() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMintHook(address(rejectingSelectorHook));
        vm.expectRevert(ICollectionCore.HookRejected.selector);
        vm.prank(collector);
        c.mint(1);
    }

    function test_hook_configuredAtDeploy() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.mintHook = address(recordingHook);
        Collection c = _collection(cfg);
        assertEq(c.mintHook(), address(recordingHook));

        vm.prank(collector);
        c.mint(1);
        assertEq(recordingHook.beforeCallCount(), 1);
        assertEq(recordingHook.afterCallCount(), 1);
    }

    function test_hook_onlyOwnerCanSet() public {
        Collection c = _collection(_freeConfig());
        vm.expectRevert(ICollectionCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setMintHook(address(recordingHook));
    }

    function test_hook_removedByUnsetting() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMintHook(address(revertingHook));
        vm.prank(artist);
        c.setMintHook(address(0));
        vm.prank(collector);
        c.mint(1); // no longer gated
        assertEq(c.balanceOf(collector), 1);
    }

    // ── hooks fire identically on mintTo (Sequential extension path) ────────

    function test_hook_firesOnMintTo_withCorrectArgs() public {
        CollectionConfig memory cfg = _freeConfig();
        Collection c = _collection(cfg);
        vm.prank(artist);
        c.setMintHook(address(recordingHook));
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.prank(artist); // caller identity doesn't matter for the minter grant path
        uint256 tokenId = minter.callMintTo(ICollection(address(c)), collector, referrer, bytes("ext-data"));

        assertEq(tokenId, 1);
        assertEq(recordingHook.beforeCallCount(), 1);
        assertEq(recordingHook.afterCallCount(), 1);
        (address m, uint256 q, uint256 fid, address s, bytes memory data) = _decodeBefore(recordingHook, 0);
        assertEq(m, collector); // `to` is forwarded as the hook's "minter" arg
        assertEq(q, 1);
        assertEq(fid, 1);
        assertEq(s, referrer);
        assertEq(data, bytes("ext-data"));
    }

    function test_hook_rejectsMintTo() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMintHook(address(revertingHook));
        vm.prank(artist);
        c.setMinter(address(minter), true);
        vm.expectRevert(bytes("hook: nope"));
        minter.callMintTo(ICollection(address(c)), collector, referrer, "");
    }

    // ── hooks fire identically on mintToId (Pooled extension path) ──────────

    function test_hook_firesOnMintToId_withCorrectArgs() public {
        PooledCollection c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMintHook(address(recordingHook));
        vm.prank(artist);
        c.setMinter(address(minter), true);

        minter.callMintToId(IPooledCollection(address(c)), collector, 42, referrer, bytes("pooled-data"));

        assertEq(recordingHook.beforeCallCount(), 1);
        assertEq(recordingHook.afterCallCount(), 1);
        (address m, uint256 q, uint256 fid, address s, bytes memory data) = _decodeBefore(recordingHook, 0);
        assertEq(m, collector);
        assertEq(q, 1);
        assertEq(fid, 42); // firstTokenId == the explicit pooled id
        assertEq(s, referrer);
        assertEq(data, bytes("pooled-data"));
    }

    function test_hook_rejectsMintToId() public {
        PooledCollection c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMintHook(address(revertingHook));
        vm.prank(artist);
        c.setMinter(address(minter), true);
        vm.expectRevert(bytes("hook: nope"));
        minter.callMintToId(IPooledCollection(address(c)), collector, 42, referrer, "");
    }

    function test_hook_firesOnMintToId_id0() public {
        PooledCollection c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMintHook(address(recordingHook));
        vm.prank(artist);
        c.setMinter(address(minter), true);

        minter.callMintToId(IPooledCollection(address(c)), collector, 0, referrer, "");
        assertEq(recordingHook.beforeCallCount(), 1);
        (,, uint256 fid,,) = _decodeBefore(recordingHook, 0);
        assertEq(fid, 0);
    }

    // ── hookData forwarding: identical blob to both the hook and (when set)
    //    the price strategy ─────────────────────────────────────────────────

    function test_hookData_forwardedVerbatim_acrossPaths() public {
        CollectionConfig memory cfg = _freeConfig();
        Collection c = _collection(cfg);
        vm.prank(artist);
        c.setMintHook(address(recordingHook));

        bytes memory blob = abi.encode(uint256(7), "tier-A");
        vm.prank(collector);
        c.mintWithReferral(1, referrer, blob);
        (,,,, bytes memory got) = _decodeBefore(recordingHook, 0);
        assertEq(got, blob);
    }

    // ── stock hook: AllowlistHook ────────────────────────────────────────────

    function test_stockHook_allowlist_gatesMint() public {
        Collection c = _collection(_freeConfig());
        AllowlistHook allow = new AllowlistHook();
        vm.prank(artist);
        c.setMintHook(address(allow));

        // Build a 2-leaf tree: collector + referrer, using the OZ
        // standard-merkle-tree double-hash leaf convention the hook expects.
        bytes32 leafCollector = keccak256(bytes.concat(keccak256(abi.encode(collector))));
        bytes32 leafStranger = keccak256(bytes.concat(keccak256(abi.encode(stranger))));
        bytes32 root = leafCollector < leafStranger
            ? keccak256(abi.encodePacked(leafCollector, leafStranger))
            : keccak256(abi.encodePacked(leafStranger, leafCollector));

        vm.prank(artist);
        allow.setRoot(address(c), root);

        // hookData only travels through mintWithReferral; the plain mint()
        // path has no hookData parameter, so a Merkle-gated hook can only be
        // satisfied via mintWithReferral even for a "free" (price 0) mint.
        bytes32[] memory proofForCollector = new bytes32[](1);
        proofForCollector[0] = leafStranger;
        vm.prank(collector);
        c.mintWithReferral(1, address(0), abi.encode(proofForCollector));
        assertEq(c.balanceOf(collector), 1);

        // A wallet not in the tree fails verification even with a
        // syntactically well-formed (but wrong) proof.
        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = leafCollector;
        vm.expectRevert(AllowlistHook.NotAllowlisted.selector);
        vm.prank(makeAddr("notInTree"));
        c.mintWithReferral(1, address(0), abi.encode(badProof));
    }

    // ── stock hook: HoldsCollectionHook ──────────────────────────────────────

    function test_stockHook_holdsCollection_gatesOnBalance() public {
        Collection gate = _collection(_freeConfig()); // the "earlier" collection
        Collection c = _collection(_freeConfig()); // the gated collection

        HoldsCollectionHook holds = new HoldsCollectionHook();
        vm.prank(artist);
        c.setMintHook(address(holds));
        vm.prank(artist);
        holds.setRequired(address(c), address(gate));

        // Collector doesn't hold the required collection yet.
        vm.expectRevert(abi.encodeWithSelector(HoldsCollectionHook.MustHoldRequired.selector, address(gate)));
        vm.prank(collector);
        c.mint(1);

        // Mint from the gate collection, then retry.
        vm.prank(collector);
        gate.mint(1);
        vm.prank(collector);
        c.mint(1);
        assertEq(c.balanceOf(collector), 1);
    }

    // ── stock hook: PerWalletCapHook ─────────────────────────────────────────

    function test_stockHook_perWalletCap_enforcesAcrossCalls() public {
        Collection c = _collection(_freeConfig());
        PerWalletCapHook cap = new PerWalletCapHook();
        vm.prank(artist);
        c.setMintHook(address(cap));
        vm.prank(artist);
        cap.setCap(address(c), 2);

        vm.prank(collector);
        c.mint(2);
        vm.expectRevert(abi.encodeWithSelector(PerWalletCapHook.WalletCapExceeded.selector, 2, 3));
        vm.prank(collector);
        c.mint(1);

        // A different wallet has its own budget.
        vm.prank(stranger);
        c.mint(2);
    }

    function test_stockHook_perWalletCap_singleTxOverCapReverts() public {
        Collection c = _collection(_freeConfig());
        PerWalletCapHook cap = new PerWalletCapHook();
        vm.prank(artist);
        c.setMintHook(address(cap));
        vm.prank(artist);
        cap.setCap(address(c), 2);

        vm.expectRevert(abi.encodeWithSelector(PerWalletCapHook.WalletCapExceeded.selector, 2, 3));
        vm.prank(collector);
        c.mint(3); // one tx exceeding the cap outright
    }

    // ── stock hook: GateHook (composite allowlist + per-wallet cap) ─────────

    /// @dev 2-leaf OZ standard-merkle-tree over (collector, stranger),
    ///      identical leaf convention to AllowlistHook's test above.
    function _gateTree()
        internal
        view
        returns (bytes32 root, bytes32[] memory proofForCollector)
    {
        bytes32 leafCollector = keccak256(bytes.concat(keccak256(abi.encode(collector))));
        bytes32 leafStranger = keccak256(bytes.concat(keccak256(abi.encode(stranger))));
        root = leafCollector < leafStranger
            ? keccak256(abi.encodePacked(leafCollector, leafStranger))
            : keccak256(abi.encodePacked(leafStranger, leafCollector));
        proofForCollector = new bytes32[](1);
        proofForCollector[0] = leafStranger;
    }

    function test_stockHook_gate_bothGatesEnforcedTogether() public {
        Collection c = _collection(_freeConfig());
        GateHook gate = new GateHook();
        vm.prank(artist);
        c.setMintHook(address(gate));

        (bytes32 root, bytes32[] memory proof) = _gateTree();
        vm.prank(artist);
        gate.setRoot(address(c), root);
        vm.prank(artist);
        gate.setCap(address(c), 2);

        // Listed wallet mints within its cap.
        vm.prank(collector);
        c.mintWithReferral(2, address(0), abi.encode(proof));
        assertEq(c.balanceOf(collector), 2);

        // Same listed wallet over the cap: the allowlist does not exempt it.
        vm.expectRevert(bytes("SC: wallet cap"));
        vm.prank(collector);
        c.mintWithReferral(1, address(0), abi.encode(proof));

        // Unlisted wallet fails the allowlist even with cap budget left.
        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = keccak256("nope");
        vm.expectRevert(bytes("SC: not allowlisted"));
        vm.prank(makeAddr("notInTree"));
        c.mintWithReferral(1, address(0), abi.encode(badProof));
    }

    function test_stockHook_gate_allowlistOnly_noCountingWrites() public {
        Collection c = _collection(_freeConfig());
        GateHook gate = new GateHook();
        vm.prank(artist);
        c.setMintHook(address(gate));

        (bytes32 root, bytes32[] memory proof) = _gateTree();
        vm.prank(artist);
        gate.setRoot(address(c), root);
        // cap stays 0 = unlimited

        vm.prank(collector);
        c.mintWithReferral(3, address(0), abi.encode(proof));
        assertEq(c.balanceOf(collector), 3);

        // Uncapped collections must not pay the counting SSTORE per mint.
        assertEq(gate.mintedBy(address(c), collector), 0);
        assertEq(gate.remainingFor(address(c), collector), type(uint256).max);
    }

    function test_stockHook_gate_capOnly_plainMintPathWorks() public {
        Collection c = _collection(_freeConfig());
        GateHook gate = new GateHook();
        vm.prank(artist);
        c.setMintHook(address(gate));
        vm.prank(artist);
        gate.setCap(address(c), 2);

        // No allowlist: plain mint() (empty hookData) must pass the gate.
        vm.prank(collector);
        c.mint(2);
        vm.expectRevert(bytes("SC: wallet cap"));
        vm.prank(collector);
        c.mint(1);

        // Another wallet has its own budget.
        vm.prank(stranger);
        c.mint(2);
        assertEq(gate.remainingFor(address(c), stranger), 0);
    }

    function test_stockHook_gate_remainingFor_tracksAndSaturates() public {
        Collection c = _collection(_freeConfig());
        GateHook gate = new GateHook();
        vm.prank(artist);
        c.setMintHook(address(gate));
        vm.prank(artist);
        gate.setCap(address(c), 3);

        assertEq(gate.remainingFor(address(c), collector), 3);
        vm.prank(collector);
        c.mint(2);
        assertEq(gate.remainingFor(address(c), collector), 1);

        // Cap lowered below what the wallet already minted: saturate at 0,
        // never underflow.
        vm.prank(artist);
        gate.setCap(address(c), 1);
        assertEq(gate.remainingFor(address(c), collector), 0);
        vm.expectRevert(bytes("SC: wallet cap"));
        vm.prank(collector);
        c.mint(1);
    }

    function test_stockHook_gate_midSaleCap_countsFromEnable() public {
        Collection c = _collection(_freeConfig());
        GateHook gate = new GateHook();
        vm.prank(artist);
        c.setMintHook(address(gate));

        // Uncapped mint happens first — not counted (documented tradeoff).
        vm.prank(collector);
        c.mint(2);

        vm.prank(artist);
        gate.setCap(address(c), 1);
        // The wallet's budget starts fresh from the moment the cap is set.
        vm.prank(collector);
        c.mint(1);
        vm.expectRevert(bytes("SC: wallet cap"));
        vm.prank(collector);
        c.mint(1);
    }

    function test_stockHook_gate_adminCanConfigure_strangerCannot() public {
        Collection c = _collection(_freeConfig());
        GateHook gate = new GateHook();

        address opsAdmin = makeAddr("opsAdmin");
        vm.prank(artist);
        c.addAdmin(opsAdmin);

        // Admin authority mirrors the renderer-land registries (owner OR admin).
        vm.prank(opsAdmin);
        gate.setCap(address(c), 5);
        assertEq(gate.capOf(address(c)), 5);
        vm.prank(opsAdmin);
        gate.setRoot(address(c), bytes32(uint256(1)));
        assertEq(gate.rootOf(address(c)), bytes32(uint256(1)));

        vm.expectRevert(HookBase.NotCollectionAdmin.selector);
        vm.prank(stranger);
        gate.setCap(address(c), 1);
        vm.expectRevert(HookBase.NotCollectionAdmin.selector);
        vm.prank(stranger);
        gate.setRoot(address(c), bytes32(0));
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _decodeBefore(RecordingHook hook, uint256 idx)
        internal
        view
        returns (address minter_, uint256 quantity, uint256 firstTokenId, address referrer_, bytes memory hookData)
    {
        (minter_, quantity, firstTokenId, referrer_, hookData) = hook.beforeCalls(idx);
    }
}
