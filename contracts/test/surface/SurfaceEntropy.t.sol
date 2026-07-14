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

/// @dev tokenSeed() + mintIndex provenance: nonzero, distinct across tokens
///      in one tx and across txs (varying prevrandao), stable across
///      transfers, re-rolled on pooled re-mint, and mintIndex monotonic
///      across BOTH the paid path and the extension paths.
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
        vm.prank(collector);
        c.mint(qty);
        for (uint256 t = 1; t <= qty; t++) {
            assertTrue(c.tokenSeed(t) != bytes32(0), "seed must be nonzero");
        }
    }

    // ── seeds distinct across tokens minted in ONE tx ────────────────────

    function test_seed_distinctAcrossTokensInOneTx() public {
        Surface c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(5); // ids 1..5, all in one tx / one block

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
        vm.prank(collector);
        c.mint(1); // token 1

        vm.prevrandao(bytes32(randaoB));
        vm.prank(collector);
        c.mint(1); // token 2

        assertTrue(c.tokenSeed(1) != c.tokenSeed(2), "seeds must differ across txs with different prevrandao");
    }

    // ── seed is stable across transfers ──────────────────────────────────

    function test_seed_stableAcrossTransfer() public {
        Surface c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(1);
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

        minter.callMintToId(IPooledSurface(address(c)), collector, 1, address(0), "");
        bytes32 seed1 = c.tokenSeed(1);

        minter.callBurn(ISurfaceCore(address(c)), 1);

        vm.prevrandao(bytes32(uint256(12345)));
        minter.callMintToId(IPooledSurface(address(c)), collector, 1, address(0), "");
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
            minter.callMintToId(IPooledSurface(address(c)), collector, 7, address(0), "");
            bytes32 seed = c.tokenSeed(7);
            assertTrue(seed != prevSeed, "each re-mint cycle must re-roll the seed");
            prevSeed = seed;
            minter.callBurn(ISurfaceCore(address(c)), 7);
        }
    }

    // ── mint order is monotonic across BOTH mint paths (event-stamped) ───
    // Order is not stored per token: sequential order IS the token id, and
    // every Minted event carries firstMintIndex. These tests pin the emitted
    // index against the expected global counter across path interleavings.

    function test_mintIndex_monotonic_acrossPaidAndExtensionPaths() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 1, 2, 0, SurfaceStatus.Open);
        vm.prank(collector);
        c.mint(2); // tokens 1,2 -> indexes 0,1

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 3, 1, 2, SurfaceStatus.Open);
        uint256 tokenId3 = minter.callMintTo(ISurface(address(c)), collector, address(0), "");
        assertEq(tokenId3, 3); // continues the same counter: id == order + 1

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 4, 1, 3, SurfaceStatus.Open);
        vm.prank(collector);
        c.mint(1); // token 4
    }

    function test_mintIndex_monotonic_pooledMode_acrossBurnRemint() public {
        PooledSurface c = _pooled(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 1, 1, 0, SurfaceStatus.Open);
        minter.callMintToId(IPooledSurface(address(c)), collector, 1, address(0), "");
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 2, 1, 1, SurfaceStatus.Open);
        minter.callMintToId(IPooledSurface(address(c)), collector, 2, address(0), "");

        minter.callBurn(ISurfaceCore(address(c)), 1);
        // Re-mint of id 1 is index 2, NOT 0 again: order never repeats.
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 1, 1, 2, SurfaceStatus.Open);
        minter.callMintToId(IPooledSurface(address(c)), collector, 1, address(0), "");

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(collector, address(0), 3, 1, 3, SurfaceStatus.Open);
        minter.callMintToId(IPooledSurface(address(c)), collector, 3, address(0), "");
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
                emit ISurfaceCore.Minted(
                    collector, address(0), nextTokenId, qty, expectedIndex, SurfaceStatus.Open
                );
                vm.prank(collector);
                c.mint(qty);
                nextTokenId += qty;
                expectedIndex += qty;
            } else {
                vm.expectEmit(true, true, false, true, address(c));
                emit ISurfaceCore.Minted(collector, address(0), nextTokenId, 1, expectedIndex, SurfaceStatus.Open);
                uint256 tokenId = minter.callMintTo(ISurface(address(c)), collector, address(0), "");
                assertEq(tokenId, nextTokenId);
                nextTokenId++;
                expectedIndex++;
            }
        }
    }
}
