// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {MockMinter} from "./mocks/SurfaceMocks.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {ISurface} from "../../src/surface/interfaces/ISurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";
import {IPooledSurface} from "../../src/surface/interfaces/IPooledSurface.sol";
import {SurfaceConfig, SurfaceStatus} from "../../src/surface/SurfaceTypes.sol";

/// @dev Sequential vs Pooled form semantics. Each form is its own contract,
///      so the wrong entrypoint is not a guarded branch — it does not exist.
///      These tests assert the absence at the ABI level, plus burn/re-mint
///      behavior and the per-form cap semantics (cap bounds mints-ever in
///      Sequential; cap bounds live totalSupply in Pooled).
contract SurfaceIdModesTest is SurfaceBase {
    MockMinter internal minter;

    function setUp() public override {
        super.setUp();
        minter = new MockMinter();
    }

    // ════════════════════════════════════════════════════════════════════
    // Each form ships only its own doors. A call to the other form's
    // entrypoint hits no function at all and reverts in the dispatcher.
    // ════════════════════════════════════════════════════════════════════

    function test_sequential_hasNoMintToId() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.prank(address(minter));
        (bool ok,) = address(c)
            .call(
                abi.encodeWithSignature(
                    "mintToId(address,uint256,address,bytes)", collector, uint256(1), address(0), bytes("")
                )
            );
        assertFalse(ok, "sequential must not expose mintToId");
    }

    function test_pooled_hasNoMintTo() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.prank(address(minter));
        (bool ok,) =
            address(c).call(abi.encodeWithSignature("mintTo(address,address,bytes)", collector, address(0), bytes("")));
        assertFalse(ok, "pooled must not expose mintTo");
    }

    function test_pooled_hasNoPaidMint() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(collector);
        (bool ok,) = address(c).call(abi.encodeWithSignature("mint(uint256)", uint256(1)));
        assertFalse(ok, "pooled must not expose mint");
    }

    function test_pooled_hasNoPaidMintWithReferral() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(collector);
        (bool ok,) = address(c)
            .call(abi.encodeWithSignature("mintWithReferral(uint256,address,bytes)", uint256(1), referrer, bytes("")));
        assertFalse(ok, "pooled must not expose mintWithReferral");
    }

    function test_sequential_mintToWorks() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        uint256 tokenId = minter.callMintTo(ISurface(address(c)), collector, address(0), "");
        assertEq(tokenId, 1);
        assertEq(c.ownerOf(1), collector);
    }

    // ════════════════════════════════════════════════════════════════════
    // Pooled burn -> re-mint same id: fresh seed, correct supply.
    // ════════════════════════════════════════════════════════════════════

    function test_pooled_burnThenRemintSameId_freshSeedAndIndex() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        // First instance: the Minted event stamps firstMintIndex 0.
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, referrer, 5, 1, 0, SurfaceStatus.Open);
        minter.callMintToId(IPooledSurface(address(c)), collector, 5, referrer, "");
        assertEq(c.totalSupply(), 1);
        bytes32 firstSeed = c.tokenSeed(5);

        minter.callBurn(ISurfaceCore(address(c)), 5);
        assertEq(c.totalSupply(), 0);
        // The seed remains readable for the burned instance until re-mint.
        assertEq(c.tokenSeed(5), firstSeed);

        // Vary prevrandao so the re-minted seed is guaranteed to differ, not
        // just incidentally different.
        vm.prevrandao(bytes32(uint256(999)));
        address newReferrer = makeAddr("newReferrer");
        // The re-mint's Minted event carries the NEW instance's context:
        // mint order advances to 1 (never reused), fresh referrer stamped.
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(stranger, newReferrer, 5, 1, 1, SurfaceStatus.Open);
        minter.callMintToId(IPooledSurface(address(c)), stranger, 5, newReferrer, "");

        assertEq(c.ownerOf(5), stranger);
        assertEq(c.totalSupply(), 1);
        bytes32 secondSeed = c.tokenSeed(5);
        assertTrue(secondSeed != firstSeed, "seed must be re-rolled on pooled re-mint");
    }

    function test_pooled_burnReturnsSlotToCapBudget() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 1; // live-supply cap of 1
        PooledSurface c = _pooledWithMinters(cfg, _minterList());

        minter.callMintToId(IPooledSurface(address(c)), collector, 1, address(0), "");
        // At cap: a second distinct id cannot be minted while the first is alive.
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 1, 2));
        minter.callMintToId(IPooledSurface(address(c)), collector, 2, address(0), "");

        minter.callBurn(ISurfaceCore(address(c)), 1);
        // Burning frees the pooled cap budget (bounds LIVE supply, not
        // mints-ever), so a new id can now be minted.
        minter.callMintToId(IPooledSurface(address(c)), collector, 2, address(0), "");
        assertEq(c.totalSupply(), 1);
    }

    function test_pooled_liveIdCannotBeMintedOver() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        minter.callMintToId(IPooledSurface(address(c)), collector, 1, address(0), "");

        // OZ _mint reverts on an existing id: this IS the pooled-form
        // correctness argument (a live id can never be minted over).
        vm.expectRevert(abi.encodeWithSignature("ERC721InvalidSender(address)", address(0)));
        minter.callMintToId(IPooledSurface(address(c)), stranger, 1, address(0), "");
    }

    function test_pooled_id0IsMintable() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 0, 1, 0, SurfaceStatus.Open);
        minter.callMintToId(IPooledSurface(address(c)), collector, 0, address(0), "");
        assertEq(c.ownerOf(0), collector);
        assertEq(c.totalSupply(), 1);
        assertTrue(c.tokenSeed(0) != bytes32(0), "id 0 minted with entropy stamped");
    }

    // ════════════════════════════════════════════════════════════════════
    // Sequential ids never recycle after burn.
    // ════════════════════════════════════════════════════════════════════

    function test_sequential_idsNeverRecycleAfterBurn() public {
        Surface c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(3); // ids 1,2,3

        vm.prank(collector);
        c.burn(2);
        assertEq(c.totalSupply(), 2);

        vm.prank(collector);
        c.mint(1); // next id is 4, NOT the freed id 2
        assertEq(c.ownerOf(4), collector);
        assertEq(c.totalSupply(), 3);

        // id 2 stays burned; its seed is still readable, but it is not
        // re-mintable via the sequential contract (no id-choosing entrypoint
        // exists on it at all).
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 2));
        c.ownerOf(2);
        assertTrue(c.tokenSeed(2) != bytes32(0)); // seed persists post-burn
    }

    // ════════════════════════════════════════════════════════════════════
    // Cap semantics per form: Sequential bounds mints EVER; Pooled bounds
    // LIVE totalSupply.
    // ════════════════════════════════════════════════════════════════════

    function test_sequential_capBoundsMintsEver_burnDoesNotFreeSlots() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 2;
        Surface c = _collection(cfg);

        vm.prank(collector);
        c.mint(2); // ids 1,2 -> mintedEver == cap
        vm.prank(collector);
        c.burn(1); // live supply now 1, but mintedEver stays 2

        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 2, 3));
        vm.prank(collector);
        c.mint(1); // cap bounds EVER minted, burn does not free a slot

        (, SurfaceStatus status,) = c.config();
        assertEq(uint8(status), uint8(SurfaceStatus.Closed));
    }

    function test_pooled_capBoundsLiveSupply_notMintsEver() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 2;
        PooledSurface c = _pooledWithMinters(cfg, _minterList());

        minter.callMintToId(IPooledSurface(address(c)), collector, 1, address(0), "");
        minter.callMintToId(IPooledSurface(address(c)), collector, 2, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 2, 3));
        minter.callMintToId(IPooledSurface(address(c)), collector, 3, address(0), "");

        minter.callBurn(ISurfaceCore(address(c)), 1);
        minter.callBurn(ISurfaceCore(address(c)), 2);
        // Even though mintedEver is already 2 == cap, LIVE supply is 0, so
        // the pooled form allows re-minting well past "2 mints ever."
        minter.callMintToId(IPooledSurface(address(c)), collector, 3, address(0), "");
        minter.callMintToId(IPooledSurface(address(c)), collector, 4, address(0), "");
        assertEq(c.totalSupply(), 2);

        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 2, 3));
        minter.callMintToId(IPooledSurface(address(c)), collector, 5, address(0), "");
    }

    function test_pooled_zeroCapIsOpenSupply() public {
        PooledSurface c = _pooled(_freeConfig()); // supplyCap == 0
        vm.prank(artist);
        c.setMinter(address(minter), true);
        for (uint256 i = 0; i < 10; i++) {
            minter.callMintToId(IPooledSurface(address(c)), collector, i, address(0), "");
        }
        assertEq(c.totalSupply(), 10);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _minterList() internal view returns (address[] memory minters) {
        minters = new address[](1);
        minters[0] = address(minter);
    }
}
