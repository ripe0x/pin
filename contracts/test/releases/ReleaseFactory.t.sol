// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

import {ReleasesTestBase} from "./ReleasesTestBase.sol";
import {Release} from "../../src/releases/Release.sol";
import {ReleaseFactory} from "../../src/releases/ReleaseFactory.sol";
import {GateMode, ReleaseParams} from "../../src/releases/IRelease.sol";
import {MockERC721} from "../MockERC721.sol";

contract ReleaseFactoryTest is ReleasesTestBase {
    // ── Construction ─────────────────────────────────────────────────────

    function test_constructor_setsConstants() public view {
        assertEq(factory.owner(), pnd);
        assertEq(factory.maxSurfaceFee(), MAX_SURFACE_FEE);
        assertEq(factory.surfaceFee(), SURFACE_FEE);
        assertEq(factory.totalReleases(), 0);
    }

    function test_constructor_revertsWhenFeeAboveCap() public {
        vm.expectRevert("fee above cap");
        new ReleaseFactory(pnd, 0.001 ether, 0.002 ether);
    }

    function test_constructor_zeroCapMeansFeelessForever() public {
        ReleaseFactory feeless = new ReleaseFactory(pnd, 0, 0);
        assertEq(feeless.surfaceFee(), 0);
        vm.prank(pnd);
        vm.expectRevert("fee above cap");
        feeless.setSurfaceFee(1);
    }

    // ── setSurfaceFee ────────────────────────────────────────────────────

    function test_setSurfaceFee() public {
        vm.prank(pnd);
        vm.expectEmit();
        emit ReleaseFactory.SurfaceFeeSet(0.0008 ether);
        factory.setSurfaceFee(0.0008 ether);
        assertEq(factory.surfaceFee(), 0.0008 ether);
    }

    function test_setSurfaceFee_revertsAboveCap() public {
        vm.prank(pnd);
        vm.expectRevert("fee above cap");
        factory.setSurfaceFee(MAX_SURFACE_FEE + 1);
    }

    function test_setSurfaceFee_atCapAllowed() public {
        vm.prank(pnd);
        factory.setSurfaceFee(MAX_SURFACE_FEE);
        assertEq(factory.surfaceFee(), MAX_SURFACE_FEE);
    }

    function test_setSurfaceFee_onlyOwner() public {
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                other
            )
        );
        factory.setSurfaceFee(0);
    }

    // ── createRelease ────────────────────────────────────────────────────

    function test_createRelease_registryAndOwnership() public {
        Release r = createDefault();

        assertTrue(factory.isRelease(address(r)));
        assertEq(factory.allReleases(0), address(r));
        assertEq(factory.totalReleases(), 1);

        assertEq(r.owner(), artist);
        assertEq(r.artist(), artist);
        assertEq(r.name(), "Test Release");
        assertEq(r.symbol(), "TEST");
        assertEq(r.price(), PRICE);
        assertEq(r.surfaceFee(), SURFACE_FEE);
        assertEq(r.payout(), artist); // defaulted from address(0)
        assertEq(r.royaltyReceiver(), artist); // defaulted to payout
        assertEq(r.royaltyBps(), 500);
    }

    function test_createRelease_emitsFatEvent() public {
        ReleaseParams memory p = defaultParams();
        vm.prank(artist);
        // The release address is not predictable here; check the
        // non-indexed payload (fee snapshot + full params echo).
        vm.expectEmit(false, true, false, true, address(factory));
        emit ReleaseFactory.ReleaseCreated(address(0), artist, SURFACE_FEE, p);
        factory.createRelease(p);
    }

    function test_createRelease_snapshotsFeeAtCreation() public {
        Release before = createDefault();

        vm.prank(pnd);
        factory.setSurfaceFee(0.001 ether);
        Release afterward = createDefault();

        // The fee change reached only the new release.
        assertEq(before.surfaceFee(), SURFACE_FEE);
        assertEq(afterward.surfaceFee(), 0.001 ether);
    }

    function test_createRelease_freeReleaseSnapshotsZeroFee() public {
        ReleaseParams memory p = defaultParams();
        p.price = 0;
        Release r = createRelease(p);
        // Free means free, baked into the immutable.
        assertEq(r.surfaceFee(), 0);
    }

    function test_createRelease_anyCallerIsArtist() public {
        ReleaseParams memory p = defaultParams();
        vm.prank(other);
        Release r = Release(factory.createRelease(p));
        assertEq(r.artist(), other);
        assertEq(r.owner(), other);
    }

    // ── Param validation (lives in Release; bubbles through the factory) ─

    function test_createRelease_revertsEndBeforeStart() public {
        ReleaseParams memory p = defaultParams();
        p.endTime = p.startTime; // exclusive end == inclusive start: empty
        vm.expectRevert("end not after start/now");
        createRelease(p);
    }

    function test_createRelease_revertsEndInPast() public {
        ReleaseParams memory p = defaultParams();
        p.startTime = uint64(block.timestamp - 2 days);
        p.endTime = uint64(block.timestamp); // exclusive: already over
        vm.expectRevert("end not after start/now");
        createRelease(p);
    }

    function test_createRelease_allowsPastStart() public {
        ReleaseParams memory p = defaultParams();
        p.startTime = uint64(block.timestamp - 1 days); // live immediately
        Release r = createRelease(p);
        assertEq(r.startTime(), p.startTime);
    }

    function test_createRelease_revertsGateTokenWithoutMode() public {
        ReleaseParams memory p = defaultParams();
        p.gateToken = address(new MockERC721());
        vm.expectRevert("gate token without mode");
        createRelease(p);
    }

    function test_createRelease_revertsGateWithoutCode() public {
        ReleaseParams memory p = defaultParams();
        p.gateMode = GateMode.HOLD;
        p.gateToken = makeAddr("eoa-gate");
        vm.expectRevert("gate token has no code");
        createRelease(p);
    }

    function test_createRelease_revertsRoyaltyAboveCap() public {
        ReleaseParams memory p = defaultParams();
        p.royaltyBps = 5_001;
        vm.expectRevert("royalty above cap");
        createRelease(p);
    }

    function test_createRelease_revertsRendererWithoutCode() public {
        ReleaseParams memory p = defaultParams();
        p.renderer = makeAddr("eoa-renderer");
        vm.expectRevert("renderer has no code");
        createRelease(p);
    }

    // ── Size headroom alarm ──────────────────────────────────────────────

    /// @notice The factory embeds Release creation code, so its runtime is
    ///         the size risk (EIP-170: 24,576). Alarm well before the wall
    ///         so growth shows up in review, not at deploy time.
    function test_sizes_headroom() public {
        Release r = createDefault();
        assertLt(address(factory).code.length, 23_000, "factory near EIP-170");
        assertLt(address(r).code.length, 23_000, "release near EIP-170");
    }
}
