// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {Collection} from "../../src/collection/Collection.sol";
import {CollectionFactory} from "../../src/collection/CollectionFactory.sol";
import {CollectionConfig, InitParams, IdMode} from "../../src/collection/CollectionTypes.sol";

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
        // address(0) catalog: creator-confirmation is out of scope for this
        // suite (exercised in CreatorAttribution.t.sol with a real Catalog).
        factory = new CollectionFactory(address(impl), address(renderer), address(0));
    }

    // ── config builders ──────────────────────────────────────────────────────

    /// @dev A free (gas-only), open-supply, open-window sequential collection.
    function _freeConfig() internal pure returns (CollectionConfig memory cfg) {
        cfg.idMode = IdMode.Sequential;
    }

    /// @dev A priced sequential collection. Referral share is a fixed protocol
    ///      constant, not configurable here.
    function _pricedConfig(uint256 price) internal pure returns (CollectionConfig memory cfg) {
        cfg.price = price;
        cfg.idMode = IdMode.Sequential;
    }

    /// @dev A pooled-mode collection with no built-in paid path (pooled sells
    ///      exclusively through an authorized minter).
    function _pooledConfig() internal pure returns (CollectionConfig memory cfg) {
        cfg.idMode = IdMode.Pooled;
    }

    // ── deploy helpers ───────────────────────────────────────────────────────

    function _collection(CollectionConfig memory cfg) internal returns (Collection c) {
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);
        c = Collection(
            factory.createCollection(
                "Artist Collection", "ACOL", artist, cfg, noMinters, noCreators
            )
        );
    }

    function _collectionWithMinters(CollectionConfig memory cfg, address[] memory minters)
        internal
        returns (Collection c)
    {
        address[] memory noCreators = new address[](0);
        c = Collection(
            factory.createCollection("Artist Collection", "ACOL", artist, cfg, minters, noCreators)
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
        address[] memory noCreators = new address[](0);
        p = InitParams({
            name: "Artist Collection",
            symbol: "ACOL",
            owner: artist,
            cfg: cfg,
            defaultRenderer: address(renderer),
            initialMinters: noMinters,
            catalog: address(0),
            creators: noCreators
        });
    }
}
