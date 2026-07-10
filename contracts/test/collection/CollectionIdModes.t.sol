// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";
import {MockMinter} from "./mocks/CollectionMocks.sol";

import {Collection} from "../../src/collection/Collection.sol";
import {ICollection} from "../../src/collection/interfaces/ICollection.sol";
import {CollectionConfig, CollectionStatus, IdMode, MintMark} from "../../src/collection/CollectionTypes.sol";

/// @dev Sequential vs Pooled id-mode semantics: which mint paths are legal in
///      which mode, burn/re-mint behavior, and cap semantics per mode (cap
///      bounds mints-ever in Sequential; cap bounds live totalSupply in
///      Pooled).
contract CollectionIdModesTest is CollectionBase {
    MockMinter internal minter;

    function setUp() public override {
        super.setUp();
        minter = new MockMinter();
    }

    // ════════════════════════════════════════════════════════════════════
    // Mode-gating: each mode only accepts its own extension entrypoint (and
    // only Sequential accepts the built-in paid path).
    // ════════════════════════════════════════════════════════════════════

    function test_sequential_rejectsMintToId() public {
        Collection c = _collection(_freeConfig()); // Sequential
        address[] memory minters = new address[](1);
        minters[0] = address(minter);
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.expectRevert(ICollection.SequentialAssignsIds.selector);
        minter.callMintToId(ICollection(address(c)), collector, 1, address(0), "");
    }

    function test_pooled_rejectsMintTo() public {
        Collection c = _collection(_pooledConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.expectRevert(ICollection.PooledNeedsMintToId.selector);
        minter.callMintTo(ICollection(address(c)), collector, address(0), "");
    }

    function test_pooled_rejectsPaidMint() public {
        Collection c = _collection(_pooledConfig());
        vm.expectRevert(ICollection.PooledSellsViaMinter.selector);
        vm.prank(collector);
        c.mint(1);
    }

    function test_pooled_rejectsPaidMintWithReferral() public {
        Collection c = _collection(_pooledConfig());
        vm.expectRevert(ICollection.PooledSellsViaMinter.selector);
        vm.prank(collector);
        c.mintWithReferral(1, referrer, "");
    }

    function test_sequential_mintToWorks() public {
        Collection c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        uint256 tokenId = minter.callMintTo(ICollection(address(c)), collector, address(0), "");
        assertEq(tokenId, 1);
        assertEq(c.ownerOf(1), collector);
    }

    // ════════════════════════════════════════════════════════════════════
    // Pooled burn -> re-mint same id: fresh mark, fresh seed, correct supply.
    // ════════════════════════════════════════════════════════════════════

    function test_pooled_burnThenRemintSameId_freshMarkAndSeed() public {
        Collection c = _collection(_pooledConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        minter.callMintToId(ICollection(address(c)), collector, 5, referrer, "");
        assertEq(c.totalSupply(), 1);
        MintMark memory firstMark = c.mintMarkOf(5);
        bytes32 firstSeed = c.tokenSeed(5);
        assertEq(firstMark.mintIndex, 0);

        minter.callBurn(ICollection(address(c)), 5);
        assertEq(c.totalSupply(), 0);
        // Mark and seed remain readable for the burned instance until re-mint.
        assertEq(c.mintMarkOf(5).mintIndex, firstMark.mintIndex);
        assertEq(c.tokenSeed(5), firstSeed);

        // Vary prevrandao so the re-minted seed is guaranteed to differ, not
        // just incidentally different.
        vm.prevrandao(bytes32(uint256(999)));
        address newReferrer = makeAddr("newReferrer");
        // The re-mint's Minted event carries the NEW instance's context
        // (referrer is event-only provenance; the record stores block + order).
        vm.expectEmit(true, true, false, false, address(c));
        emit ICollection.Minted(
            stranger, newReferrer, 5, 1, 1, uint48(block.number), CollectionStatus.Open
        );
        minter.callMintToId(ICollection(address(c)), stranger, 5, newReferrer, "");

        assertEq(c.ownerOf(5), stranger);
        assertEq(c.totalSupply(), 1);
        MintMark memory secondMark = c.mintMarkOf(5);
        assertEq(secondMark.mintIndex, 1); // mintedEver keeps advancing, never reused
        assertFalse(secondMark.isFirst); // index 1, not 0

        bytes32 secondSeed = c.tokenSeed(5);
        assertTrue(secondSeed != firstSeed, "seed must be re-rolled on pooled re-mint");
    }

    function test_pooled_burnReturnsSlotToCapBudget() public {
        CollectionConfig memory cfg = _pooledConfig();
        cfg.supplyCap = 1; // live-supply cap of 1
        Collection c = _collection(cfg);
        vm.prank(artist);
        c.setMinter(address(minter), true);

        minter.callMintToId(ICollection(address(c)), collector, 1, address(0), "");
        // At cap: a second distinct id cannot be minted while the first is alive.
        vm.expectRevert(ICollection.ExceedsCap.selector);
        minter.callMintToId(ICollection(address(c)), collector, 2, address(0), "");

        minter.callBurn(ICollection(address(c)), 1);
        // Burning frees the pooled cap budget (bounds LIVE supply, not
        // mints-ever), so a new id can now be minted.
        minter.callMintToId(ICollection(address(c)), collector, 2, address(0), "");
        assertEq(c.totalSupply(), 1);
    }

    function test_pooled_liveIdCannotBeMintedOver() public {
        Collection c = _collection(_pooledConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        minter.callMintToId(ICollection(address(c)), collector, 1, address(0), "");

        // OZ _mint reverts on an existing id: this IS the pooled-mode
        // correctness argument (a live id can never be minted over).
        vm.expectRevert(abi.encodeWithSignature("ERC721InvalidSender(address)", address(0)));
        minter.callMintToId(ICollection(address(c)), stranger, 1, address(0), "");
    }

    function test_pooled_id0IsMintable() public {
        Collection c = _collection(_pooledConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        minter.callMintToId(ICollection(address(c)), collector, 0, address(0), "");
        assertEq(c.ownerOf(0), collector);
        assertEq(c.totalSupply(), 1);
        assertTrue(c.mintMarkOf(0).isFirst);
    }

    // ════════════════════════════════════════════════════════════════════
    // Sequential ids never recycle after burn.
    // ════════════════════════════════════════════════════════════════════

    function test_sequential_idsNeverRecycleAfterBurn() public {
        Collection c = _collection(_freeConfig());
        vm.prank(collector);
        c.mint(3); // ids 1,2,3

        vm.prank(collector);
        c.burn(2);
        assertEq(c.totalSupply(), 2);

        vm.prank(collector);
        c.mint(1); // next id is 4, NOT the freed id 2
        assertEq(c.ownerOf(4), collector);
        assertEq(c.totalSupply(), 3);

        // id 2 stays burned; its mark is still readable, but it is not
        // re-mintable via the sequential path (no id-choosing entrypoint
        // exists for Sequential mode at all).
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 2));
        c.ownerOf(2);
        assertTrue(c.mintMarkOf(2).mintBlock != 0); // mark persists post-burn
    }

    // ════════════════════════════════════════════════════════════════════
    // Cap semantics per mode: Sequential bounds mints EVER; Pooled bounds
    // LIVE totalSupply.
    // ════════════════════════════════════════════════════════════════════

    function test_sequential_capBoundsMintsEver_burnDoesNotFreeSlots() public {
        CollectionConfig memory cfg = _freeConfig();
        cfg.supplyCap = 2;
        Collection c = _collection(cfg);

        vm.prank(collector);
        c.mint(2); // ids 1,2 -> mintedEver == cap
        vm.prank(collector);
        c.burn(1); // live supply now 1, but mintedEver stays 2

        vm.expectRevert(ICollection.ExceedsCap.selector);
        vm.prank(collector);
        c.mint(1); // cap bounds EVER minted, burn does not free a slot

        (, CollectionStatus status,) = c.config();
        assertEq(uint8(status), uint8(CollectionStatus.Closed));
    }

    function test_pooled_capBoundsLiveSupply_notMintsEver() public {
        CollectionConfig memory cfg = _pooledConfig();
        cfg.supplyCap = 2;
        Collection c = _collection(cfg);
        vm.prank(artist);
        c.setMinter(address(minter), true);

        minter.callMintToId(ICollection(address(c)), collector, 1, address(0), "");
        minter.callMintToId(ICollection(address(c)), collector, 2, address(0), "");
        vm.expectRevert(ICollection.ExceedsCap.selector);
        minter.callMintToId(ICollection(address(c)), collector, 3, address(0), "");

        minter.callBurn(ICollection(address(c)), 1);
        minter.callBurn(ICollection(address(c)), 2);
        // Even though mintedEver is already 2 == cap, LIVE supply is 0, so
        // pooled mode allows re-minting well past "2 mints ever."
        minter.callMintToId(ICollection(address(c)), collector, 3, address(0), "");
        minter.callMintToId(ICollection(address(c)), collector, 4, address(0), "");
        assertEq(c.totalSupply(), 2);

        vm.expectRevert(ICollection.ExceedsCap.selector);
        minter.callMintToId(ICollection(address(c)), collector, 5, address(0), "");
    }

    function test_pooled_zeroCapIsOpenSupply() public {
        Collection c = _collection(_pooledConfig()); // supplyCap == 0
        vm.prank(artist);
        c.setMinter(address(minter), true);
        for (uint256 i = 0; i < 10; i++) {
            minter.callMintToId(ICollection(address(c)), collector, i, address(0), "");
        }
        assertEq(c.totalSupply(), 10);
    }
}
