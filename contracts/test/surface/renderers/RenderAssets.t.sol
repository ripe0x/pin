// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Surface} from "../../../src/surface/Surface.sol";
import {PooledSurface} from "../../../src/surface/PooledSurface.sol";
import {SurfaceFactory} from "../../../src/surface/SurfaceFactory.sol";
import {FixedPriceMinter} from "../../../src/surface/minters/FixedPriceMinter.sol";
import {RenderAssets} from "../../../src/surface/renderers/RenderAssets.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";
import {MockRenderer} from "../mocks/SurfaceMocks.sol";

/// @notice RenderAssets: the image fallback ladder (capture > template >
///         cover > "") and the two write tiers — admin keys for everything,
///         narrow capturer keys for captures and the template only.
contract RenderAssetsTest is Test {
    RenderAssets internal assets;
    Surface internal collection;

    address internal artist = makeAddr("artist");
    address internal admin = makeAddr("admin");
    address internal capturer = makeAddr("capturer");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        assets = new RenderAssets();
        Surface impl = new Surface();
        SurfaceFactory factory = new SurfaceFactory(
            address(impl), address(new PooledSurface()), address(new FixedPriceMinter()), address(new MockRenderer()), address(0)
        );
        SurfaceConfig memory cfg;
        collection =
            Surface(factory.createSurfaceCustom("Assets Test", "AT", artist, cfg, new address[](0), new address[](0)));
        vm.prank(artist);
        collection.addAdmin(admin);
    }

    function _setCapture(address who, uint256 tokenId, string memory uri) internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        string[] memory uris = new string[](1);
        uris[0] = uri;
        vm.prank(who);
        assets.setCaptures(address(collection), ids, uris);
    }

    // ── the fallback ladder ──────────────────────────────────────────────────

    function test_imageFor_ladder_captureBeatsTemplateBeatsCover() public {
        address c = address(collection);
        assertEq(assets.imageFor(c, 7), "", "nothing set: empty");

        vm.prank(artist);
        assets.setCover(c, "ipfs://cover");
        assertEq(assets.imageFor(c, 7), "ipfs://cover", "cover is the floor");

        vm.prank(artist);
        assets.setCaptureTemplate(c, "ar://manifest/{id}.png");
        assertEq(assets.imageFor(c, 7), "ar://manifest/7.png", "template beats cover, id substituted");

        _setCapture(artist, 7, "ar://explicit-frame");
        assertEq(assets.imageFor(c, 7), "ar://explicit-frame", "explicit capture beats template");
        assertEq(assets.imageFor(c, 8), "ar://manifest/8.png", "other tokens still resolve the template");
    }

    function test_imageFor_templateCleared_fallsBackToCover() public {
        address c = address(collection);
        vm.startPrank(artist);
        assets.setCover(c, "ipfs://cover");
        assets.setCaptureTemplate(c, "ar://manifest/{id}.png");
        assets.setCaptureTemplate(c, "");
        vm.stopPrank();
        assertEq(assets.imageFor(c, 1), "ipfs://cover", "cleared template falls back to the cover");
    }

    // ── write auth: admins ───────────────────────────────────────────────────

    function test_adminAndOwner_canWriteEverything() public {
        address c = address(collection);
        vm.prank(admin);
        assets.setCover(c, "ipfs://by-admin");
        vm.prank(admin);
        assets.setCaptureTemplate(c, "ar://t/{id}");
        _setCapture(admin, 1, "ar://f1");
        vm.prank(admin);
        assets.setCapturer(c, capturer, true);

        assertEq(assets.coverOf(c), "ipfs://by-admin");
        assertEq(assets.templateOf(c), "ar://t/{id}");
        assertEq(assets.imageFor(c, 1), "ar://f1");
        assertTrue(assets.isCapturer(c, capturer));
    }

    function test_stranger_rejectedEverywhere() public {
        address c = address(collection);
        vm.expectRevert(RenderAssets.NotSurfaceAdmin.selector);
        vm.prank(stranger);
        assets.setCover(c, "x");
        vm.expectRevert(RenderAssets.NotSurfaceAdmin.selector);
        vm.prank(stranger);
        assets.setCapturer(c, stranger, true);
        vm.expectRevert(RenderAssets.NotCaptureAuthorized.selector);
        vm.prank(stranger);
        assets.setCaptureTemplate(c, "x");
        uint256[] memory ids = new uint256[](1);
        string[] memory uris = new string[](1);
        vm.expectRevert(RenderAssets.NotCaptureAuthorized.selector);
        vm.prank(stranger);
        assets.setCaptures(c, ids, uris);
    }

    // ── write auth: the narrow capturer key ──────────────────────────────────

    function test_capturer_writesCapturesAndTemplate_nothingElse() public {
        address c = address(collection);
        vm.expectEmit(true, true, false, true, address(assets));
        emit RenderAssets.CapturerSet(c, capturer, true);
        vm.prank(artist);
        assets.setCapturer(c, capturer, true);

        // In scope: captures and the template.
        _setCapture(capturer, 3, "ar://frame3");
        assertEq(assets.imageFor(c, 3), "ar://frame3");
        vm.prank(capturer);
        assets.setCaptureTemplate(c, "ar://m/{id}.png");
        assertEq(assets.templateOf(c), "ar://m/{id}.png");

        // Out of scope: the cover and the capturer roster itself.
        vm.expectRevert(RenderAssets.NotSurfaceAdmin.selector);
        vm.prank(capturer);
        assets.setCover(c, "ipfs://nope");
        vm.expectRevert(RenderAssets.NotSurfaceAdmin.selector);
        vm.prank(capturer);
        assets.setCapturer(c, stranger, true);
    }

    function test_capturer_revoked_losesAccess() public {
        address c = address(collection);
        vm.prank(artist);
        assets.setCapturer(c, capturer, true);
        vm.prank(admin); // any admin can revoke, not only the granter
        assets.setCapturer(c, capturer, false);
        assertFalse(assets.isCapturer(c, capturer));

        vm.expectRevert(RenderAssets.NotCaptureAuthorized.selector);
        vm.prank(capturer);
        assets.setCaptureTemplate(c, "x");
    }

    function test_capturer_grantIsPerSurface() public {
        // A capturer for collection A holds nothing on collection B.
        Surface other;
        {
            Surface impl = new Surface();
            SurfaceFactory factory = new SurfaceFactory(
                address(impl),
                address(new PooledSurface()),
                address(new FixedPriceMinter()),
                address(new MockRenderer()),
                address(0)
            );
            SurfaceConfig memory cfg;
            other = Surface(factory.createSurfaceCustom("Other", "OTH", artist, cfg, new address[](0), new address[](0)));
        }
        vm.prank(artist);
        assets.setCapturer(address(collection), capturer, true);

        vm.expectRevert(RenderAssets.NotCaptureAuthorized.selector);
        vm.prank(capturer);
        assets.setCaptureTemplate(address(other), "x");
    }

    function test_setCaptures_lengthMismatchReverts() public {
        uint256[] memory ids = new uint256[](2);
        string[] memory uris = new string[](1);
        vm.expectRevert(RenderAssets.LengthMismatch.selector);
        vm.prank(artist);
        assets.setCaptures(address(collection), ids, uris);
    }

    function test_events() public {
        address c = address(collection);
        vm.expectEmit(true, false, false, true, address(assets));
        emit RenderAssets.CoverSet(c, "ipfs://cover");
        vm.prank(artist);
        assets.setCover(c, "ipfs://cover");

        vm.expectEmit(true, false, false, true, address(assets));
        emit RenderAssets.CaptureTemplateSet(c, "ar://m/{id}");
        vm.prank(artist);
        assets.setCaptureTemplate(c, "ar://m/{id}");

        uint256[] memory ids = new uint256[](1);
        ids[0] = 5;
        string[] memory uris = new string[](1);
        uris[0] = "ar://f5";
        vm.expectEmit(true, true, false, true, address(assets));
        emit RenderAssets.CaptureSet(c, 5, "ar://f5");
        vm.prank(artist);
        assets.setCaptures(c, ids, uris);
    }
}
