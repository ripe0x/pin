// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceFactoryV2} from "../../../src/surface/v2/SurfaceFactoryV2.sol";
import {InitParamsV2} from "../../../src/surface/v2/interfaces/ISurfaceV2.sol";
import {FixedPriceMinterV2} from "../../../src/surface/v2/minters/FixedPriceMinterV2.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";

import {MockRenderer} from "../mocks/SurfaceMocks.sol";

/// @dev Shared deployment + helpers for the SurfaceV2 test suite. Mirrors
///      test/surface/SurfaceBase.sol's shape, minus everything pooled.
contract SurfaceV2Base is Test {
    MockRenderer internal renderer;
    SurfaceV2 internal impl;
    FixedPriceMinterV2 internal minterImpl; // canonical minter implementation
    SurfaceFactoryV2 internal factory;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal referrer = makeAddr("referrer");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        renderer = new MockRenderer();
        impl = new SurfaceV2();
        minterImpl = new FixedPriceMinterV2();
        // address(0) catalog: creator-confirmation coverage uses a mock
        // catalog inline in SurfaceV2.t.sol rather than a factory default.
        factory = new SurfaceFactoryV2(address(impl), address(minterImpl), address(renderer), address(0));
    }

    // ── config builders ──────────────────────────────────────────────────────

    /// @dev An open-supply config with every field at its zero default. The
    ///      token carries no price or sale schedule; those live in a minter.
    function _freeConfig() internal pure returns (SurfaceConfig memory cfg) {}

    // ── deploy helpers ───────────────────────────────────────────────────────
    // These go through createSurfaceCustom (bring-your-own minter, no
    // canonical clone): most of the suite grants a minter directly via
    // setMinter and does not need the wired FixedPriceMinterV2.

    function _collection(SurfaceConfig memory cfg) internal returns (SurfaceV2 c) {
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);
        c = SurfaceV2(
            factory.createSurfaceCustom(
                "Artist Surface", "ACOL", artist, cfg, noMinters, address(0), noCreators, address(0)
            )
        );
    }

    /// @dev No primaryMinter is designated here: callers that need one set
    ///      exercise it explicitly via setPrimaryMinter.
    function _collectionWithMinters(SurfaceConfig memory cfg, address[] memory minters)
        internal
        returns (SurfaceV2 c)
    {
        address[] memory noCreators = new address[](0);
        c = SurfaceV2(
            factory.createSurfaceCustom(
                "Artist Surface", "ACOL", artist, cfg, minters, address(0), noCreators, address(0)
            )
        );
    }

    function _collectionWithCreators(SurfaceConfig memory cfg, address[] memory creators)
        internal
        returns (SurfaceV2 c)
    {
        address[] memory noMinters = new address[](0);
        c = SurfaceV2(
            factory.createSurfaceCustom(
                "Artist Surface", "ACOL", artist, cfg, noMinters, address(0), creators, address(0)
            )
        );
    }

    function _collectionWithSeedSource(SurfaceConfig memory cfg, address seedSource) internal returns (SurfaceV2 c) {
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);
        c = SurfaceV2(
            factory.createSurfaceCustom(
                "Artist Surface", "ACOL", artist, cfg, noMinters, address(0), noCreators, seedSource
            )
        );
    }

    /// @dev A fresh, uninitialized EIP-1167 clone of the implementation, for
    ///      tests that drive `initialize()` directly (validation, double-init).
    function _freshClone() internal returns (SurfaceV2) {
        return SurfaceV2(Clones.clone(address(impl)));
    }

    /// @dev Full InitParamsV2 with sane defaults, for tests that need to
    ///      assert on init itself rather than go through the factory.
    ///      Override individual fields on the returned struct before calling
    ///      initialize().
    function _rawInitParams(SurfaceConfig memory cfg) internal view returns (InitParamsV2 memory p) {
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);
        p = InitParamsV2({
            name: "Artist Surface",
            symbol: "ACOL",
            owner: artist,
            cfg: cfg,
            defaultRenderer: address(renderer),
            initialMinters: noMinters,
            primaryMinter: address(0),
            catalog: address(0),
            creators: noCreators,
            seedSource: address(0)
        });
    }

    // ── mint helpers ─────────────────────────────────────────────────────────
    // The token has no built-in sale path: minting requires a granted minter.
    // These grant this test contract as the minter (owner-authorized) and mint
    // directly, for tests that only need tokens to exist and do not care which
    // address is the minter of record.

    function _mintTo(SurfaceV2 c, address to, uint256 quantity) internal returns (uint256 firstTokenId) {
        vm.prank(artist);
        c.setMinter(address(this), true);
        firstTokenId = c.mintTo(to, quantity);
    }

    function _mintToSeeded(SurfaceV2 c, address to, bytes32[] memory seeds)
        internal
        returns (uint256 firstTokenId)
    {
        vm.prank(artist);
        c.setMinter(address(this), true);
        firstTokenId = c.mintToSeeded(to, seeds);
    }
}
