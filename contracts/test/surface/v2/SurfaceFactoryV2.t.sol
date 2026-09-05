// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {FactoryMinterV2Base} from "./FactoryMinterV2Base.sol";
import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceFactoryV2} from "../../../src/surface/v2/SurfaceFactoryV2.sol";
import {FixedPriceMinterV2} from "../../../src/surface/v2/minters/FixedPriceMinterV2.sol";
import {ISurfaceV2} from "../../../src/surface/v2/interfaces/ISurfaceV2.sol";
import {SurfaceConfig, IdMode} from "../../../src/surface/SurfaceTypes.sol";

import {MockMinterV2, StubSeedSourceV2} from "./mocks/FactoryMinterV2Mocks.sol";

/// @notice Sequential-only SurfaceFactoryV2 coverage, ported from v1's
///         SurfaceFactory.t.sol and SurfaceFactoryNoDefault.t.sol with every
///         pooled path dropped (v2 has one id mode) and priceStrategy
///         removed from SaleConfig. Adds coverage for the seedSource
///         pass-through, which v1 has no field for.
contract SurfaceFactoryV2Test is FactoryMinterV2Base {
    uint256 internal constant PRICE = 0.01 ether;

    // ─────────────────────────────────────────────────────────────────────────
    // createSurface: one-transaction canonical-minter wiring
    // ─────────────────────────────────────────────────────────────────────────

    function test_createSurface_wiresTokenAndCanonicalMinterInOneTx() public {
        (address collection, address minter) =
            factory.createSurface("Priced Drop", "DROP", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));

        assertTrue(factory.isSurface(collection), "collection recorded");
        assertTrue(SurfaceV2(collection).isMinter(minter), "canonical minter granted on the token");
        assertEq(FixedPriceMinterV2(minter).collection(), collection, "minter bound back to the token");
        assertEq(FixedPriceMinterV2(minter).price(), PRICE, "sale config landed");
        assertEq(SurfaceV2(collection).primaryMinter(), minter, "canonical minter set as primary");

        // End-to-end paid mint through the wired minter.
        vm.deal(collector, PRICE);
        vm.prank(collector);
        FixedPriceMinterV2(minter).mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(SurfaceV2(collection).ownerOf(1), collector, "token minted to the payer");
        assertEq(FixedPriceMinterV2(minter).pendingWithdrawal(artist), PRICE, "artist owed the price, pull payment");

        uint256 before = artist.balance;
        FixedPriceMinterV2(minter).withdraw(artist);
        assertEq(artist.balance, before + PRICE, "artist claimed the pull balance");
    }

    /// @dev An unset SaleConfig.payoutRecipient defaults to the deploy-time
    ///      `owner` argument, stored as a concrete value on the minter (not a
    ///      live owner() read): transferring ownership after deploy does not
    ///      move it.
    function test_factoryDefaultsPayoutRecipientToDeployOwner() public {
        (address collection, address minter) =
            factory.createSurface("Priced Drop", "DROP", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));
        assertEq(
            FixedPriceMinterV2(minter).payoutRecipient(), artist, "defaults to the deploy-time owner argument"
        );

        address newOwner = makeAddr("newOwner");
        vm.prank(artist);
        SurfaceV2(collection).transferOwnership(newOwner);
        vm.prank(newOwner);
        SurfaceV2(collection).acceptOwnership();
        assertEq(
            FixedPriceMinterV2(minter).payoutRecipient(),
            artist,
            "the stored snapshot is unaffected by a later ownership transfer"
        );
    }

    /// @dev Clone order (token, then minter, then token init) is only provable
    ///      indirectly: FixedPriceMinterV2.initialize requires
    ///      collection.code.length != 0, so if the factory cloned the minter
    ///      before the token, this call would have reverted NotAContract
    ///      instead of succeeding.
    function test_createSurface_orderingLetsMinterBindBeforeTokenInit() public {
        (address collection, address minter) =
            factory.createSurface("Order Proof", "ORD", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));
        assertTrue(collection.code.length > 0);
        assertEq(FixedPriceMinterV2(minter).collection(), collection);
    }

    function test_createSurface_returnValuesMatchEmittedEvent() public {
        vm.recordLogs();
        (address collection, address minter) =
            factory.createSurface("Event Shape", "EVT", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != SurfaceFactoryV2.SurfaceCreated.selector) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), artist, "owner indexed");
            assertEq(address(uint160(uint256(logs[i].topics[2]))), collection, "collection indexed");
            (address loggedMinter, IdMode loggedMode, string memory loggedName, string memory loggedSymbol) =
                abi.decode(logs[i].data, (address, IdMode, string, string));
            assertEq(loggedMinter, minter, "minter is the canonical clone, not zero");
            assertTrue(loggedMinter != address(0), "canonical path never emits a zero minter");
            assertEq(uint8(loggedMode), uint8(IdMode.Sequential));
            assertEq(loggedName, "Event Shape", "event carries the collection name");
            assertEq(loggedSymbol, "EVT", "event carries the collection symbol");
            found = true;
        }
        assertTrue(found, "SurfaceCreated emitted");
    }

    function test_createSurface_twoCollectionsGetDistinctMinterClonesAndIsolatedConfig() public {
        (address collectionA, address minterA) =
            factory.createSurface("Drop A", "DA", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));
        (address collectionB, address minterB) =
            factory.createSurface("Drop B", "DB", artist, _freeConfig(), _sale(PRICE * 2), _empty(), address(0));

        assertTrue(collectionA != collectionB, "distinct token clones");
        assertTrue(minterA != minterB, "distinct minter clones");
        assertEq(FixedPriceMinterV2(minterA).price(), PRICE);
        assertEq(FixedPriceMinterV2(minterB).price(), PRICE * 2);

        vm.deal(collector, PRICE + PRICE * 2);
        vm.prank(collector);
        FixedPriceMinterV2(minterA).mint{value: PRICE}(collector, 1, address(0), "");
        vm.prank(collector);
        FixedPriceMinterV2(minterB).mint{value: PRICE * 2}(collector, 1, address(0), "");

        // Balances are per-clone: A's mint never touches B's pending balance.
        assertEq(FixedPriceMinterV2(minterA).pendingWithdrawal(artist), PRICE);
        assertEq(FixedPriceMinterV2(minterB).pendingWithdrawal(artist), PRICE * 2);
        assertFalse(SurfaceV2(collectionB).isMinter(minterA), "A's minter has no authority on B");
        assertFalse(SurfaceV2(collectionA).isMinter(minterB), "B's minter has no authority on A");
    }

    function test_createSurface_reinitializeCanonicalMinter_reverts() public {
        (, address minter) =
            factory.createSurface("Reinit", "RIN", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));
        vm.expectRevert();
        FixedPriceMinterV2(minter).initialize(_minterParams(minter, PRICE));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createSurfaceCustom: bring-your-own minter, no canonical clone
    // ─────────────────────────────────────────────────────────────────────────

    function test_createSurfaceCustom_grantsSuppliedMinters_noCanonicalClone() public {
        address byoMinter = address(new MockMinterV2());
        address[] memory minters = _one(byoMinter);

        uint256 nonceBefore = vm.getNonce(address(factory));
        address collection = factory.createSurfaceCustom(
            "BYO Drop", "BYO", artist, _freeConfig(), minters, address(0), _empty(), address(0)
        );
        uint256 nonceAfter = vm.getNonce(address(factory));

        assertTrue(SurfaceV2(collection).isMinter(byoMinter), "supplied minter granted");
        // Exactly one clone (the token): createSurface's canonical path clones
        // two (token + minter) from the same account, so the delta proves no
        // minter clone happened here.
        assertEq(nonceAfter - nonceBefore, 1, "only the token clone consumed the factory's nonce");
    }

    function test_createSurfaceCustom_eventCarriesZeroMinter() public {
        vm.recordLogs();
        address collection = factory.createSurfaceCustom(
            "Zero Minter", "ZM", artist, _freeConfig(), _empty(), address(0), _empty(), address(0)
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != SurfaceFactoryV2.SurfaceCreated.selector) continue;
            assertEq(address(uint160(uint256(logs[i].topics[2]))), collection, "collection indexed");
            (address loggedMinter, IdMode loggedMode, string memory loggedName, string memory loggedSymbol) =
                abi.decode(logs[i].data, (address, IdMode, string, string));
            assertEq(loggedMinter, address(0), "no primary supplied => zero minter in the event");
            assertEq(uint8(loggedMode), uint8(IdMode.Sequential));
            assertEq(loggedName, "Zero Minter", "event carries the collection name");
            assertEq(loggedSymbol, "ZM", "event carries the collection symbol");
            found = true;
        }
        assertTrue(found, "SurfaceCreated emitted");
    }

    /// @dev createSurfaceCustom's caller-supplied primaryMinter passes through
    ///      to both the collection's primaryMinter() and the SurfaceCreated
    ///      event, unlike the zero-minter case above.
    function test_createSurfaceCustom_suppliedPrimaryMinter_exposedOnCollectionAndEvent() public {
        address byoMinter = address(new MockMinterV2());
        address[] memory minters = _one(byoMinter);

        vm.recordLogs();
        address collection = factory.createSurfaceCustom(
            "Primary Set", "PRI", artist, _freeConfig(), minters, byoMinter, _empty(), address(0)
        );

        assertEq(SurfaceV2(collection).primaryMinter(), byoMinter, "collection exposes the supplied primary");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != SurfaceFactoryV2.SurfaceCreated.selector) continue;
            (address loggedMinter,,,) = abi.decode(logs[i].data, (address, IdMode, string, string));
            assertEq(loggedMinter, byoMinter, "event carries the supplied primary");
            found = true;
        }
        assertTrue(found, "SurfaceCreated emitted");
    }

    /// @dev primaryMinter must be a member of initialMinters; a non-member
    ///      reverts before any clone happens (the factory's own membership
    ///      check, not the core's).
    function test_createSurfaceCustom_primaryMinterNotInInitialMinters_reverts() public {
        address byoMinter = address(new MockMinterV2());
        address notGranted = address(new MockMinterV2());
        address[] memory minters = _one(byoMinter);

        vm.expectRevert(SurfaceFactoryV2.PrimaryMinterNotAuthorized.selector);
        factory.createSurfaceCustom(
            "Bad Primary", "BAD", artist, _freeConfig(), minters, notGranted, _empty(), address(0)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // seedSource pass-through
    // ─────────────────────────────────────────────────────────────────────────

    function test_createSurface_seedSourcePassesThroughToCollection() public {
        StubSeedSourceV2 source = new StubSeedSourceV2(bytes32(uint256(1)));
        (address collection,) = factory.createSurface(
            "Seeded Drop", "SEED", artist, _freeConfig(), _sale(PRICE), _empty(), address(source)
        );
        assertEq(SurfaceV2(collection).seedSource(), address(source), "seedSource lands in the collection");
    }

    function test_createSurfaceCustom_seedSourcePassesThroughToCollection() public {
        StubSeedSourceV2 source = new StubSeedSourceV2(bytes32(uint256(1)));
        address collection = factory.createSurfaceCustom(
            "Seeded Custom", "SEEDC", artist, _freeConfig(), _empty(), address(0), _empty(), address(source)
        );
        assertEq(SurfaceV2(collection).seedSource(), address(source), "seedSource lands in the collection");
    }

    function test_createSurface_defaultSeedSourceIsZero() public {
        (address collection,) =
            factory.createSurface("No Seed Source", "NSS", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));
        assertEq(SurfaceV2(collection).seedSource(), address(0), "seedSource defaults to disabled");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // No default renderer: every collection must bring its own
    // ─────────────────────────────────────────────────────────────────────────

    function test_factoryNoDefault_constructsWithZeroDefaultRenderer() public view {
        assertEq(factoryNoDefault.defaultRenderer(), address(0), "no default renderer");
    }

    function test_createSurfaceCustom_noDefaultFactory_ownRenderer_succeeds() public {
        SurfaceConfig memory cfg;
        cfg.renderer = address(renderer);
        address collection = factoryNoDefault.createSurfaceCustom(
            "N", "S", artist, cfg, _empty(), address(0), _empty(), address(0)
        );
        assertEq(SurfaceV2(collection).renderer(), address(renderer), "collection uses its own renderer");
    }

    function test_createSurfaceCustom_noDefaultFactory_noRenderer_revertsRendererRequired() public {
        SurfaceConfig memory cfg; // cfg.renderer == 0, and no factory default
        vm.expectRevert(ISurfaceV2.RendererRequired.selector);
        factoryNoDefault.createSurfaceCustom("N", "S", artist, cfg, _empty(), address(0), _empty(), address(0));
    }

    function test_createSurface_noDefaultFactory_noRenderer_revertsRendererRequired() public {
        SurfaceConfig memory cfg;
        vm.expectRevert(ISurfaceV2.RendererRequired.selector);
        factoryNoDefault.createSurface("N", "S", artist, cfg, _sale(PRICE), _empty(), address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor validation
    // ─────────────────────────────────────────────────────────────────────────

    function test_constructor_rejectsNonContractSequentialImplementation() public {
        address eoa = makeAddr("notASequentialImpl");
        vm.expectRevert(abi.encodeWithSelector(SurfaceFactoryV2.NotAContract.selector, eoa));
        new SurfaceFactoryV2(eoa, address(minterImpl), address(renderer), address(0));
    }

    function test_constructor_rejectsNonContractMinterImplementation() public {
        address eoa = makeAddr("notAMinter");
        vm.expectRevert(abi.encodeWithSelector(SurfaceFactoryV2.NotAContract.selector, eoa));
        new SurfaceFactoryV2(address(impl), eoa, address(renderer), address(0));
    }

    function test_constructor_rejectsNonContractDefaultRenderer() public {
        // A nonzero default renderer must be a real contract; an EOA/typo is
        // refused. Zero is legal (see the no-default-factory suite above).
        address eoa = makeAddr("notARenderer");
        vm.expectRevert(abi.encodeWithSelector(SurfaceFactoryV2.NotAContract.selector, eoa));
        new SurfaceFactoryV2(address(impl), address(minterImpl), eoa, address(0));
    }

    function test_constructor_rejectsNonContractCatalog() public {
        address eoa = makeAddr("notACatalog");
        vm.expectRevert(abi.encodeWithSelector(SurfaceFactoryV2.NotAContract.selector, eoa));
        new SurfaceFactoryV2(address(impl), address(minterImpl), address(renderer), eoa);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // OwnerRequired on both create paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_ownerRequired_onBothCreatePaths() public {
        vm.expectRevert(SurfaceFactoryV2.OwnerRequired.selector);
        factory.createSurface("A", "A", address(0), _freeConfig(), _sale(PRICE), _empty(), address(0));

        vm.expectRevert(SurfaceFactoryV2.OwnerRequired.selector);
        factory.createSurfaceCustom("B", "B", address(0), _freeConfig(), _empty(), address(0), _empty(), address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pause: reversible, blocks both create paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_pause_blocksBothCreatePaths() public {
        factory.setPaused(true);

        vm.expectRevert(SurfaceFactoryV2.FactoryPaused.selector);
        factory.createSurface("A", "A", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));

        vm.expectRevert(SurfaceFactoryV2.FactoryPaused.selector);
        factory.createSurfaceCustom("B", "B", artist, _freeConfig(), _empty(), address(0), _empty(), address(0));
    }

    function test_pause_isReversible() public {
        factory.setPaused(true);
        vm.expectRevert(SurfaceFactoryV2.FactoryPaused.selector);
        factory.createSurface("A", "A", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));

        factory.setPaused(false);
        (address collection,) =
            factory.createSurface("A", "A", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));
        assertTrue(factory.isSurface(collection), "creates succeed again after unpausing");
    }

    function test_setPaused_onlyDeployer() public {
        vm.expectRevert(SurfaceFactoryV2.NotDeployer.selector);
        vm.prank(stranger);
        factory.setPaused(true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Deprecate: one-way, blocks both create paths regardless of paused
    // ─────────────────────────────────────────────────────────────────────────

    function test_deprecate_blocksBothCreatePaths() public {
        factory.deprecate(address(0));

        vm.expectRevert(SurfaceFactoryV2.FactoryDeprecated.selector);
        factory.createSurface("A", "A", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));

        vm.expectRevert(SurfaceFactoryV2.FactoryDeprecated.selector);
        factory.createSurfaceCustom("B", "B", artist, _freeConfig(), _empty(), address(0), _empty(), address(0));
    }

    /// @dev Deprecation stays permanent even if paused is later toggled off:
    ///      the two flags are independent, and deprecated wins.
    function test_deprecate_overridesPausedToggle() public {
        factory.deprecate(address(0));
        factory.setPaused(false); // no-op for deprecation; already false

        vm.expectRevert(SurfaceFactoryV2.FactoryDeprecated.selector);
        factory.createSurface("A", "A", artist, _freeConfig(), _sale(PRICE), _empty(), address(0));
    }

    function test_deprecate_isOneWay() public {
        factory.deprecate(address(0));
        vm.expectRevert(SurfaceFactoryV2.AlreadyDeprecated.selector);
        factory.deprecate(makeAddr("successor"));
    }

    function test_deprecate_setsSuccessorAndEmits() public {
        address successor = makeAddr("successorFactory");
        vm.expectEmit(true, false, false, true, address(factory));
        emit SurfaceFactoryV2.Deprecated(successor);
        factory.deprecate(successor);
        assertTrue(factory.deprecated());
        assertEq(factory.successor(), successor);
    }

    function test_deprecate_onlyDeployer() public {
        vm.expectRevert(SurfaceFactoryV2.NotDeployer.selector);
        vm.prank(stranger);
        factory.deprecate(address(0));
    }
}
