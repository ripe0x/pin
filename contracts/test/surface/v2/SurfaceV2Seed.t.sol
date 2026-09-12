// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceV2Base} from "./SurfaceV2Base.sol";
import {MockSeedSourceV2} from "./mocks/SurfaceV2Mocks.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {ISurfaceV2, InitParamsV2} from "../../../src/surface/v2/interfaces/ISurfaceV2.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";

/// @dev Seed derivation, mintToSeeded, and the seedSource fallback. See
///      docs/pnd-surface-v2-plan.md, "what v2 adds" items 5-6, and
///      SurfaceV2._mintOne for the resolution order this file exercises.
contract SurfaceV2SeedTest is SurfaceV2Base {
    // ── default derivation ───────────────────────────────────────────────────

    function test_seed_defaultDerivation() public {
        vm.prevrandao(bytes32(uint256(0xC0FFEE)));
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        bytes32 expected = keccak256(abi.encode(block.prevrandao, address(c), uint256(1)));
        assertEq(c.tokenSeed(1), expected);
    }

    function testFuzz_seed_neverZero(uint8 qtyRaw, uint256 prevrandaoSeed) public {
        uint256 qty = bound(qtyRaw, 1, 20);
        vm.prevrandao(bytes32(prevrandaoSeed));
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, qty);
        for (uint256 t = 1; t <= qty; t++) {
            assertTrue(c.tokenSeed(t) != bytes32(0), "seed must be nonzero");
        }
    }

    function test_seed_distinctAcrossTokensInOneBatch() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 5); // ids 1..5, one tx, one block

        bytes32[] memory seeds = new bytes32[](5);
        for (uint256 t = 1; t <= 5; t++) {
            seeds[t - 1] = c.tokenSeed(t);
        }
        for (uint256 i = 0; i < 5; i++) {
            for (uint256 j = i + 1; j < 5; j++) {
                assertTrue(seeds[i] != seeds[j], "seeds within a batch must differ (tokenId varies)");
            }
        }
    }

    function testFuzz_seed_distinctAcrossTxs(uint256 randaoA, uint256 randaoB) public {
        vm.assume(randaoA != randaoB);
        SurfaceV2 c = _collection(_freeConfig());

        vm.prevrandao(bytes32(randaoA));
        _mintTo(c, collector, 1); // token 1

        vm.prevrandao(bytes32(randaoB));
        c.mintTo(collector, 1); // token 2 (already granted as minter by _mintTo above)

        assertTrue(c.tokenSeed(1) != c.tokenSeed(2), "seeds must differ across txs with different prevrandao");
    }

    function test_seed_stableAcrossTransfer() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        bytes32 before = c.tokenSeed(1);

        vm.prank(collector);
        c.transferFrom(collector, stranger, 1);

        assertEq(c.tokenSeed(1), before, "seed must not change on transfer");
    }

    // ── mintToSeeded: mixed zero/nonzero entries ─────────────────────────────

    function test_mintToSeeded_mixedZeroNonzeroEntries() public {
        vm.prevrandao(bytes32(uint256(0xABCDEF)));
        SurfaceV2 c = _collection(_freeConfig());

        bytes32 explicit2 = keccak256("explicit-seed-for-token-2");
        bytes32[] memory seeds = new bytes32[](3);
        seeds[0] = bytes32(0); // derives
        seeds[1] = explicit2; // stored verbatim
        seeds[2] = bytes32(0); // derives

        uint256 firstTokenId = _mintToSeeded(c, collector, seeds);
        assertEq(firstTokenId, 1);

        assertEq(c.tokenSeed(1), keccak256(abi.encode(block.prevrandao, address(c), uint256(1))));
        assertEq(c.tokenSeed(2), explicit2);
        assertEq(c.tokenSeed(3), keccak256(abi.encode(block.prevrandao, address(c), uint256(3))));
    }

    function test_mintToSeeded_zeroQuantityReverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);
        bytes32[] memory seeds = new bytes32[](0);
        vm.expectRevert(ISurfaceV2.ZeroQuantity.selector);
        c.mintToSeeded(collector, seeds);
    }

    function test_mintToSeeded_capEnforced() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 2;
        SurfaceV2 c = _collection(cfg);
        vm.prank(artist);
        c.setMinter(address(this), true);

        bytes32[] memory seeds = new bytes32[](3);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.ExceedsCap.selector, 2, 3));
        c.mintToSeeded(collector, seeds);
    }

    function test_mintToSeeded_eventShape() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);
        bytes32[] memory seeds = new bytes32[](2);
        seeds[1] = keccak256("x");

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceV2.Minted(address(this), collector, 1, 2, 1);
        c.mintToSeeded(collector, seeds);
    }

    // ── seedSource fallback ───────────────────────────────────────────────────

    function test_seedSource_mintTo_skipsStorageServesFromSourceLive() public {
        MockSeedSourceV2 source = new MockSeedSourceV2();
        SurfaceV2 c = _collectionWithSeedSource(_freeConfig(), address(source));
        assertEq(c.seedSource(), address(source));

        _mintTo(c, collector, 1);
        // Nothing set on the source yet: it returns its default (0), and no
        // stored seed exists to override it.
        assertEq(c.tokenSeed(1), bytes32(0));

        // A later write to the source resolves live, with no re-mint: the
        // reveal pattern this fallback exists for.
        bytes32 revealed = keccak256("revealed-later");
        source.setSeed(address(c), 1, revealed);
        assertEq(c.tokenSeed(1), revealed);
    }

    function test_seedSource_minterSuppliedSeedWinsOverSource() public {
        MockSeedSourceV2 source = new MockSeedSourceV2();
        SurfaceV2 c = _collectionWithSeedSource(_freeConfig(), address(source));

        bytes32 sourceSeed = keccak256("from-source");
        source.setSeed(address(c), 1, sourceSeed);

        bytes32 suppliedSeed = keccak256("from-minter");
        bytes32[] memory seeds = new bytes32[](1);
        seeds[0] = suppliedSeed;
        _mintToSeeded(c, collector, seeds);

        assertEq(c.tokenSeed(1), suppliedSeed, "stored minter-supplied seed wins over the source");
    }

    function test_seedSource_revertPropagates() public {
        MockSeedSourceV2 source = new MockSeedSourceV2();
        SurfaceV2 c = _collectionWithSeedSource(_freeConfig(), address(source));
        _mintTo(c, collector, 1);

        source.setRevertFor(address(c), 1, true);
        vm.expectRevert(MockSeedSourceV2.SeedNotReady.selector);
        c.tokenSeed(1);
    }

    // ── tokenSeed bounds ──────────────────────────────────────────────────────

    function test_tokenSeed_neverMinted_zeroId() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.NeverMinted.selector);
        c.tokenSeed(0);
    }

    function test_tokenSeed_neverMinted_aboveMintedEver() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 2);
        vm.expectRevert(ISurfaceV2.NeverMinted.selector);
        c.tokenSeed(3);
    }

    function test_tokenSeed_readableAfterBurn() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        bytes32 seed = c.tokenSeed(1);
        assertTrue(seed != bytes32(0));

        vm.prank(collector);
        c.burn(1);
        assertEq(c.tokenSeed(1), seed, "seed stays readable for a burned id");
    }

    // ── seedSource: init-only, no setter ──────────────────────────────────────

    function test_init_rejectsCodelessSeedSource() public {
        address eoa = makeAddr("eoaSeedSource");
        InitParamsV2 memory p = _rawInitParams(_freeConfig());
        p.seedSource = eoa;
        SurfaceV2 clone = _freshClone();
        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.SeedSourceNotContract.selector, eoa));
        clone.initialize(p);
    }

    function test_init_acceptsContractSeedSource() public {
        MockSeedSourceV2 source = new MockSeedSourceV2();
        SurfaceV2 c = _collectionWithSeedSource(_freeConfig(), address(source));
        assertEq(c.seedSource(), address(source));
    }

    function test_init_zeroSeedSourceDisablesFallback() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertEq(c.seedSource(), address(0));
    }

    /// @dev No setter exists: the selector a hypothetical setSeedSource(address)
    ///      would use does not resolve on the token at all.
    function test_seedSource_hasNoSetter() public {
        SurfaceV2 c = _collection(_freeConfig());
        (bool ok,) = address(c).call(abi.encodeWithSignature("setSeedSource(address)", address(0)));
        assertFalse(ok, "seedSource must have no setter");
    }
}
