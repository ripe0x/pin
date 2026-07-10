// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable2StepUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";

import {Attribution} from "../../src/collection/Attribution.sol";
import {Catalog} from "../../src/Catalog.sol";
import {Collection} from "../../src/collection/Collection.sol";
import {CollectionFactory} from "../../src/collection/CollectionFactory.sol";
import {
    CollectionConfig,
    IdMode
} from "../../src/collection/CollectionTypes.sol";

import {MockRenderer} from "./mocks/CollectionMocks.sol";

/// @dev A bare contract with NO `owner()` function at all — the
///      "non-Ownable collection" fixture. Only the self-call authority
///      path (`msg.sender == collection`) can ever succeed against this.
contract NonOwnableCollection {
    Attribution public immutable attribution;

    constructor(Attribution attribution_) {
        attribution = attribution_;
    }

    /// @dev Lets the test drive a "collection calls Attribution itself"
    ///      scenario, mirroring what Collection.initialize() does.
    function callSetArtists(address[] calldata artists) external {
        attribution.setArtists(address(this), artists);
    }

    function callLockRoster() external {
        attribution.lockRoster(address(this));
    }
}

/// @dev A contract exposing an `owner()` that always reverts. Exercises the
///      "owner() reverts" branch of Attribution's staticcall probe, which
///      must be treated as "no trustworthy owner," not bubbled up.
contract RevertingOwnerCollection {
    function owner() external pure returns (address) {
        revert("nope");
    }
}

/// @dev A contract whose `owner()` selector resolves but returns garbage
///      (not a clean, zero-padded address) — exercises the "returned word
///      doesn't decode to an address" branch.
contract GarbageOwnerCollection {
    function owner() external pure returns (uint256) {
        return type(uint256).max;
    }
}

contract AttributionTest is Test {
    Attribution internal attribution;

    address internal stranger = makeAddr("stranger");
    address internal artistA = makeAddr("artistA");
    address internal artistB = makeAddr("artistB");
    address internal artistC = makeAddr("artistC");

    // Re-declared so vm.expectEmit can match on topics + data.
    event ArtistsSet(address indexed collection, address indexed actor, address[] artists);
    event RosterLocked(address indexed collection);

    function setUp() public {
        attribution = new Attribution();
    }

    function _artists2() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = artistA;
        a[1] = artistB;
    }

    function _artists1(address x) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = x;
    }

    // ─── Deployment ─────────────────────────────────────────────────

    function test_deploysSuccessfully() public view {
        assertEq(attribution.artistCountOf(address(0xBEEF)), 0);
        assertFalse(attribution.isRosterLocked(address(0xBEEF)));
    }

    // ─── Authority matrix: collection self-call ─────────────────────

    function test_setArtists_selfCall_succeeds() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);

        vm.expectEmit(true, true, false, true, address(attribution));
        emit ArtistsSet(address(collection), address(collection), _artists2());
        collection.callSetArtists(_artists2());

        address[] memory got = attribution.artistsOf(address(collection));
        assertEq(got.length, 2);
        assertEq(got[0], artistA);
        assertEq(got[1], artistB);
    }

    function test_lockRoster_selfCall_succeeds() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        collection.callSetArtists(_artists2());

        vm.expectEmit(true, false, false, false, address(attribution));
        emit RosterLocked(address(collection));
        collection.callLockRoster();

        assertTrue(attribution.isRosterLocked(address(collection)));
    }

    // ─── Authority matrix: non-Ownable collection ───────────────────

    function test_nonOwnableCollection_onlySelfPathWorks() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);

        // Stranger cannot act on behalf of a non-Ownable collection: there
        // is no owner() to resolve, so only msg.sender == collection works.
        vm.prank(stranger);
        vm.expectRevert(Attribution.NotAuthorized.selector);
        attribution.setArtists(address(collection), _artists2());

        // The collection acting on itself succeeds.
        collection.callSetArtists(_artists2());
        assertEq(attribution.artistsOf(address(collection)).length, 2);
    }

    // ─── Authority matrix: Ownable collection ───────────────────────

    function test_ownableCollection_ownerPath_succeeds() public {
        (Collection collection,) = _deployCollection(new address[](0));
        address collOwner = collection.owner();

        vm.expectEmit(true, true, false, true, address(attribution));
        emit ArtistsSet(address(collection), collOwner, _artists2());
        vm.prank(collOwner);
        attribution.setArtists(address(collection), _artists2());

        address[] memory got = attribution.artistsOf(address(collection));
        assertEq(got.length, 2);
    }

    function test_ownableCollection_strangerPath_reverts() public {
        (Collection collection,) = _deployCollection(new address[](0));

        vm.prank(stranger);
        vm.expectRevert(Attribution.NotAuthorized.selector);
        attribution.setArtists(address(collection), _artists2());
    }

    function test_ownableCollection_operatorOfNothing_reverts() public {
        // "operator-of-nothing": an address with no relationship at all to
        // the collection (not owner, not the collection itself, not
        // approved anywhere — Attribution has no operator concept, so this
        // is just another stranger flavor, confirmed distinct from the
        // owner in setup).
        (Collection collection,) = _deployCollection(new address[](0));
        address operatorOfNothing = makeAddr("operatorOfNothing");
        assertTrue(operatorOfNothing != collection.owner());

        vm.prank(operatorOfNothing);
        vm.expectRevert(Attribution.NotAuthorized.selector);
        attribution.setArtists(address(collection), _artists2());
    }

    // ─── owner() that reverts / returns garbage ──────────────────────

    function test_ownerReverts_treatedAsNoOwner() public {
        RevertingOwnerCollection collection = new RevertingOwnerCollection();

        // Nobody can pass path 2 because owner() reverts; only a self-call
        // would work, and this fixture never makes one.
        vm.prank(stranger);
        vm.expectRevert(Attribution.NotAuthorized.selector);
        attribution.setArtists(address(collection), _artists2());
    }

    function test_ownerGarbageReturn_treatedAsNoOwner() public {
        GarbageOwnerCollection collection = new GarbageOwnerCollection();

        vm.prank(stranger);
        vm.expectRevert(Attribution.NotAuthorized.selector);
        attribution.setArtists(address(collection), _artists2());
    }

    function test_zeroCollection_reverts() public {
        vm.expectRevert(Attribution.InvalidCollection.selector);
        attribution.setArtists(address(0), _artists2());

        vm.expectRevert(Attribution.InvalidCollection.selector);
        attribution.lockRoster(address(0));
    }

    // ─── Roster replace semantics ────────────────────────────────────

    function test_setArtists_replacesNotAppends() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        collection.callSetArtists(_artists2());
        assertEq(attribution.artistCountOf(address(collection)), 2);

        address[] memory replacement = _artists1(artistC);
        collection.callSetArtists(replacement);

        address[] memory got = attribution.artistsOf(address(collection));
        assertEq(got.length, 1);
        assertEq(got[0], artistC);
        // artistA/artistB from the first call are gone, not appended-to.
        assertFalse(_contains(got, artistA));
        assertFalse(_contains(got, artistB));
    }

    // ─── Zero/empty reverts ───────────────────────────────────────────

    function test_setArtists_emptyArray_reverts() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        address[] memory empty = new address[](0);

        vm.expectRevert(Attribution.EmptyArtists.selector);
        collection.callSetArtists(empty);
    }

    // ─── Lock: one-way + post-lock reverts ───────────────────────────

    function test_lockRoster_isOneWay_andBlocksFurtherSetArtists() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        collection.callSetArtists(_artists2());
        collection.callLockRoster();

        assertTrue(attribution.isRosterLocked(address(collection)));

        vm.expectRevert(Attribution.RosterAlreadyLocked.selector);
        collection.callSetArtists(_artists1(artistC));

        // Roster is unchanged after the reverted attempt.
        address[] memory got = attribution.artistsOf(address(collection));
        assertEq(got.length, 2);
    }

    function test_lockRoster_calledTwice_isHarmlessNoop() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        collection.callLockRoster();
        assertTrue(attribution.isRosterLocked(address(collection)));

        // Re-emits, does not revert.
        vm.expectEmit(true, false, false, false, address(attribution));
        emit RosterLocked(address(collection));
        collection.callLockRoster();
        assertTrue(attribution.isRosterLocked(address(collection)));
    }

    function test_lockRoster_beforeAnySetArtists_freezesEmptyRoster() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        collection.callLockRoster();

        vm.expectRevert(Attribution.RosterAlreadyLocked.selector);
        collection.callSetArtists(_artists2());

        assertEq(attribution.artistCountOf(address(collection)), 0);
    }

    // ─── Event shapes ─────────────────────────────────────────────────

    function test_events_haveExpectedShape() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);

        vm.expectEmit(true, true, false, true, address(attribution));
        emit ArtistsSet(address(collection), address(collection), _artists2());
        collection.callSetArtists(_artists2());

        vm.expectEmit(true, false, false, false, address(attribution));
        emit RosterLocked(address(collection));
        collection.callLockRoster();
    }

    // ─── Slice getters ────────────────────────────────────────────────

    function test_slicesAndIndexedAccess() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        address[] memory three = new address[](3);
        three[0] = artistA;
        three[1] = artistB;
        three[2] = artistC;
        collection.callSetArtists(three);

        assertEq(attribution.artistCountOf(address(collection)), 3);
        assertEq(attribution.artistAt(address(collection), 0), artistA);
        assertEq(attribution.artistAt(address(collection), 2), artistC);

        address[] memory slice = attribution.artistsSlice(address(collection), 1, 1);
        assertEq(slice.length, 1);
        assertEq(slice[0], artistB);

        address[] memory full = attribution.artistsSlice(address(collection), 0, 10);
        assertEq(full.length, 3);
    }

    function test_slice_outOfRange_startBeyondLength_returnsEmpty() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        collection.callSetArtists(_artists2());

        address[] memory slice = attribution.artistsSlice(address(collection), 10, 5);
        assertEq(slice.length, 0);
    }

    function test_slice_outOfRange_countExceedsLength_returnsRemainder() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        collection.callSetArtists(_artists2());

        address[] memory slice = attribution.artistsSlice(address(collection), 1, 10);
        assertEq(slice.length, 1);
        assertEq(slice[0], artistB);
    }

    function test_artistAt_outOfBounds_reverts() public {
        NonOwnableCollection collection = new NonOwnableCollection(attribution);
        collection.callSetArtists(_artists2());

        vm.expectRevert();
        attribution.artistAt(address(collection), 5);
    }

    // ─── Integration: real factory + real Catalog, handshake intersection ──

    function test_integration_factoryRosterAndCatalogIntersection() public {
        (Collection collection, Catalog catalog) = _deployCollectionWithCatalog();

        address[] memory roster = new address[](2);
        roster[0] = artistA;
        roster[1] = artistB;

        // Redeploy through the factory WITH a 2-artist roster this time, so
        // we can assert the collection-self path fired during init.
        CollectionFactory factory = _newFactory();
        address created = factory.createCollection(
            "Collab Collection",
            "COLLAB",
            artistA,
            _freeConfig(),
            new address[](0),
            roster
        );

        // Assert the roster landed via the collection-self path during
        // init: Attribution.artistsOf reflects exactly what the factory
        // passed, with no separate transaction from the owner ever sent.
        address[] memory got = attribution.artistsOf(created);
        assertEq(got.length, 2);
        assertEq(got[0], artistA);
        assertEq(got[1], artistB);

        // Now simulate the other half of the handshake: artistA claims the
        // collection in the REAL Catalog.
        vm.prank(artistA);
        catalog.addContract(created);

        // Confirmed attribution = intersection of both halves, read
        // directly onchain (this is normally an offchain indexer
        // computation; asserting it here proves both halves are
        // consistent and queryable).
        bool inRoster = _contains(got, artistA);
        bool claimedInCatalog = catalog.isContractRegistered(artistA, created);
        assertTrue(inRoster);
        assertTrue(claimedInCatalog);

        // artistB is in the roster but never claimed in Catalog: the
        // intersection for artistB is false, demonstrating the two halves
        // are genuinely independent, one-sided assertions.
        assertTrue(_contains(got, artistB));
        assertFalse(catalog.isContractRegistered(artistB, created));

        // silence unused-var warning for the throwaway first collection
        collection;
    }

    function test_integration_ownerCanUpdateRosterAfterDeploy_thenLock() public {
        (Collection collection,) = _deployCollectionWithCatalog();
        address collOwner = collection.owner();

        // Owner (not the collection itself) updates the roster post-deploy
        // via the Ownable path.
        vm.prank(collOwner);
        attribution.setArtists(address(collection), _artists2());
        assertEq(attribution.artistCountOf(address(collection)), 2);

        vm.prank(collOwner);
        attribution.lockRoster(address(collection));
        assertTrue(attribution.isRosterLocked(address(collection)));

        vm.prank(collOwner);
        vm.expectRevert(Attribution.RosterAlreadyLocked.selector);
        attribution.setArtists(address(collection), _artists1(artistC));
    }

    // ─── Shared deploy helpers ────────────────────────────────────────

    function _freeConfig() internal pure returns (CollectionConfig memory cfg) {
        cfg.idMode = IdMode.Sequential;
    }


    function _newFactory() internal returns (CollectionFactory factory) {
        MockRenderer renderer = new MockRenderer();
        Collection impl = new Collection();
        factory = new CollectionFactory(address(impl), address(renderer), address(attribution));
    }

    /// @dev Deploys a factory-created collection (no roster) plus a fresh
    ///      real Catalog instance, wired against this test's Attribution.
    function _deployCollection(address[] memory artists)
        internal
        returns (Collection collection, MockRenderer renderer)
    {
        renderer = new MockRenderer();
        Collection impl = new Collection();
        CollectionFactory factory =
            new CollectionFactory(address(impl), address(renderer), address(attribution));
        address created = factory.createCollection(
            "Artist Collection", "ACOL", artistA, _freeConfig(), new address[](0), artists
        );
        collection = Collection(created);
    }

    function _deployCollectionWithCatalog()
        internal
        returns (Collection collection, Catalog catalog)
    {
        catalog = new Catalog();
        (collection,) = _deployCollection(new address[](0));
    }

    function _contains(address[] memory list, address needle) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == needle) return true;
        }
        return false;
    }
}
