// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {PNDEditionsFactory} from "../../src/editions/PNDEditionsFactory.sol";
import {PNDDefaultRenderer} from "../../src/editions/PNDDefaultRenderer.sol";
import {ReleaseConfig, ReleaseKind, ProjectMode} from "../../src/editions/PNDEditionsTypes.sol";

/// @dev Shared deployment + helpers for the PND Editions test suite.
contract PNDEditionsBase is Test {
    PNDDefaultRenderer internal renderer;
    PNDEditions internal impl;
    PNDEditionsFactory internal factory;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal surface = makeAddr("surface");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        renderer = new PNDDefaultRenderer();
        impl = new PNDEditions();
        factory = new PNDEditionsFactory(address(impl), address(renderer));
    }

    function _project(ProjectMode mode) internal returns (PNDEditions p) {
        p = PNDEditions(factory.createProject("Artist Project", "APJ", artist, mode));
    }

    function _immutableProject() internal returns (PNDEditions) {
        return _project(ProjectMode.ImmutableClone);
    }

    /// @dev A free (gas-only) standalone release with no cap and no window.
    function _freeReleaseConfig() internal pure returns (ReleaseConfig memory cfg) {
        cfg.defaultArtworkURI = "ipfs://QmArtwork";
        cfg.kind = ReleaseKind.Standalone;
    }

    /// @dev A priced release. surfaceShareBps out of the price; payout = owner.
    function _pricedReleaseConfig(uint256 price, uint16 surfaceShareBps)
        internal
        pure
        returns (ReleaseConfig memory cfg)
    {
        cfg.defaultArtworkURI = "ipfs://QmArtwork";
        cfg.kind = ReleaseKind.Standalone;
        cfg.price = price;
        cfg.surfaceShareBps = surfaceShareBps;
    }

    function _createRelease(PNDEditions p, ReleaseConfig memory cfg)
        internal
        returns (uint256 id)
    {
        vm.prank(artist);
        id = p.createRelease(cfg);
    }
}
