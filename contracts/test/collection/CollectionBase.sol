// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {Collection} from "../../src/collection/Collection.sol";
import {CollectionFactory} from "../../src/collection/CollectionFactory.sol";
import {
    CollectionConfig,
    WorkConfig,
    InitParams,
    CollectionKind,
    IdMode
} from "../../src/collection/CollectionTypes.sol";

import {MockRenderer} from "./mocks/CollectionMocks.sol";

/// @dev Shared deployment + helpers for the Collection test suite.
contract CollectionBase is Test {
    MockRenderer internal renderer;
    Collection internal impl;
    CollectionFactory internal factory;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal referrer = makeAddr("referrer");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        renderer = new MockRenderer();
        impl = new Collection();
        // address(0) attribution: the roster-write integration is out of
        // scope for this suite (owned by the Attribution test agent).
        factory = new CollectionFactory(address(impl), address(renderer), address(0));
    }

    // ── config builders ──────────────────────────────────────────────────────

    /// @dev A free (gas-only), open-supply, open-window sequential collection.
    function _freeConfig() internal pure returns (CollectionConfig memory cfg) {
        cfg.artworkURI = "ipfs://QmArtwork";
        cfg.kind = CollectionKind.Standalone;
        cfg.idMode = IdMode.Sequential;
    }

    /// @dev A priced sequential collection. Referral share is a fixed protocol
    ///      constant, not configurable here.
    function _pricedConfig(uint256 price) internal pure returns (CollectionConfig memory cfg) {
        cfg.artworkURI = "ipfs://QmArtwork";
        cfg.kind = CollectionKind.Standalone;
        cfg.price = price;
        cfg.idMode = IdMode.Sequential;
    }

    /// @dev A pooled-mode collection with no built-in paid path (pooled sells
    ///      exclusively through an authorized minter).
    function _pooledConfig() internal pure returns (CollectionConfig memory cfg) {
        cfg.artworkURI = "ipfs://QmArtwork";
        cfg.kind = CollectionKind.Standalone;
        cfg.idMode = IdMode.Pooled;
    }

    function _emptyWork() internal pure returns (WorkConfig memory) {}

    // ── deploy helpers ───────────────────────────────────────────────────────

    function _collection(CollectionConfig memory cfg) internal returns (Collection c) {
        address[] memory noMinters = new address[](0);
        address[] memory noArtists = new address[](0);
        c = Collection(
            factory.createCollection(
                "Artist Collection", "ACOL", artist, cfg, _emptyWork(), noMinters, noArtists
            )
        );
    }

    function _collectionWithMinters(CollectionConfig memory cfg, address[] memory minters)
        internal
        returns (Collection c)
    {
        address[] memory noArtists = new address[](0);
        c = Collection(
            factory.createCollection("Artist Collection", "ACOL", artist, cfg, _emptyWork(), minters, noArtists)
        );
    }

    /// @dev A fresh, uninitialized EIP-1167 clone of `impl`, for tests that
    ///      drive `initialize()` directly (init validation, double-init).
    function _freshClone() internal returns (Collection) {
        return Collection(Clones.clone(address(impl)));
    }

    /// @dev Full InitParams with sane defaults, for tests that need to
    ///      assert on init itself (validation, double-init) rather than go
    ///      through the factory. Override individual fields on the returned
    ///      struct before calling initialize().
    function _rawInitParams(CollectionConfig memory cfg) internal view returns (InitParams memory p) {
        address[] memory noMinters = new address[](0);
        address[] memory noArtists = new address[](0);
        p = InitParams({
            name: "Artist Collection",
            symbol: "ACOL",
            owner: artist,
            cfg: cfg,
            work: _emptyWork(),
            defaultRenderer: address(renderer),
            initialMinters: noMinters,
            attribution: address(0),
            artists: noArtists
        });
    }
}
