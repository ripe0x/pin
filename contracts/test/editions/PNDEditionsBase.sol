// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {PNDEditionsFactory} from "../../src/editions/PNDEditionsFactory.sol";
import {PNDDefaultRenderer} from "../../src/editions/PNDDefaultRenderer.sol";
import {EditionConfig, EditionKind} from "../../src/editions/PNDEditionsTypes.sol";

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

    function _edition(EditionConfig memory cfg) internal returns (PNDEditions p) {
        p = PNDEditions(factory.createEdition("Artist Edition", "AED", artist, cfg));
    }

    /// @dev A free (gas-only) standalone edition with no cap and no window.
    function _freeConfig() internal pure returns (EditionConfig memory cfg) {
        cfg.artworkURI = "ipfs://QmArtwork";
        cfg.kind = EditionKind.Standalone;
    }

    /// @dev A priced edition. Surface share is a fixed protocol constant, not
    ///      configurable here.
    function _pricedConfig(uint256 price) internal pure returns (EditionConfig memory cfg) {
        cfg.artworkURI = "ipfs://QmArtwork";
        cfg.kind = EditionKind.Standalone;
        cfg.price = price;
    }
}
