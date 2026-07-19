// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {Surface} from "../../src/surface/Surface.sol";
import {SurfaceFactory} from "../../src/surface/SurfaceFactory.sol";
import {FixedPriceMinter} from "../../src/surface/minters/FixedPriceMinter.sol";
import {ISurface} from "../../src/surface/interfaces/ISurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";
import {SurfaceConfig, InitParams, IdMode} from "../../src/surface/SurfaceTypes.sol";
import {Catalog} from "../../src/Catalog.sol";
import {MockRenderer} from "./mocks/SurfaceMocks.sol";

/// @notice Attribution is a two-sided handshake, both sides onchain:
///         the owner LISTS creators on the collection (their assertion), and
///         each creator CONFIRMS by claiming the collection in the real
///         Catalog (their assertion, from their own address). isConfirmedCreator
///         is the live intersection. No shared Attribution registry; the
///         Catalog is only read.
contract CreatorAttributionTest is Test {
    Surface internal impl;
    SurfaceFactory internal factory;
    Catalog internal catalog;
    Surface internal c;

    address internal artist = makeAddr("artist");
    address internal collabB = makeAddr("collabB");
    address internal collabC = makeAddr("collabC");
    address internal impostor = makeAddr("impostor");

    function setUp() public {
        catalog = new Catalog();
        impl = new Surface();
        factory = new SurfaceFactory(
            address(impl),
            address(new PooledSurface()),
            address(new FixedPriceMinter()),
            address(new MockRenderer()),
            address(catalog)
        );

        SurfaceConfig memory cfg;

        // Deploy listing B and C as creators (the owner's side). Note the
        // deployer can list anyone — confirmation is what makes it real.
        address[] memory creators = new address[](2);
        creators[0] = collabB;
        creators[1] = collabC;
        c = Surface(factory.createSurfaceCustom("Collab", "CLB", artist, cfg, new address[](0), creators));
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
        emit ISurfaceCore.CreatorListed(collabD, true);
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
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(impostor);
        c.setCreators(add, true);
    }

    function test_catalog_addressExposed() public view {
        assertEq(c.catalog(), address(catalog));
    }

    function test_noCatalog_confirmationDisabled() public {
        // A factory with no Catalog: listings work, confirmation always false.
        SurfaceFactory f2 = new SurfaceFactory(
            address(impl), address(new PooledSurface()), address(new FixedPriceMinter()), address(new MockRenderer()), address(0)
        );
        SurfaceConfig memory cfg;
        address[] memory creators = new address[](1);
        creators[0] = collabB;
        Surface c2 = Surface(f2.createSurfaceCustom("NoCat", "NC", artist, cfg, new address[](0), creators));
        assertEq(c2.catalog(), address(0));
        assertTrue(c2.isListedCreator(collabB));
        assertFalse(c2.isConfirmedCreator(collabB), "no catalog => never confirmed");
    }

    /// @dev A nonzero catalog must be a real contract: a mistyped/EOA address would make
    ///      isConfirmedCreator revert forever on every collection, unrecoverably. Zero
    ///      (confirmation disabled) stays legal — see test_noCatalog_confirmationDisabled.
    function test_constructor_rejectsNonContractCatalog() public {
        address eoaCatalog = makeAddr("notACatalog");
        // deploy the other args BEFORE expectRevert so the only CREATE it guards is the factory
        address pooled = address(new PooledSurface());
        address minter = address(new FixedPriceMinter());
        address rend = address(new MockRenderer());
        vm.expectRevert(abi.encodeWithSelector(SurfaceFactory.NotAContract.selector, eoaCatalog));
        new SurfaceFactory(address(impl), pooled, minter, rend, eoaCatalog);
    }
}
