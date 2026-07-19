// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {SurfaceFactory} from "../../src/surface/SurfaceFactory.sol";
import {SurfaceConfig, InitParams} from "../../src/surface/SurfaceTypes.sol";

import {MockRenderer} from "./mocks/SurfaceMocks.sol";

/// @dev Shared deployment + helpers for the Surface test suite.
contract SurfaceBase is Test {
    MockRenderer internal renderer;
    Surface internal impl; // sequential implementation
    PooledSurface internal pooledImpl;
    SurfaceFactory internal factory;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal referrer = makeAddr("referrer");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        renderer = new MockRenderer();
        impl = new Surface();
        pooledImpl = new PooledSurface();
        // address(0) catalog: creator-confirmation is out of scope for this
        // suite (exercised in CreatorAttribution.t.sol with a real Catalog).
        factory = new SurfaceFactory(address(impl), address(pooledImpl), address(renderer), address(0));
    }

    // ── config builders ──────────────────────────────────────────────────────

    /// @dev An open-supply config with every field at its zero default. The
    ///      token carries no price or sale schedule; those live in a minter.
    function _freeConfig() internal pure returns (SurfaceConfig memory cfg) {}

    // ── deploy helpers ───────────────────────────────────────────────────────

    function _collection(SurfaceConfig memory cfg) internal returns (Surface c) {
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);
        c = Surface(factory.createSurface("Artist Surface", "ACOL", artist, cfg, noMinters, noCreators));
    }

    function _collectionWithMinters(SurfaceConfig memory cfg, address[] memory minters) internal returns (Surface c) {
        address[] memory noCreators = new address[](0);
        c = Surface(factory.createSurface("Artist Surface", "ACOL", artist, cfg, minters, noCreators));
    }

    function _pooled(SurfaceConfig memory cfg) internal returns (PooledSurface c) {
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);
        c = PooledSurface(factory.createPooledSurface("Artist Surface", "ACOL", artist, cfg, noMinters, noCreators));
    }

    function _pooledWithMinters(SurfaceConfig memory cfg, address[] memory minters) internal returns (PooledSurface c) {
        address[] memory noCreators = new address[](0);
        c = PooledSurface(factory.createPooledSurface("Artist Surface", "ACOL", artist, cfg, minters, noCreators));
    }

    /// @dev A fresh, uninitialized EIP-1167 clone of the sequential impl, for
    ///      tests that drive `initialize()` directly (validation, double-init).
    function _freshClone() internal returns (Surface) {
        return Surface(Clones.clone(address(impl)));
    }

    /// @dev Full InitParams with sane defaults, for tests that need to
    ///      assert on init itself (validation, double-init) rather than go
    ///      through the factory. Override individual fields on the returned
    ///      struct before calling initialize().
    function _rawInitParams(SurfaceConfig memory cfg) internal view returns (InitParams memory p) {
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);
        p = InitParams({
            name: "Artist Surface",
            symbol: "ACOL",
            owner: artist,
            cfg: cfg,
            defaultRenderer: address(renderer),
            initialMinters: noMinters,
            catalog: address(0),
            creators: noCreators
        });
    }

    // ── mint helpers ─────────────────────────────────────────────────────────
    // The token has no built-in sale path: minting requires a granted minter.
    // These grant this test contract as the minter (owner-authorized) and mint
    // directly, for tests that only need tokens to exist and do not care which
    // address is the minter of record.

    function _mintTo(Surface c, address to, uint256 quantity) internal returns (uint256 firstTokenId) {
        vm.prank(artist);
        c.setMinter(address(this), true);
        firstTokenId = c.mintTo(to, quantity);
    }

    function _mintToId(PooledSurface c, address to, uint256 tokenId) internal {
        vm.prank(artist);
        c.setMinter(address(this), true);
        c.mintToId(to, tokenId);
    }
}
