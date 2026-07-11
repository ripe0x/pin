// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {Collection} from "../../src/collection/Collection.sol";
import {PooledCollection} from "../../src/collection/PooledCollection.sol";
import {CollectionFactory} from "../../src/collection/CollectionFactory.sol";
import {CollectionConfig, InitParams} from "../../src/collection/CollectionTypes.sol";

import {MockRenderer} from "./mocks/CollectionMocks.sol";

/// @dev Shared deployment + helpers for the Collection test suite.
contract CollectionBase is Test {
    MockRenderer internal renderer;
    Collection internal impl; // sequential implementation
    PooledCollection internal pooledImpl;
    CollectionFactory internal factory;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal referrer = makeAddr("referrer");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        renderer = new MockRenderer();
        impl = new Collection();
        pooledImpl = new PooledCollection();
        // address(0) catalog: creator-confirmation is out of scope for this
        // suite (exercised in CreatorAttribution.t.sol with a real Catalog).
        factory = new CollectionFactory(address(impl), address(pooledImpl), address(renderer), address(0));
    }

    // ── config builders ──────────────────────────────────────────────────────

    /// @dev A free (gas-only), open-supply, open-window config.
    function _freeConfig() internal pure returns (CollectionConfig memory cfg) {}

    /// @dev A priced config. Referral share is a fixed protocol constant, not
    ///      configurable here.
    function _pricedConfig(uint256 price) internal pure returns (CollectionConfig memory cfg) {
        cfg.price = price;
    }

    // ── deploy helpers ───────────────────────────────────────────────────────

    function _collection(CollectionConfig memory cfg) internal returns (Collection c) {
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);
        c = Collection(factory.createCollection("Artist Collection", "ACOL", artist, cfg, noMinters, noCreators));
    }

    function _collectionWithMinters(CollectionConfig memory cfg, address[] memory minters)
        internal
        returns (Collection c)
    {
        address[] memory noCreators = new address[](0);
        c = Collection(factory.createCollection("Artist Collection", "ACOL", artist, cfg, minters, noCreators));
    }

    function _pooled(CollectionConfig memory cfg) internal returns (PooledCollection c) {
        address[] memory noMinters = new address[](0);
        address[] memory noCreators = new address[](0);
        c = PooledCollection(
            factory.createPooledCollection("Artist Collection", "ACOL", artist, cfg, noMinters, noCreators)
        );
    }

    function _pooledWithMinters(CollectionConfig memory cfg, address[] memory minters)
        internal
        returns (PooledCollection c)
    {
        address[] memory noCreators = new address[](0);
        c = PooledCollection(
            factory.createPooledCollection("Artist Collection", "ACOL", artist, cfg, minters, noCreators)
        );
    }

    /// @dev A fresh, uninitialized EIP-1167 clone of the sequential impl, for
    ///      tests that drive `initialize()` directly (validation, double-init).
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
