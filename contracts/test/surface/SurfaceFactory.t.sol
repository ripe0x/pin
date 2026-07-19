// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {FixedPriceMinterBase} from "./minters/FixedPriceMinterBase.sol";
import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {SurfaceFactory, SaleConfig} from "../../src/surface/SurfaceFactory.sol";
import {SurfaceConfig, IdMode} from "../../src/surface/SurfaceTypes.sol";
import {FixedPriceMinter} from "../../src/surface/minters/FixedPriceMinter.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";
import {MockMinter} from "./mocks/SurfaceMocks.sol";

/// @notice Covers the one-transaction canonical-minter wiring `createSurface`
///         does (3.5/7.4 of the thin-token rearchitecture doc), and that the
///         bring-your-own-minter paths (createSurfaceCustom, createPooledSurface)
///         are unaffected. Constructor/deprecate/pause coverage that predates
///         the canonical minter lives in Surface.t.sol and
///         SurfaceFactoryNoDefault.t.sol; this file adds the paths those
///         didn't need to cover before there was a minterImplementation.
contract SurfaceFactoryTest is FixedPriceMinterBase {
    uint256 internal constant PRICE = 0.01 ether;

    function _empty() internal pure returns (address[] memory a) {
        a = new address[](0);
    }

    function _sale(uint256 price) internal pure returns (SaleConfig memory s) {
        s.price = price;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createSurface: one-transaction canonical-minter wiring
    // ─────────────────────────────────────────────────────────────────────────

    function test_createSurface_wiresTokenAndCanonicalMinterInOneTx() public {
        (address collection, address minter) =
            factory.createSurface("Priced Drop", "DROP", artist, _freeConfig(), _sale(PRICE), _empty());

        assertTrue(factory.isSurface(collection), "collection recorded");
        assertTrue(Surface(collection).isMinter(minter), "canonical minter granted on the token");
        assertEq(FixedPriceMinter(minter).collection(), collection, "minter bound back to the token");
        assertEq(FixedPriceMinter(minter).price(), PRICE, "sale config landed");

        // End-to-end paid mint through the wired minter.
        vm.deal(collector, PRICE);
        vm.prank(collector);
        FixedPriceMinter(minter).mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(Surface(collection).ownerOf(1), collector, "token minted to the payer");
        assertEq(FixedPriceMinter(minter).pendingWithdrawal(artist), PRICE, "artist owed the price, pull payment");

        uint256 before = artist.balance;
        FixedPriceMinter(minter).withdraw(artist);
        assertEq(artist.balance, before + PRICE, "artist claimed the pull balance");
    }

    /// @dev An unset SaleConfig.payoutRecipient defaults to the deploy-time
    ///      `owner` argument, stored as a concrete value on the minter (not a
    ///      live owner() read): transferring ownership after deploy does not
    ///      move it.
    function test_factoryDefaultsPayoutRecipientToDeployOwner() public {
        (address collection, address minter) =
            factory.createSurface("Priced Drop", "DROP", artist, _freeConfig(), _sale(PRICE), _empty());
        assertEq(FixedPriceMinter(minter).payoutRecipient(), artist, "defaults to the deploy-time owner argument");

        address newOwner = makeAddr("newOwner");
        vm.prank(artist);
        Surface(collection).transferOwnership(newOwner);
        vm.prank(newOwner);
        Surface(collection).acceptOwnership();
        assertEq(
            FixedPriceMinter(minter).payoutRecipient(),
            artist,
            "the stored snapshot is unaffected by a later ownership transfer"
        );
    }

    /// @dev Clone order (token, then minter, then token init) is only provable
    ///      indirectly: FixedPriceMinter.initialize requires
    ///      collection.code.length != 0, so if the factory cloned the minter
    ///      before the token, this call would have reverted NotAContract
    ///      instead of succeeding.
    function test_createSurface_orderingLetsMinterBindBeforeTokenInit() public {
        (address collection, address minter) =
            factory.createSurface("Order Proof", "ORD", artist, _freeConfig(), _sale(PRICE), _empty());
        assertTrue(collection.code.length > 0);
        assertEq(FixedPriceMinter(minter).collection(), collection);
    }

    function test_createSurface_returnValuesMatchEmittedEvent() public {
        // Neither address is known ahead of the call, so only the checked
        // fields (owner, indexed; minter + idMode, data) are asserted; the
        // collection topic is left unchecked and the returned value is
        // compared directly against what isSurface/isMinter observe.
        vm.recordLogs();
        (address collection, address minter) =
            factory.createSurface("Event Shape", "EVT", artist, _freeConfig(), _sale(PRICE), _empty());

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != SurfaceFactory.SurfaceCreated.selector) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), artist, "owner indexed");
            assertEq(address(uint160(uint256(logs[i].topics[2]))), collection, "collection indexed");
            (address loggedMinter, IdMode loggedMode) = abi.decode(logs[i].data, (address, IdMode));
            assertEq(loggedMinter, minter, "minter is the canonical clone, not zero");
            assertTrue(loggedMinter != address(0), "canonical path never emits a zero minter");
            assertEq(uint8(loggedMode), uint8(IdMode.Sequential));
            found = true;
        }
        assertTrue(found, "SurfaceCreated emitted");
    }

    function test_createSurface_twoCollectionsGetDistinctMinterClonesAndIsolatedConfig() public {
        (address collectionA, address minterA) =
            factory.createSurface("Drop A", "DA", artist, _freeConfig(), _sale(PRICE), _empty());
        (address collectionB, address minterB) =
            factory.createSurface("Drop B", "DB", artist, _freeConfig(), _sale(PRICE * 2), _empty());

        assertTrue(collectionA != collectionB, "distinct token clones");
        assertTrue(minterA != minterB, "distinct minter clones");
        assertEq(FixedPriceMinter(minterA).price(), PRICE);
        assertEq(FixedPriceMinter(minterB).price(), PRICE * 2);

        vm.deal(collector, PRICE + PRICE * 2);
        vm.prank(collector);
        FixedPriceMinter(minterA).mint{value: PRICE}(collector, 1, address(0), "");
        vm.prank(collector);
        FixedPriceMinter(minterB).mint{value: PRICE * 2}(collector, 1, address(0), "");

        // Balances are per-clone: A's mint never touches B's pending balance.
        assertEq(FixedPriceMinter(minterA).pendingWithdrawal(artist), PRICE);
        assertEq(FixedPriceMinter(minterB).pendingWithdrawal(artist), PRICE * 2);
        assertFalse(Surface(collectionB).isMinter(minterA), "A's minter has no authority on B");
        assertFalse(Surface(collectionA).isMinter(minterB), "B's minter has no authority on A");
    }

    function test_createSurface_reinitializeCanonicalMinter_reverts() public {
        (, address minter) = factory.createSurface("Reinit", "RIN", artist, _freeConfig(), _sale(PRICE), _empty());
        vm.expectRevert();
        FixedPriceMinter(minter).initialize(_minterParams(minter, PRICE));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createSurfaceCustom: bring-your-own minter, no canonical clone
    // ─────────────────────────────────────────────────────────────────────────

    function test_createSurfaceCustom_grantsSuppliedMinters_noCanonicalClone() public {
        address byoMinter = address(new MockMinter());
        address[] memory minters = new address[](1);
        minters[0] = byoMinter;

        uint256 nonceBefore = vm.getNonce(address(factory));
        address collection =
            factory.createSurfaceCustom("BYO Drop", "BYO", artist, _freeConfig(), minters, _empty());
        uint256 nonceAfter = vm.getNonce(address(factory));

        assertTrue(Surface(collection).isMinter(byoMinter), "supplied minter granted");
        // Exactly one clone (the token): createSurface's canonical path clones
        // two (token + minter) from the same account, so the delta proves no
        // minter clone happened here.
        assertEq(nonceAfter - nonceBefore, 1, "only the token clone consumed the factory's nonce");
    }

    function test_createSurfaceCustom_eventCarriesZeroMinter() public {
        vm.recordLogs();
        address collection = factory.createSurfaceCustom("Zero Minter", "ZM", artist, _freeConfig(), _empty(), _empty());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != SurfaceFactory.SurfaceCreated.selector) continue;
            assertEq(address(uint160(uint256(logs[i].topics[2]))), collection, "collection indexed");
            (address loggedMinter, IdMode loggedMode) = abi.decode(logs[i].data, (address, IdMode));
            assertEq(loggedMinter, address(0), "no canonical clone => zero minter in the event");
            assertEq(uint8(loggedMode), uint8(IdMode.Sequential));
            found = true;
        }
        assertTrue(found, "SurfaceCreated emitted");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createPooledSurface: unchanged, no canonical form
    // ─────────────────────────────────────────────────────────────────────────

    function test_createPooledSurface_singleMinterGranted_eventCarriesZeroMinter_noClone() public {
        address byoMinter = address(new MockMinter());
        address[] memory minters = new address[](1);
        minters[0] = byoMinter;

        uint256 nonceBefore = vm.getNonce(address(factory));
        vm.recordLogs();
        address collection = factory.createPooledSurface("Pooled", "PLD", artist, _freeConfig(), minters, _empty());
        uint256 nonceAfter = vm.getNonce(address(factory));

        assertTrue(PooledSurface(collection).isMinter(byoMinter));
        assertEq(nonceAfter - nonceBefore, 1, "pooled path clones only the token, never a canonical minter");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != SurfaceFactory.SurfaceCreated.selector) continue;
            (address loggedMinter, IdMode loggedMode) = abi.decode(logs[i].data, (address, IdMode));
            assertEq(loggedMinter, address(0));
            assertEq(uint8(loggedMode), uint8(IdMode.Pooled));
            found = true;
        }
        assertTrue(found);
    }

    function test_createPooledSurface_stillEnforcesSingleMinterAtInit() public {
        address[] memory twoMinters = new address[](2);
        twoMinters[0] = address(new MockMinter());
        twoMinters[1] = address(new MockMinter());
        vm.expectRevert(ISurfaceCore.TooManyMinters.selector);
        factory.createPooledSurface("Too Many", "TM", artist, _freeConfig(), twoMinters, _empty());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor validation (#148)
    // ─────────────────────────────────────────────────────────────────────────

    function test_constructor_rejectsNonContractMinterImplementation() public {
        address eoa = makeAddr("notAMinter");
        vm.expectRevert(abi.encodeWithSelector(SurfaceFactory.NotAContract.selector, eoa));
        new SurfaceFactory(address(impl), address(pooledImpl), eoa, address(renderer), address(0));
    }

    function test_constructor_rejectsNonContractSequentialImplementation() public {
        address eoa = makeAddr("notASequentialImpl");
        vm.expectRevert(abi.encodeWithSelector(SurfaceFactory.NotAContract.selector, eoa));
        new SurfaceFactory(eoa, address(pooledImpl), address(minterImpl), address(renderer), address(0));
    }

    function test_constructor_rejectsNonContractPooledImplementation() public {
        address eoa = makeAddr("notAPooledImpl");
        vm.expectRevert(abi.encodeWithSelector(SurfaceFactory.NotAContract.selector, eoa));
        new SurfaceFactory(address(impl), eoa, address(minterImpl), address(renderer), address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // OwnerRequired on all three create paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_ownerRequired_onAllThreeCreatePaths() public {
        vm.expectRevert(SurfaceFactory.OwnerRequired.selector);
        factory.createSurface("A", "A", address(0), _freeConfig(), _sale(PRICE), _empty());

        vm.expectRevert(SurfaceFactory.OwnerRequired.selector);
        factory.createSurfaceCustom("B", "B", address(0), _freeConfig(), _empty(), _empty());

        vm.expectRevert(SurfaceFactory.OwnerRequired.selector);
        factory.createPooledSurface("C", "C", address(0), _freeConfig(), _empty(), _empty());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pause / deprecate gate all three create paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_pause_blocksAllThreeCreatePaths() public {
        factory.setPaused(true);

        vm.expectRevert(SurfaceFactory.FactoryPaused.selector);
        factory.createSurface("A", "A", artist, _freeConfig(), _sale(PRICE), _empty());

        vm.expectRevert(SurfaceFactory.FactoryPaused.selector);
        factory.createSurfaceCustom("B", "B", artist, _freeConfig(), _empty(), _empty());

        vm.expectRevert(SurfaceFactory.FactoryPaused.selector);
        factory.createPooledSurface("C", "C", artist, _freeConfig(), _empty(), _empty());
    }

    function test_deprecate_blocksAllThreeCreatePaths() public {
        factory.deprecate(address(0));

        vm.expectRevert(SurfaceFactory.FactoryDeprecated.selector);
        factory.createSurface("A", "A", artist, _freeConfig(), _sale(PRICE), _empty());

        vm.expectRevert(SurfaceFactory.FactoryDeprecated.selector);
        factory.createSurfaceCustom("B", "B", artist, _freeConfig(), _empty(), _empty());

        vm.expectRevert(SurfaceFactory.FactoryDeprecated.selector);
        factory.createPooledSurface("C", "C", artist, _freeConfig(), _empty(), _empty());
    }
}
