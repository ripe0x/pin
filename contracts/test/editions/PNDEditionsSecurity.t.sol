// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {UUPSUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";

import {PNDEditionsBase} from "./PNDEditionsBase.sol";
import {MockMintHook} from "./EditionsMocks.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {PNDDefaultRenderer} from "../../src/editions/PNDDefaultRenderer.sol";
import {EditionConfig, EditionStatus, MintMark} from "../../src/editions/PNDEditionsTypes.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Security findings from docs/pnd-editions-security-review.md.
//
// Two kinds of test live here:
//   - test_fix_*   : a finding that has been FIXED; the test asserts the fix
//                    holds (and would fail if the guard regressed).
//   - test_PoC_*   : a finding that is intentionally NOT a contract change
//                    (framing / indexer / hook-mitigated); the test still
//                    reproduces the behavior so the tradeoff stays documented.
// Plus a few test_confirm_* defensive checks that must never regress.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev A malicious upgrade target that keeps PNDEditions storage + getters but
///      adds a sweep(): used to show the settle-before-upgrade gate (H1) leaves
///      nothing to drain.
contract DrainV2 is PNDEditions {
    function sweep(address payable to) external {
        to.transfer(address(this).balance);
    }
}

/// @dev A standalone UUPS-compatible implementation whose tokenURI ignores all
///      edition state: shows "frozen" art is still mutable while unsealed (H2).
contract ArtRugV2 is UUPSUpgradeable {
    function tokenURI(uint256) external pure returns (string memory) {
        return "rugged://art-changed-after-freeze";
    }

    function _authorizeUpgrade(address) internal override {}
}

/// @dev A hook that always rejects (used for the M2 seal-lock test).
contract AlwaysRejectHook {
    function beforeMint(address, uint256, uint256, address, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return bytes4(0xdeadbeef);
    }

    function afterMint(address, uint256, uint256, address, bytes calldata) external {}
}

/// @dev Re-enters mint() from receive() during a withdraw payout.
contract Reenterer {
    PNDEditions internal p;

    function arm(PNDEditions p_) external {
        p = p_;
    }

    receive() external payable {
        p.mint{value: 0}(1); // re-enter; must be blocked by nonReentrant
    }
}

/// @dev Exposes the renderer's internal _escape for the L3 unit test.
contract RendererHarness is PNDDefaultRenderer {
    function esc(string calldata s) external pure returns (string memory) {
        return _escape(s);
    }
}

contract PNDEditionsSecurityTest is PNDEditionsBase {
    // ════════════════════════════════════════════════════════════════════════
    // H1 (FIXED) — settle-before-upgrade: an owner cannot drain accrued
    // pull-payment balances (incl. the host surface share) via upgrade.
    // ════════════════════════════════════════════════════════════════════════

    function test_fix_H1_upgradeBlockedUntilProceedsSettled() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mintWithRewards{value: 1 ether}(1, surface, "");
        assertEq(p.pendingWithdrawal(surface), 0.1 ether);
        assertEq(p.pendingWithdrawal(artist), 0.9 ether);

        vm.prank(artist);
        p.freezeMetadata();

        // The owner cannot upgrade-and-drain: the gate blocks any upgrade while
        // funds are owed, so the surface's 0.1 ETH cannot be swept out from under it.
        DrainV2 v2 = new DrainV2();
        vm.prank(artist);
        vm.expectRevert(bytes("PND: settle pending"));
        p.upgradeToAndCall(address(v2), "");

        // The only way to clear the gate is to pay everyone what they are owed
        // (withdraw is permissionless, so anyone can flush each payee).
        p.withdraw(surface);
        p.withdraw(artist);
        assertEq(surface.balance, 0.1 ether);
        assertEq(artist.balance, 0.9 ether);
        assertEq(address(p).balance, 0);

        // Now an upgrade is allowed, but there is nothing left to steal.
        vm.prank(artist);
        p.upgradeToAndCall(address(v2), "");
        address payable thief = payable(makeAddr("thief"));
        DrainV2(payable(address(p))).sweep(thief);
        assertEq(thief.balance, 0);
    }

    // ════════════════════════════════════════════════════════════════════════
    // H2 (FIXED via honest signal) — freezeMetadata alone is not permanence;
    // isPermanent() correctly reports false while still upgradeable.
    // ════════════════════════════════════════════════════════════════════════

    function test_fix_H2_isPermanentRequiresSealAndFreeze() public {
        PNDEditions p = _edition(_freeConfig());
        assertFalse(p.isPermanent());

        vm.prank(artist);
        p.freezeMetadata();
        assertTrue(p.isMetadataFrozen());
        assertFalse(p.isPermanent()); // frozen but still upgradeable: NOT permanent

        vm.prank(artist);
        p.seal();
        assertTrue(p.isPermanent()); // sealed AND frozen: the real guarantee
    }

    function test_PoC_H2_frozenArtStillMutableWhileUnsealed() public {
        // The honest signal (isPermanent) is the fix; the underlying fact remains
        // that an UNSEALED frozen edition can still have its art rewritten by an
        // upgrade. A free edition owes nothing, so the settle gate does not apply.
        PNDEditions p = _edition(_freeConfig());
        vm.prank(collector);
        p.mint(1);
        vm.prank(artist);
        p.freezeMetadata();
        assertFalse(p.isPermanent());
        assertTrue(_startsWith(p.tokenURI(1), "data:application/json;base64,"));

        ArtRugV2 v2 = new ArtRugV2();
        vm.prank(artist);
        p.upgradeToAndCall(address(v2), "");
        assertEq(p.tokenURI(1), "rugged://art-changed-after-freeze");
    }

    // ════════════════════════════════════════════════════════════════════════
    // M2 (FIXED) — setMintHook is locked once sealed.
    // ════════════════════════════════════════════════════════════════════════

    function test_fix_M2_mintHookLockedAfterSeal() public {
        PNDEditions p = _edition(_freeConfig());
        AlwaysRejectHook blocker = new AlwaysRejectHook();

        vm.startPrank(artist);
        p.seal();
        vm.expectRevert(bytes("PND: sealed"));
        p.setMintHook(address(blocker)); // can no longer install a blocking hook
        vm.stopPrank();

        // Minting still works on the sealed edition: terms are now fixed.
        vm.prank(collector);
        p.mint(1);
        assertEq(p.balanceOf(collector), 1);
    }

    // ════════════════════════════════════════════════════════════════════════
    // M3 (FIXED) — renounceOwnership is disabled; proceeds can never route to 0.
    // ════════════════════════════════════════════════════════════════════════

    function test_fix_M3_renounceDisabled() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));

        vm.prank(artist);
        vm.expectRevert(bytes("PND: renounce disabled"));
        p.renounceOwnership();
        assertEq(p.owner(), artist);

        // Proceeds still route to a real owner, never to address(0).
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1);
        assertEq(p.pendingWithdrawal(artist), 1 ether);
        assertEq(p.pendingWithdrawal(address(0)), 0);

        // withdraw rejects the zero address outright.
        vm.expectRevert(bytes("PND: zero account"));
        p.withdraw(address(0));
    }

    // ════════════════════════════════════════════════════════════════════════
    // L2 (FIXED) — royalty capped at MAX_ROYALTY_BPS (50%).
    // ════════════════════════════════════════════════════════════════════════

    function test_fix_L2_royaltyCapped() public {
        EditionConfig memory tooHigh = _freeConfig();
        tooHigh.royaltyBps = 5001;
        vm.expectRevert(bytes("PND: royalty too high"));
        factory.createEdition("X", "X", artist, tooHigh);

        EditionConfig memory ok = _freeConfig();
        ok.royaltyBps = 5000;
        PNDEditions p = _edition(ok); // 50% is allowed
        (, uint256 amount) = p.royaltyInfo(1, 1 ether);
        assertEq(amount, 0.5 ether);
    }

    // ════════════════════════════════════════════════════════════════════════
    // L3 (FIXED) — renderer escapes control characters per RFC 8259.
    // ════════════════════════════════════════════════════════════════════════

    function test_fix_L3_rendererEscapesControlChars() public {
        RendererHarness h = new RendererHarness();
        assertEq(h.esc("plain"), "plain");
        assertEq(h.esc("a\"b"), "a\\\"b"); // quote
        assertEq(h.esc("a\\b"), "a\\\\b"); // backslash
        assertEq(h.esc("a\nb"), "a\\nb"); // newline -> \n
        assertEq(h.esc("a\tb"), "a\\tb"); // tab -> \t
        assertEq(h.esc(string(hex"01")), "\\u0001"); // other control -> \u00XX
    }

    // ════════════════════════════════════════════════════════════════════════
    // L4 (FIXED) — rescueStrayETH sweeps only ETH not owed to any payee.
    // ════════════════════════════════════════════════════════════════════════

    function test_fix_L4_rescueOnlySweepsStray() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1); // 1 ETH owed to artist, balance 1 ETH

        // Simulate 0.5 ETH force-fed (selfdestruct / coinbase): balance now 1.5.
        vm.deal(address(p), 1.5 ether);

        address dest = makeAddr("rescueDest");
        vm.prank(artist);
        p.rescueStrayETH(dest);
        assertEq(dest.balance, 0.5 ether); // only the stray surplus
        assertEq(address(p).balance, 1 ether); // owed balance untouched

        // The artist's owed 1 ETH is still fully claimable.
        p.withdraw(artist);
        assertEq(artist.balance, 1 ether);

        // Nothing stray left -> rescue reverts.
        vm.prank(artist);
        vm.expectRevert(bytes("PND: no stray eth"));
        p.rescueStrayETH(dest);
    }

    // ════════════════════════════════════════════════════════════════════════
    // L5 (FIXED) — two-step ownership transfer.
    // ════════════════════════════════════════════════════════════════════════

    function test_fix_L5_ownableTwoStep() public {
        PNDEditions p = _edition(_freeConfig());
        address newOwner = makeAddr("newOwner");

        vm.prank(artist);
        p.transferOwnership(newOwner);
        assertEq(p.owner(), artist); // not transferred until accepted
        assertEq(p.pendingOwner(), newOwner);

        // A stranger cannot accept.
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        p.acceptOwnership();

        vm.prank(newOwner);
        p.acceptOwnership();
        assertEq(p.owner(), newOwner);
    }

    // ════════════════════════════════════════════════════════════════════════
    // M1 (framing, not a contract change) — a minter can self-deal the 10%.
    // The artist's enforceable floor is 90%, surfaced honestly in copy/UI.
    // ════════════════════════════════════════════════════════════════════════

    function test_PoC_M1_minterSelfDealsTenPercent() public {
        PNDEditions p = _edition(_pricedConfig(1 ether));
        address minter = makeAddr("minter");
        address minterAlt = makeAddr("minterAlt"); // also the minter's
        vm.deal(minter, 1 ether);
        vm.prank(minter);
        p.mintWithRewards{value: 1 ether}(1, minterAlt, "");

        assertEq(p.pendingWithdrawal(minterAlt), 0.1 ether); // clawed back
        assertEq(p.pendingWithdrawal(artist), 0.9 ether); // artist floor is 90%
        p.withdraw(minterAlt);
        assertEq(minterAlt.balance, 0.1 ether);
    }

    // ════════════════════════════════════════════════════════════════════════
    // M4 (mitigated by the PerWalletCapHook, not the core) — one tx can buy out
    // a capped edition. Core stays minimal; artists opt into the cap hook.
    // ════════════════════════════════════════════════════════════════════════

    function test_PoC_M4_oneTxBuysOutCappedEdition() public {
        EditionConfig memory cfg = _pricedConfig(0.01 ether);
        cfg.supplyCap = 100;
        PNDEditions p = _edition(cfg);

        address whale = makeAddr("whale");
        uint256 total = 0.01 ether * 100;
        vm.deal(whale, total);
        vm.prank(whale);
        p.mint{value: total}(100);

        assertEq(p.balanceOf(whale), 100);
        (, EditionStatus status, uint256 minted) = p.config();
        assertEq(minted, 100);
        assertEq(uint8(status), uint8(EditionStatus.Closed));
    }

    // ════════════════════════════════════════════════════════════════════════
    // M5 (indexer-layer fix, deploy-gated) — anyone can deploy an edition
    // attributed to any address.
    // ════════════════════════════════════════════════════════════════════════

    function test_PoC_M5_anyoneDeploysEditionOwnedByAVictim() public {
        address victimArtist = makeAddr("famousArtist");
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        PNDEditions fake =
            PNDEditions(factory.createEdition("Famous Artist Drop", "FAKE", victimArtist, _freeConfig()));
        assertTrue(factory.isEdition(address(fake)));
        assertEq(fake.owner(), victimArtist);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Defensive confirmations (must never regress).
    // ════════════════════════════════════════════════════════════════════════

    function test_confirm_implCannotBeInitialized() public {
        EditionConfig memory cfg = _freeConfig();
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        impl.initialize("X", "X", artist, cfg, address(renderer));
    }

    function test_confirm_withdrawReentrancyBlocked() public {
        Reenterer r = new Reenterer();
        EditionConfig memory cfg = _pricedConfig(1 ether);
        cfg.payoutAddress = address(r);
        PNDEditions p = _edition(cfg);

        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1);

        r.arm(p);
        vm.expectRevert(); // re-entrant receive reverts -> withdraw fails
        p.withdraw(address(r));
        assertEq(p.pendingWithdrawal(address(r)), 1 ether); // still owed, intact
    }

    function testFuzz_confirm_mintMarkProvenanceExact(uint8 batchesRaw) public {
        uint256 batches = bound(batchesRaw, 1, 12);
        uint256 perBatch = 2;
        EditionConfig memory cfg = _freeConfig();
        cfg.supplyCap = batches * perBatch;
        PNDEditions p = _edition(cfg);

        for (uint256 b = 0; b < batches; b++) {
            address s = (b % 2 == 0) ? surface : address(0);
            vm.prank(collector);
            if (s == address(0)) p.mint(perBatch);
            else p.mintWithRewards(perBatch, s, "");
        }

        uint256 totalMinted = batches * perBatch;
        for (uint256 t = 1; t <= totalMinted; t++) {
            MintMark memory m = p.mintMarkOf(t);
            assertEq(m.indexInEdition, t - 1, "index");
            assertEq(m.isFirst, t == 1, "isFirst");
            uint256 batchIdx = (t - 1) / perBatch;
            address expectS = (batchIdx % 2 == 0) ? surface : address(0);
            assertEq(m.surface, expectS, "surface mapping");
            assertEq(m.isFinal, t == totalMinted, "isFinal");
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        if (sb.length < pb.length) return false;
        for (uint256 i = 0; i < pb.length; i++) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
    }
}
