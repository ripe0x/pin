// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Collection} from "../../src/collection/Collection.sol";
import {CollectionFactory} from "../../src/collection/CollectionFactory.sol";
import {ICollection} from "../../src/collection/interfaces/ICollection.sol";
import {CollectionConfig, InitParams, IdMode} from "../../src/collection/CollectionTypes.sol";
import {Catalog} from "../../src/Catalog.sol";
import {MockRenderer} from "./mocks/CollectionMocks.sol";

/// @notice Attribution is a two-sided handshake, both sides onchain:
///         the owner LISTS creators on the collection (their assertion), and
///         each creator CONFIRMS by claiming the collection in the real
///         Catalog (their assertion, from their own address). isConfirmedCreator
///         is the live intersection. No shared Attribution registry; the
///         Catalog is only read.
contract CreatorAttributionTest is Test {
    Collection internal impl;
    CollectionFactory internal factory;
    Catalog internal catalog;
    Collection internal c;

    address internal artist = makeAddr("artist");
    address internal collabB = makeAddr("collabB");
    address internal collabC = makeAddr("collabC");
    address internal impostor = makeAddr("impostor");

    function setUp() public {
        catalog = new Catalog();
        impl = new Collection();
        factory = new CollectionFactory(address(impl), address(new MockRenderer()), address(catalog));

        CollectionConfig memory cfg;
        cfg.idMode = IdMode.Sequential;

        // Deploy listing B and C as creators (the owner's side). Note the
        // deployer can list anyone — confirmation is what makes it real.
        address[] memory creators = new address[](2);
        creators[0] = collabB;
        creators[1] = collabC;
        c = Collection(
            factory.createCollection("Collab", "CLB", artist, cfg, new address[](0), creators)
        );
    }

    function test_confirmed_requiresListedAndCatalogClaim() public {
        // Listed but not yet claimed → not confirmed.
        assertTrue(c.isListedCreator(collabB), "B listed at init");
        assertFalse(c.isConfirmedCreator(collabB), "listing alone is not confirmation");

        // B claims the collection in their own Catalog → now confirmed.
        vm.prank(collabB);
        catalog.addContract(address(c));
        assertTrue(c.isConfirmedCreator(collabB), "listed + claimed = confirmed");

        // Live: B un-claims in Catalog → confirmation cleanly revokes.
        vm.prank(collabB);
        catalog.removeContract(address(c));
        assertFalse(c.isConfirmedCreator(collabB), "un-claim revokes confirmation live");
    }

    function test_impostor_cannotConfirm_notListed() public {
        // An impostor claims the collection in Catalog (permissionless)...
        vm.prank(impostor);
        catalog.addContract(address(c));
        // ...but was never listed by the owner, so never confirmed. Squat fails.
        assertFalse(c.isListedCreator(impostor));
        assertFalse(c.isConfirmedCreator(impostor));
    }

    function test_falseCredit_showsAsUnconfirmed() public {
        // C is listed (owner's assertion) but never claims → listed but not
        // confirmed, i.e. the owner cannot fake a co-creator into "confirmed".
        assertTrue(c.isListedCreator(collabC));
        assertFalse(c.isConfirmedCreator(collabC), "owner-listed non-claimant stays unconfirmed");
    }

    function test_setCreators_ownerCanAddAndRemoveListings() public {
        address collabD = makeAddr("collabD");
        assertFalse(c.isListedCreator(collabD));

        address[] memory add = new address[](1);
        add[0] = collabD;
        vm.expectEmit(true, false, false, true, address(c));
        emit ICollection.CreatorListed(collabD, true);
        vm.prank(artist);
        c.setCreators(add, true);
        assertTrue(c.isListedCreator(collabD));

        // unlisting revokes even a previously confirmed creator (live read).
        vm.prank(collabD);
        catalog.addContract(address(c));
        assertTrue(c.isConfirmedCreator(collabD));
        vm.prank(artist);
        c.setCreators(add, false);
        assertFalse(c.isConfirmedCreator(collabD), "unlisting revokes confirmation");
    }

    function test_setCreators_onlyOwnerOrAdmin() public {
        address[] memory add = new address[](1);
        add[0] = impostor;
        vm.expectRevert(ICollection.NotAuthorized.selector);
        vm.prank(impostor);
        c.setCreators(add, true);
    }

    function test_catalog_addressExposed() public view {
        assertEq(c.catalog(), address(catalog));
    }

    function test_noCatalog_confirmationDisabled() public {
        // A factory with no Catalog: listings work, confirmation always false.
        CollectionFactory f2 =
            new CollectionFactory(address(impl), address(new MockRenderer()), address(0));
        CollectionConfig memory cfg;
        cfg.idMode = IdMode.Sequential;
        address[] memory creators = new address[](1);
        creators[0] = collabB;
        Collection c2 =
            Collection(f2.createCollection("NoCat", "NC", artist, cfg, new address[](0), creators));
        assertEq(c2.catalog(), address(0));
        assertTrue(c2.isListedCreator(collabB));
        assertFalse(c2.isConfirmedCreator(collabB), "no catalog => never confirmed");
    }
}
