// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceFactoryV2, SaleConfig} from "../../../src/surface/v2/SurfaceFactoryV2.sol";
import {
    FixedPriceMinterV2,
    FixedPriceMinterV2InitParams
} from "../../../src/surface/v2/minters/FixedPriceMinterV2.sol";
import {InitParamsV2} from "../../../src/surface/v2/interfaces/ISurfaceV2.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";

import {MockRenderer} from "../mocks/SurfaceMocks.sol";

/// @dev Shared deployment + helpers for the SurfaceFactoryV2 and
///      FixedPriceMinterV2 test suites. Deploys two factory instances: one
///      with a default renderer (the common case) and one without (mirrors
///      the lean platform deploy, see SurfaceFactoryV2's own NatSpec), so
///      both wiring paths are covered without duplicating setup per file.
contract FactoryMinterV2Base is Test {
    MockRenderer internal renderer;
    SurfaceV2 internal impl;
    FixedPriceMinterV2 internal minterImpl;
    SurfaceFactoryV2 internal factory; // has a default renderer
    SurfaceFactoryV2 internal factoryNoDefault; // no default renderer, no catalog

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal referrer = makeAddr("referrer");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        renderer = new MockRenderer();
        impl = new SurfaceV2();
        minterImpl = new FixedPriceMinterV2();
        // address(0) catalog: creator confirmation is out of scope for this
        // suite.
        factory = new SurfaceFactoryV2(address(impl), address(minterImpl), address(renderer), address(0));
        factoryNoDefault = new SurfaceFactoryV2(address(impl), address(minterImpl), address(0), address(0));
    }

    // ── config builders ──────────────────────────────────────────────────────

    /// @dev An open-supply config with every field at its zero default. The
    ///      token carries no price or sale schedule; those live in a minter.
    function _freeConfig() internal pure returns (SurfaceConfig memory cfg) {}

    function _empty() internal pure returns (address[] memory a) {
        a = new address[](0);
    }

    function _one(address m) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = m;
    }

    function _sale(uint256 price) internal pure returns (SaleConfig memory s) {
        s.price = price;
    }

    // ── deploy helpers ───────────────────────────────────────────────────────
    // Go through createSurfaceCustom (bring-your-own minter, no canonical
    // clone): most of the suite grants a minter directly via setMinter and
    // does not need the wired FixedPriceMinterV2. The canonical
    // one-transaction createSurface path has its own coverage in
    // SurfaceFactoryV2.t.sol.

    function _collection(SurfaceConfig memory cfg) internal returns (SurfaceV2 c) {
        c = SurfaceV2(
            factory.createSurfaceCustom(
                "Artist Surface", "ACOL", artist, cfg, _empty(), address(0), _empty(), address(0)
            )
        );
    }

    /// @dev No primaryMinter is designated here: callers that need one set
    ///      exercise it explicitly, so a plain multi-minter grant here stays
    ///      a no-primary baseline.
    function _collectionWithMinters(SurfaceConfig memory cfg, address[] memory minters) internal returns (SurfaceV2 c) {
        c = SurfaceV2(
            factory.createSurfaceCustom(
                "Artist Surface", "ACOL", artist, cfg, minters, address(0), _empty(), address(0)
            )
        );
    }

    /// @dev A fresh, uninitialized EIP-1167 clone of the SurfaceV2
    ///      implementation, for tests that drive initialize() directly.
    function _freshClone() internal returns (SurfaceV2) {
        return SurfaceV2(Clones.clone(address(impl)));
    }

    /// @dev Full InitParamsV2 with sane defaults, for tests that need to
    ///      assert on init itself rather than go through the factory.
    ///      Override individual fields on the returned struct before calling
    ///      initialize().
    function _rawInitParams(SurfaceConfig memory cfg) internal view returns (InitParamsV2 memory p) {
        p.name = "Artist Surface";
        p.symbol = "ACOL";
        p.owner = artist;
        p.cfg = cfg;
        p.defaultRenderer = address(renderer);
        p.initialMinters = _empty();
        p.primaryMinter = address(0);
        p.catalog = address(0);
        p.creators = _empty();
        p.seedSource = address(0);
    }

    // ── mint helpers ─────────────────────────────────────────────────────────
    // The token has no built-in sale path: minting requires a granted
    // minter. Grants this test contract as the minter (owner-authorized) and
    // mints directly, for tests that only need tokens to exist.

    function _mintTo(SurfaceV2 c, address to, uint256 quantity) internal returns (uint256 firstTokenId) {
        vm.prank(artist);
        c.setMinter(address(this), true);
        firstTokenId = c.mintTo(to, quantity);
    }

    // ── FixedPriceMinterV2 helpers ──────────────────────────────────────────

    /// @dev A fresh, uninitialized EIP-1167 clone of the minter implementation.
    function _freshMinterClone() internal returns (FixedPriceMinterV2) {
        return FixedPriceMinterV2(Clones.clone(address(minterImpl)));
    }

    /// @dev Full init params with every optional field at its open/unlimited
    ///      default and payoutRecipient defaulted to `artist` (initialize()
    ///      requires it nonzero). Override individual fields on the returned
    ///      struct before calling initialize().
    function _minterParams(address collection_, uint256 price_)
        internal
        view
        returns (FixedPriceMinterV2InitParams memory p)
    {
        p.collection = collection_;
        p.price = price_;
        p.payoutRecipient = artist;
    }

    /// @dev Deploy a collection, deploy and initialize a minter clone for it
    ///      with the given fixed price and no other config, and grant the
    ///      minter on the collection. The common happy-path setup.
    function _collectionWithMinter(uint256 price_) internal returns (SurfaceV2 c, FixedPriceMinterV2 m) {
        c = _collection(_freeConfig());
        m = _freshMinterClone();
        vm.prank(artist);
        m.initialize(_minterParams(address(c), price_));
        vm.prank(artist);
        c.setMinter(address(m), true);
    }

    /// @dev Same as _collectionWithMinter but the caller supplies full init
    ///      params (for window/cap/allowlist/payout scenarios).
    function _collectionWithConfiguredMinter(FixedPriceMinterV2InitParams memory p)
        internal
        returns (SurfaceV2 c, FixedPriceMinterV2 m)
    {
        c = _collection(_freeConfig());
        m = _freshMinterClone();
        p.collection = address(c);
        vm.prank(artist);
        m.initialize(p);
        vm.prank(artist);
        c.setMinter(address(m), true);
    }

    // ── Merkle helpers (OZ standard-merkle-tree leaf format, sorted-pair hash) ──

    function _leaf(address account) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev A 2-leaf tree over (allowed1, allowed2). Returns the root and
    ///      each leaf's single-element proof.
    function _twoLeafTree(address allowed1, address allowed2)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proof1, bytes32[] memory proof2)
    {
        bytes32 leaf1 = _leaf(allowed1);
        bytes32 leaf2 = _leaf(allowed2);
        root = _hashPair(leaf1, leaf2);
        proof1 = new bytes32[](1);
        proof1[0] = leaf2;
        proof2 = new bytes32[](1);
        proof2[0] = leaf1;
    }
}
