// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {MockMinter} from "./mocks/SurfaceMocks.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {ISurface} from "../../src/surface/interfaces/ISurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";
import {IPooledSurface} from "../../src/surface/interfaces/IPooledSurface.sol";

/// @dev tokenSeed() + mintIndex provenance: nonzero, distinct across tokens
///      in one tx and across txs (varying prevrandao), stable across
///      transfers, re-rolled on pooled re-mint, and mintIndex monotonic
///      across interleaved mintTo/mintToId calls.
contract SurfaceEntropyTest is SurfaceBase {
    MockMinter internal minter;

    function setUp() public override {
        super.setUp();
        minter = new MockMinter();
    }

    // ── seeds are nonzero ─────────────────────────────────────────────────

    function testFuzz_seed_neverZero(uint8 qtyRaw, uint256 prevrandaoSeed) public {
        uint256 qty = bound(qtyRaw, 1, 20);
        vm.prevrandao(bytes32(prevrandaoSeed));
        Surface c = _collection(_freeConfig());
        _mintTo(c, collector, qty);
        for (uint256 t = 1; t <= qty; t++) {
            assertTrue(c.tokenSeed(t) != bytes32(0), "seed must be nonzero");
        }
    }

    // ── seeds distinct across tokens minted in ONE tx ────────────────────

    function test_seed_distinctAcrossTokensInOneTx() public {
        Surface c = _collection(_freeConfig());
        _mintTo(c, collector, 5); // ids 1..5, all in one tx / one block

        bytes32[] memory seeds = new bytes32[](5);
        for (uint256 t = 1; t <= 5; t++) {
            seeds[t - 1] = c.tokenSeed(t);
        }
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = i + 1; j < 5; j++) {
                assertTrue(seeds[i] != seeds[j], "seeds within a batch must differ (tokenId/mintIndex vary)");
            }
        }
    }

    // ── seeds distinct across DIFFERENT txs (varying prevrandao) ─────────

    function testFuzz_seed_distinctAcrossTxs(uint256 randaoA, uint256 randaoB) public {
        vm.assume(randaoA != randaoB);
        Surface c = _collection(_freeConfig());

        vm.prevrandao(bytes32(randaoA));
        _mintTo(c, collector, 1); // token 1

        vm.prevrandao(bytes32(randaoB));
        _mintTo(c, collector, 1); // token 2

        assertTrue(c.tokenSeed(1) != c.tokenSeed(2), "seeds must differ across txs with different prevrandao");
    }

    // ── seed is stable across transfers ──────────────────────────────────

    function test_seed_stableAcrossTransfer() public {
        Surface c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        bytes32 before = c.tokenSeed(1);

        vm.prank(collector);
        c.transferFrom(collector, stranger, 1);

        assertEq(c.tokenSeed(1), before, "seed must not change on transfer");
        assertEq(c.ownerOf(1), stranger);
    }

    // ── seed is re-rolled on pooled re-mint ──────────────────────────────

    function test_seed_reRolledOnPooledRemint() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        minter.callMintToId(IPooledSurface(address(c)), collector, 1);
        bytes32 seed1 = c.tokenSeed(1);

        minter.callBurn(ISurfaceCore(address(c)), 1);

        vm.prevrandao(bytes32(uint256(12345)));
        minter.callMintToId(IPooledSurface(address(c)), collector, 1);
        bytes32 seed2 = c.tokenSeed(1);

        assertTrue(seed1 != seed2, "re-mint must produce a fresh seed");
    }

    function testFuzz_seed_reRolledAcrossManyPooledCycles(uint8 cyclesRaw) public {
        uint256 cycles = bound(cyclesRaw, 1, 8);
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        bytes32 prevSeed = bytes32(0);
        for (uint256 i = 0; i < cycles; i++) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode("cycle", i)))));
            minter.callMintToId(IPooledSurface(address(c)), collector, 7);
            bytes32 seed = c.tokenSeed(7);
            assertTrue(seed != prevSeed, "each re-mint cycle must re-roll the seed");
            prevSeed = seed;
            minter.callBurn(ISurfaceCore(address(c)), 7);
        }
    }

    // ── mint order is monotonic across interleaved batch/single mints ────
    // Order is not stored per token: sequential order IS the token id, and
    // every Minted event carries firstMintIndex.

    function test_mintIndex_monotonic_acrossInterleavedMints() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(address(minter), collector, 1, 2, 0);
        minter.callMintTo(ISurface(address(c)), collector, 2); // tokens 1,2 -> indexes 0,1

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(address(minter), collector, 3, 1, 2);
        uint256 tokenId3 = minter.callMintTo(ISurface(address(c)), collector, 1);
        assertEq(tokenId3, 3); // continues the same counter: id == order + 1

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(address(minter), collector, 4, 1, 3);
        minter.callMintTo(ISurface(address(c)), collector, 1); // token 4
    }

    function test_mintIndex_monotonic_pooledMode_acrossBurnRemint() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(address(minter), collector, 1, 1, 0);
        minter.callMintToId(IPooledSurface(address(c)), collector, 1);
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(address(minter), collector, 2, 1, 1);
        minter.callMintToId(IPooledSurface(address(c)), collector, 2);

        minter.callBurn(ISurfaceCore(address(c)), 1);
        // Re-mint of id 1 is index 2, NOT 0 again: order never repeats.
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(address(minter), collector, 1, 1, 2);
        minter.callMintToId(IPooledSurface(address(c)), collector, 1);

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(address(minter), collector, 3, 1, 3);
        minter.callMintToId(IPooledSurface(address(c)), collector, 3);
    }

    // ── batch mint produces the same per-token seeds a run of sequential ──
    // ── single mints would (fix: _mintedEver hoisted out of the loop) ────
    //
    // _mintOne no longer writes _mintedEver itself; the caller (mintTo's
    // loop) now passes each token's mintIndex explicitly and writes
    // _mintedEver once after the loop. This proves that refactor did not
    // change which mintIndex any token in a batch is stamped with: each
    // token's seed is checked against the formula computed with the
    // mintIndex a sequential run of single mints would have produced for
    // that same token (0, 1, 2, ... in mint order), on two independently
    // cloned collections minting in the same block (same prevrandao).

    function test_batchMint_seedsMatchSequentialMintIndexFormula_sameAsSingleMints() public {
        Surface batchColl = _collection(_freeConfig());
        vm.prank(artist);
        batchColl.setMinter(address(minter), true);

        Surface singleColl = _collection(_freeConfig());
        vm.prank(artist);
        singleColl.setMinter(address(minter), true);

        vm.prevrandao(bytes32(uint256(0xC0FFEE)));
        uint256 n = 6;

        // One batch call of quantity n on batchColl.
        minter.callMintTo(ISurface(address(batchColl)), collector, n);

        // n sequential quantity-1 calls on singleColl, same block/prevrandao,
        // so each call consumes mintIndex 0, 1, ..., n-1 in turn exactly as
        // the batch call's loop does.
        for (uint256 i = 0; i < n; i++) {
            minter.callMintTo(ISurface(address(singleColl)), collector, 1);
        }

        for (uint256 i = 0; i < n; i++) {
            uint256 tokenId = i + 1;
            uint256 mintIndex = i;
            bytes32 expectedBatch = keccak256(abi.encode(block.prevrandao, address(batchColl), tokenId, mintIndex));
            bytes32 expectedSingle = keccak256(abi.encode(block.prevrandao, address(singleColl), tokenId, mintIndex));
            assertEq(batchColl.tokenSeed(tokenId), expectedBatch, "batch seed must use the sequential mintIndex i");
            assertEq(
                singleColl.tokenSeed(tokenId), expectedSingle, "single-mint seed must use the sequential mintIndex i"
            );
        }
    }

    function testFuzz_mintIndex_monotonic_interleavedBatchesAndSingles(uint8 batchesRaw) public {
        uint256 batches = bound(batchesRaw, 1, 10);
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        uint256 expectedIndex = 0;
        uint256 nextTokenId = 1;
        for (uint256 b = 0; b < batches; b++) {
            if (b % 2 == 0) {
                uint256 qty = (b % 6) + 1;
                // The event stamps the batch's first index; ids advance in
                // lockstep with the counter (sequential id == index + 1).
                vm.expectEmit(true, true, false, true, address(c));
                emit ISurfaceCore.Minted(address(minter), collector, nextTokenId, qty, expectedIndex);
                minter.callMintTo(ISurface(address(c)), collector, qty);
                nextTokenId += qty;
                expectedIndex += qty;
            } else {
                vm.expectEmit(true, true, false, true, address(c));
                emit ISurfaceCore.Minted(address(minter), collector, nextTokenId, 1, expectedIndex);
                uint256 tokenId = minter.callMintTo(ISurface(address(c)), collector, 1);
                assertEq(tokenId, nextTokenId);
                nextTokenId++;
                expectedIndex++;
            }
        }
    }
}
