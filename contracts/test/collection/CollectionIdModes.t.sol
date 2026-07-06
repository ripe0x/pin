// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";
import {MockMinter} from "./mocks/CollectionMocks.sol";

import {SovereignCollection} from "../../src/collection/SovereignCollection.sol";
import {ISovereignCollection} from "../../src/collection/interfaces/ISovereignCollection.sol";
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

    function test_sequential_rejectsMintToAt() public {
        SovereignCollection c = _collection(_freeConfig()); // Sequential
        address[] memory minters = new address[](1);
        minters[0] = address(minter);
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.expectRevert(bytes("SC: sequential assigns ids"));
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 1, address(0), "");
    }

    function test_pooled_rejectsMintTo() public {
        SovereignCollection c = _collection(_pooledConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        vm.expectRevert(bytes("SC: pooled needs mintToAt"));
        minter.callMintTo(ISovereignCollection(address(c)), collector, address(0), "");
    }

    function test_pooled_rejectsPaidMint() public {
        SovereignCollection c = _collection(_pooledConfig());
        vm.expectRevert(bytes("SC: pooled sells via minter"));
        vm.prank(collector);
        c.mint(1);
    }

    function test_pooled_rejectsPaidMintWithRewards() public {
        SovereignCollection c = _collection(_pooledConfig());
        vm.expectRevert(bytes("SC: pooled sells via minter"));
        vm.prank(collector);
        c.mintWithRewards(1, surface, "");
    }

    function test_sequential_mintToWorks() public {
        SovereignCollection c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        uint256 tokenId = minter.callMintTo(ISovereignCollection(address(c)), collector, address(0), "");
        assertEq(tokenId, 1);
        assertEq(c.ownerOf(1), collector);
    }

    // ════════════════════════════════════════════════════════════════════
    // Pooled burn -> re-mint same id: fresh mark, fresh seed, correct supply.
    // ════════════════════════════════════════════════════════════════════

    function test_pooled_burnThenRemintSameId_freshMarkAndSeed() public {
        SovereignCollection c = _collection(_pooledConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);

        minter.callMintToAt(ISovereignCollection(address(c)), collector, 5, surface, "");
        assertEq(c.totalSupply(), 1);
        MintMark memory firstMark = c.mintMarkOf(5);
        bytes32 firstSeed = c.tokenSeed(5);
        assertEq(firstMark.mintIndex, 0);
        assertEq(firstMark.surface, surface);

        vm.prank(collector);
        c.burn(5);
        assertEq(c.totalSupply(), 0);
        // Mark and seed remain readable for the burned instance until re-mint.
        assertEq(c.mintMarkOf(5).mintIndex, firstMark.mintIndex);
        assertEq(c.tokenSeed(5), firstSeed);

        // Vary prevrandao so the re-minted seed is guaranteed to differ, not
        // just incidentally different.
        vm.prevrandao(bytes32(uint256(999)));
        address newSurface = makeAddr("newSurface");
        minter.callMintToAt(ISovereignCollection(address(c)), stranger, 5, newSurface, "");

        assertEq(c.ownerOf(5), stranger);
        assertEq(c.totalSupply(), 1);
        MintMark memory secondMark = c.mintMarkOf(5);
        assertEq(secondMark.mintIndex, 1); // mintedEver keeps advancing, never reused
        assertEq(secondMark.surface, newSurface);
        assertFalse(secondMark.isFirst); // index 1, not 0

        bytes32 secondSeed = c.tokenSeed(5);
        assertTrue(secondSeed != firstSeed, "seed must be re-rolled on pooled re-mint");
    }

    function test_pooled_burnReturnsSlotToCapBudget() public {
        CollectionConfig memory cfg = _pooledConfig();
        cfg.supplyCap = 1; // live-supply cap of 1
        SovereignCollection c = _collection(cfg);
        vm.prank(artist);
        c.setMinter(address(minter), true);

        minter.callMintToAt(ISovereignCollection(address(c)), collector, 1, address(0), "");
        // At cap: a second distinct id cannot be minted while the first is alive.
        vm.expectRevert(bytes("SC: exceeds cap"));
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 2, address(0), "");

        vm.prank(collector);
        c.burn(1);
        // Burning frees the pooled cap budget (bounds LIVE supply, not
        // mints-ever), so a new id can now be minted.
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 2, address(0), "");
        assertEq(c.totalSupply(), 1);
    }

    function test_pooled_liveIdCannotBeMintedOver() public {
        SovereignCollection c = _collection(_pooledConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 1, address(0), "");

        // OZ _mint reverts on an existing id: this IS the pooled-mode
        // correctness argument (a live id can never be minted over).
        vm.expectRevert(abi.encodeWithSignature("ERC721InvalidSender(address)", address(0)));
        minter.callMintToAt(ISovereignCollection(address(c)), stranger, 1, address(0), "");
    }

    function test_pooled_id0IsMintable() public {
        SovereignCollection c = _collection(_pooledConfig());
        vm.prank(artist);
        c.setMinter(address(minter), true);
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 0, address(0), "");
        assertEq(c.ownerOf(0), collector);
        assertEq(c.totalSupply(), 1);
        assertTrue(c.mintMarkOf(0).isFirst);
    }

    // ════════════════════════════════════════════════════════════════════
    // Sequential ids never recycle after burn.
    // ════════════════════════════════════════════════════════════════════

    function test_sequential_idsNeverRecycleAfterBurn() public {
        SovereignCollection c = _collection(_freeConfig());
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
        SovereignCollection c = _collection(cfg);

        vm.prank(collector);
        c.mint(2); // ids 1,2 -> mintedEver == cap
        vm.prank(collector);
        c.burn(1); // live supply now 1, but mintedEver stays 2

        vm.expectRevert(bytes("SC: exceeds cap"));
        vm.prank(collector);
        c.mint(1); // cap bounds EVER minted, burn does not free a slot

        (, CollectionStatus status,) = c.config();
        assertEq(uint8(status), uint8(CollectionStatus.Closed));
    }

    function test_pooled_capBoundsLiveSupply_notMintsEver() public {
        CollectionConfig memory cfg = _pooledConfig();
        cfg.supplyCap = 2;
        SovereignCollection c = _collection(cfg);
        vm.prank(artist);
        c.setMinter(address(minter), true);

        minter.callMintToAt(ISovereignCollection(address(c)), collector, 1, address(0), "");
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 2, address(0), "");
        vm.expectRevert(bytes("SC: exceeds cap"));
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 3, address(0), "");

        vm.prank(collector);
        c.burn(1);
        vm.prank(collector);
        c.burn(2);
        // Even though mintedEver is already 2 == cap, LIVE supply is 0, so
        // pooled mode allows re-minting well past "2 mints ever."
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 3, address(0), "");
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 4, address(0), "");
        assertEq(c.totalSupply(), 2);

        vm.expectRevert(bytes("SC: exceeds cap"));
        minter.callMintToAt(ISovereignCollection(address(c)), collector, 5, address(0), "");
    }

    function test_pooled_zeroCapIsOpenSupply() public {
        SovereignCollection c = _collection(_pooledConfig()); // supplyCap == 0
        vm.prank(artist);
        c.setMinter(address(minter), true);
        for (uint256 i = 0; i < 10; i++) {
            minter.callMintToAt(ISovereignCollection(address(c)), collector, i, address(0), "");
        }
        assertEq(c.totalSupply(), 10);
    }
}
