// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {MockRenderer} from "./mocks/SurfaceMocks.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {SurfaceFactory} from "../../src/surface/SurfaceFactory.sol";
import {ISurface} from "../../src/surface/interfaces/ISurface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";
import {SurfaceConfig, IdMode, InitParams} from "../../src/surface/SurfaceTypes.sol";

contract SurfaceTest is SurfaceBase {
    // ── init validation ──────────────────────────────────────────────────────

    function test_init_rejectsZeroOwner() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        p.owner = address(0);
        Surface clone = _freshClone();
        vm.expectRevert(ISurfaceCore.OwnerRequired.selector);
        clone.initialize(p);
    }

    function test_init_rejectsZeroDefaultRenderer() public {
        InitParams memory p = _rawInitParams(_freeConfig());
        p.defaultRenderer = address(0);
        Surface clone = _freshClone();
        vm.expectRevert(ISurfaceCore.RendererRequired.selector);
        clone.initialize(p);
    }

    /// @dev A renderer with no code would brick tokenURI — fatally so when
    ///      the collection is born rendererLocked. Refused at the door.
    function test_init_rejectsNonContractRenderer() public {
        address eoa = makeAddr("eoaRenderer");
        SurfaceConfig memory cfg = _freeConfig();
        cfg.renderer = eoa;
        InitParams memory p = _rawInitParams(cfg);
        Surface clone = _freshClone();
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.RendererNotContract.selector, eoa));
        clone.initialize(p);

        // The born-locked variant is the one the guard exists for: without it
        // this collection could never render and never be fixed.
        cfg.rendererLocked = true;
        p = _rawInitParams(cfg);
        clone = _freshClone();
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.RendererNotContract.selector, eoa));
        clone.initialize(p);
    }

    function test_setRenderer_rejectsNonContract() public {
        Surface c = _collection(_freeConfig());
        address eoa = makeAddr("eoaRenderer");
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.RendererNotContract.selector, eoa));
        vm.prank(artist);
        c.setRenderer(eoa);
    }

    function test_init_rejectsRoyaltyTooHigh() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5001; // > 50% cap
        InitParams memory p = _rawInitParams(cfg);
        Surface clone = _freshClone();
        vm.expectRevert(ISurfaceCore.RoyaltyTooHigh.selector);
        clone.initialize(p);
    }

    function test_init_allowsRoyaltyAtCap() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5000; // exactly 50%, allowed
        Surface c = _collection(cfg);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist); // defaults to owner when royaltyReceiver unset
        assertEq(amount, 0.5 ether);
    }

    function test_init_rejectsZeroInitialMinter() public {
        SurfaceConfig memory cfg = _freeConfig();
        address[] memory minters = new address[](1);
        minters[0] = address(0);
        vm.expectRevert(ISurfaceCore.ZeroMinter.selector);
        _pooledWithMinters(cfg, minters);
    }

    function test_init_grantsInitialMinters() public {
        SurfaceConfig memory cfg = _freeConfig();
        address m = makeAddr("initialMinter");
        address[] memory minters = new address[](1);
        minters[0] = m;
        PooledSurface c = _pooledWithMinters(cfg, minters);
        assertTrue(c.isMinter(m));
    }

    // ── config views ─────────────────────────────────────────────────────────

    function test_configReadable() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 10;
        Surface c = _collection(cfg);
        (SurfaceConfig memory readCfg, uint256 minted) = c.config();
        assertEq(readCfg.supplyCap, 10);
        assertEq(minted, 0);
    }

    function test_factory_deploysOwnedClone() public {
        Surface c = _collection(_freeConfig());
        assertEq(c.owner(), artist);
        assertEq(c.name(), "Artist Surface");
        assertEq(c.symbol(), "ACOL");
        assertTrue(factory.isSurface(address(c)));
        assertEq(factory.totalSurfaces(), 1);
        assertFalse(c.isRendererLocked());
        assertFalse(c.isSupplyLocked());
    }

    function test_startTokenIdIsOne() public {
        Surface c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        assertEq(c.ownerOf(1), collector);
        assertEq(c.totalSupply(), 1);
    }

    function test_idMode_reads() public {
        Surface seq = _collection(_freeConfig());
        assertEq(uint8(seq.idMode()), uint8(IdMode.Sequential));
        PooledSurface pooled = _pooled(_freeConfig());
        assertEq(uint8(pooled.idMode()), uint8(IdMode.Pooled));
    }

    // ── mint: minter-gated, non-payable, batch-native ────────────────────────

    function test_mintTo_batch_succeeds() public {
        Surface c = _collection(_freeConfig());
        uint256 firstTokenId = _mintTo(c, collector, 3);
        assertEq(firstTokenId, 1);
        assertEq(c.balanceOf(collector), 3);
        assertEq(c.ownerOf(3), collector);
        assertEq(c.totalSupply(), 3);
    }

    function test_mintTo_zeroQuantityReverts() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);
        vm.expectRevert(ISurfaceCore.ZeroQuantity.selector);
        c.mintTo(collector, 0);
    }

    /// @dev The token has no payable function at all: sending value to
    ///      mintTo reverts in the dispatcher, not in a check.
    function test_mintTo_rejectsValue() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(c).call{value: 1 wei}(abi.encodeWithSignature("mintTo(address,uint256)", collector, 1));
        assertFalse(ok, "mintTo must not accept value");
    }

    /// @dev The pooled form has no mintTo at all — the entrypoint does
    ///      not exist, so the call dies in the dispatcher, not in a check.
    function test_mintTo_pooledDoesNotExist() public {
        PooledSurface c = _pooled(_freeConfig());
        (bool ok,) = address(c).call(abi.encodeWithSignature("mintTo(address,uint256)", collector, uint256(1)));
        assertFalse(ok, "pooled must not expose mintTo");
    }

    /// @dev primaryMinter is discovery metadata only: the token itself never
    ///      gains a value-facing mint entrypoint, the minter's ergonomic
    ///      mint(uint256) overload, or a payable "purchase" path. Every
    ///      selector below either does not exist on the token or, where it
    ///      exists (mintTo), is non-payable and minter-gated.
    function test_noValueFacingMintEntrypointExistsOnEitherForm() public {
        Surface seq = _collection(_freeConfig());
        PooledSurface pooled = _pooled(_freeConfig());
        vm.deal(address(this), 1 ether);

        // mint(uint256): the minter's ergonomic overload, absent from the token.
        (bool okSeqMintQty,) = address(seq).call{value: 0}(abi.encodeWithSignature("mint(uint256)", uint256(1)));
        assertFalse(okSeqMintQty, "sequential token must not expose mint(uint256)");
        (bool okPooledMintQty,) = address(pooled).call{value: 0}(abi.encodeWithSignature("mint(uint256)", uint256(1)));
        assertFalse(okPooledMintQty, "pooled token must not expose mint(uint256)");

        // mint(address,uint256,address,bytes): the minter's value-facing ABI.
        (bool okSeqMint4,) =
            address(seq).call(abi.encodeWithSignature("mint(address,uint256,address,bytes)", collector, 1, address(0), ""));
        assertFalse(okSeqMint4, "sequential token must not expose the minter's mint ABI");

        // purchase(...): no such entrypoint ever existed on either form.
        (bool okSeqPurchase,) = address(seq).call{value: 1 wei}(abi.encodeWithSignature("purchase(uint256)", uint256(1)));
        assertFalse(okSeqPurchase, "sequential token must not expose purchase");
        (bool okPooledPurchase,) =
            address(pooled).call{value: 1 wei}(abi.encodeWithSignature("purchase(uint256)", uint256(1)));
        assertFalse(okPooledPurchase, "pooled token must not expose purchase");

        // mintTo exists on the sequential form but is non-payable and gated.
        (bool okValue,) =
            address(seq).call{value: 1 wei}(abi.encodeWithSignature("mintTo(address,uint256)", collector, uint256(1)));
        assertFalse(okValue, "the one existing mint entrypoint must reject value");
    }

    function test_Minted_eventShape() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(address(this), collector, 1, 2, 0);
        c.mintTo(collector, 2);
    }

    // ── supply cap (sequential) ──────────────────────────────────────────────

    function test_mint_capEnforced_sequential() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 3;
        Surface c = _collection(cfg);
        vm.prank(artist);
        c.setMinter(address(this), true);

        c.mintTo(collector, 2);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 3, 4));
        c.mintTo(collector, 2);
        c.mintTo(collector, 1);

        (, uint256 minted) = c.config();
        assertEq(minted, 3);
    }

    // ── live settings: royalty, supply cap + lock ────────────────────────────

    function test_setRoyalty_updatesAndCaps() public {
        Surface c = _collection(_freeConfig());
        address newReceiver = makeAddr("newRoyalty");
        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceCore.RoyaltySet(750, newReceiver);
        vm.prank(artist);
        c.setRoyalty(750, newReceiver);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, newReceiver);
        assertEq(amount, 0.075 ether);

        // the init-time cap binds the setter too
        vm.expectRevert(ISurfaceCore.RoyaltyTooHigh.selector);
        vm.prank(artist);
        c.setRoyalty(5001, newReceiver);

        // receiver 0 falls back to owner()
        vm.prank(artist);
        c.setRoyalty(100, address(0));
        (receiver,) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    function test_setRoyalty_onlyOwnerOrAdmin() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setRoyalty(100, address(0));
    }

    function test_setSupplyCap_updatesAndFloors() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 5;
        Surface c = _collection(cfg);
        _mintTo(c, collector, 3);

        // cannot set below mints-ever (sequential: ids are never reused)
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.BadSupplyCap.selector, 3, 2));
        vm.prank(artist);
        c.setSupplyCap(2);

        // shrink to exactly minted: collection closes
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.SupplyCapSet(3);
        vm.prank(artist);
        c.setSupplyCap(3);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 3, 4));
        c.mintTo(collector, 1);

        // grow re-opens; 0 = open supply
        vm.prank(artist);
        c.setSupplyCap(0);
        c.mintTo(collector, 10);
        assertEq(c.totalSupply(), 13);
    }

    function test_lockSupply_freezesCapForever() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 100;
        Surface c = _collection(cfg);
        assertFalse(c.isSupplyLocked());

        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceCore.SupplyLocked();
        vm.prank(artist);
        c.lockSupply();
        assertTrue(c.isSupplyLocked());

        vm.expectRevert(ISurfaceCore.SupplyIsLocked.selector);
        vm.prank(artist);
        c.setSupplyCap(200);

        // one-way: locking twice reverts rather than silently re-emitting
        vm.expectRevert(ISurfaceCore.SupplyIsLocked.selector);
        vm.prank(artist);
        c.lockSupply();
    }

    function test_supplyCapAndLock_onlyOwnerOrAdmin() public {
        Surface c = _collection(_freeConfig());
        vm.startPrank(stranger);
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        c.setSupplyCap(1);
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        c.lockSupply();
        vm.stopPrank();
    }

    /// @dev The cap binds every mint path, so a locked cap is a hard ceiling
    ///      regardless of which minter calls it.
    function test_lockedCap_bindsExtensionMinters() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 1;
        Surface c = _collection(cfg);
        address minter = makeAddr("minter");
        vm.startPrank(artist);
        c.setMinter(minter, true);
        c.lockSupply();
        vm.stopPrank();

        vm.prank(minter);
        c.mintTo(collector, 1);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 1, 2));
        vm.prank(minter);
        c.mintTo(collector, 1);
    }

    // ── ERC-4906 refresh signals ─────────────────────────────────────────────

    function test_erc4906_interfaceAndSetterSignals() public {
        Surface c = _collection(_freeConfig());
        assertTrue(c.supportsInterface(0x49064906));

        // renderer swap refreshes every token AND the contract-level page
        address newRenderer = address(new MockRenderer());
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.BatchMetadataUpdate(0, type(uint256).max);
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.ContractURIUpdated();
        vm.prank(artist);
        c.setRenderer(newRenderer);
    }

    /// @dev The renderer (or owner/admin) can signal refreshes the core cannot
    ///      see (chain-live works, reveals, refreshed captures in
    ///      RenderAssets) — including after lockRenderer, because the lock
    ///      pins the pointer, not a live work's output.
    function test_notifyMetadataUpdate_rendererAndAdminOnly() public {
        Surface c = _collection(_freeConfig());

        // the default renderer may signal
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.BatchMetadataUpdate(1, 10);
        vm.prank(address(renderer));
        c.notifyMetadataUpdate(1, 10);

        // the owner may signal, even after the renderer is locked
        vm.prank(artist);
        c.lockRenderer();
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceCore.BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(artist);
        c.notifyMetadataUpdate(0, type(uint256).max);

        // strangers may not
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.notifyMetadataUpdate(1, 1);
    }

    // ── royaltyInfo ──────────────────────────────────────────────────────────

    function test_royaltyInfo() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 500;
        cfg.royaltyReceiver = makeAddr("royalty");
        Surface c = _collection(cfg);
        _mintTo(c, collector, 1);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, cfg.royaltyReceiver);
        assertEq(amount, 0.05 ether);
        assertTrue(c.supportsInterface(0x2a55205a));
    }

    function test_royaltyInfo_defaultsToOwner() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 250;
        Surface c = _collection(cfg);
        (address receiver,) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    /// @dev A renounced collection with no explicit royaltyReceiver resolves
    ///      owner() to address(0); a marketplace must not route royalties
    ///      there, so the amount zeroes out alongside the zero receiver.
    function test_royaltyInfo_renouncedCollection_noReceiver_zeroesAmount() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 250;
        Surface c = _collection(cfg);
        vm.prank(artist);
        c.renounceOwnership();

        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, address(0));
        assertEq(amount, 0, "no amount is routed to the zero address");
    }

    /// @dev An explicit royaltyReceiver is unaffected by a renounced owner.
    function test_royaltyInfo_renouncedCollection_explicitReceiver_unaffected() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 500;
        cfg.royaltyReceiver = makeAddr("royalty");
        Surface c = _collection(cfg);
        vm.prank(artist);
        c.renounceOwnership();

        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, cfg.royaltyReceiver);
        assertEq(amount, 0.05 ether);
    }

    // ── rescueStrayETH ───────────────────────────────────────────────────────

    /// @dev The token holds no value of its own: any balance is force-fed
    ///      (e.g. selfdestruct), so the whole balance sweeps.
    function test_rescueStrayETH_sweepsWholeBalance() public {
        Surface c = _collection(_freeConfig());
        vm.deal(address(c), 1.5 ether);

        address dest = makeAddr("rescueDest");
        vm.prank(artist);
        c.rescueStrayETH(dest);
        assertEq(dest.balance, 1.5 ether);
        assertEq(address(c).balance, 0);

        vm.expectRevert(ISurfaceCore.NoStrayETH.selector);
        vm.prank(artist);
        c.rescueStrayETH(dest);
    }

    function test_rescueStrayETH_onlyOwner() public {
        Surface c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.rescueStrayETH(stranger);
    }

    function test_rescueStrayETH_rejectsZeroAccount() public {
        Surface c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ISurfaceCore.ZeroAccount.selector);
        vm.prank(artist);
        c.rescueStrayETH(address(0));
    }

    // ── tokenURI delegation + contractURI ────────────────────────────────────

    function test_tokenURI_delegatesToRenderer() public {
        Surface c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        assertEq(c.tokenURI(1), renderer.tokenURI(address(c), 1));
    }

    function test_tokenURI_nonexistentReverts() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.tokenURI(1);
    }

    function test_tokenURI_customRendererOverride() public {
        Surface c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        MockRenderer custom = new MockRenderer();
        vm.prank(artist);
        c.setRenderer(address(custom));
        assertEq(c.tokenURI(1), custom.tokenURI(address(c), 1));
        assertEq(c.renderer(), address(custom));
    }

    function test_contractURI_delegatesToRenderer() public {
        Surface c = _collection(_freeConfig());
        assertEq(c.contractURI(), renderer.contractURI(address(c)));
    }

    function test_setRenderer_blockedWhenLocked() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.lockRenderer();
        vm.expectRevert(ISurfaceCore.RendererIsLocked.selector);
        vm.prank(artist);
        c.setRenderer(makeAddr("newRenderer"));
    }

    function test_setRenderer_onlyOwner() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.NotAuthorized.selector);
        vm.prank(stranger);
        c.setRenderer(makeAddr("newRenderer"));
    }

    function test_setRenderer_rejectsZeroAddress() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.RendererRequired.selector);
        vm.prank(artist);
        c.setRenderer(address(0));
    }

    function test_init_resolvesRendererSlot() public {
        // No choice made: the factory default fills the slot.
        Surface c = _collection(_freeConfig());
        assertEq(c.renderer(), address(renderer));
        (SurfaceConfig memory cfg,) = c.config();
        assertEq(cfg.renderer, address(renderer));

        // An explicit choice at init wins over the default.
        MockRenderer custom = new MockRenderer();
        SurfaceConfig memory cfg2 = _freeConfig();
        cfg2.renderer = address(custom);
        Surface c2 = _collection(cfg2);
        assertEq(c2.renderer(), address(custom));
    }

    /// @dev Locks passed true in the config take effect at init: the
    ///      collection is born locked, no second transaction to remember.
    function test_init_bornLocked() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 5;
        cfg.rendererLocked = true;
        cfg.supplyLocked = true;
        Surface c = _collection(cfg);

        assertTrue(c.isRendererLocked());
        assertTrue(c.isSupplyLocked());
        vm.expectRevert(ISurfaceCore.RendererIsLocked.selector);
        vm.prank(artist);
        c.setRenderer(makeAddr("newRenderer"));
        vm.expectRevert(ISurfaceCore.SupplyIsLocked.selector);
        vm.prank(artist);
        c.setSupplyCap(10);
    }

    function test_version() public {
        Surface c = _collection(_freeConfig());
        assertEq(c.version(), 1);
    }

    // ── lockRenderer (one-way, optional) ─────────────────────────────────────

    function test_lockRenderer_isOneWayAndOptional() public {
        Surface c = _collection(_freeConfig());
        assertFalse(c.isRendererLocked(), "not locked by default");

        // still swappable before the lock
        address beforeLock = address(new MockRenderer());
        vm.prank(artist);
        c.setRenderer(beforeLock);

        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceCore.RendererLocked();
        vm.prank(artist);
        c.lockRenderer();
        assertTrue(c.isRendererLocked());

        // one-way: locking twice reverts
        vm.expectRevert(ISurfaceCore.RendererIsLocked.selector);
        vm.prank(artist);
        c.lockRenderer();
    }

    // ── factory deprecation (one-way kill switch for NEW deploys) ────────────

    function test_factory_deprecate_stopsNewDeploysOnly() public {
        // pre-deprecation deploys work; the deployer is this test contract
        Surface existing = _collection(_freeConfig());

        address successor = makeAddr("factoryV2");
        vm.expectEmit(true, false, false, false, address(factory));
        emit SurfaceFactory.Deprecated(successor);
        factory.deprecate(successor);
        assertTrue(factory.deprecated());
        assertEq(factory.successor(), successor);

        // new deploys revert...
        address[] memory none = new address[](0);
        vm.expectRevert(SurfaceFactory.FactoryDeprecated.selector);
        factory.createSurfaceCustom("After", "AFT", artist, _freeConfig(), none, address(0), none);

        // ...existing collections are untouched (immutable by design)
        _mintTo(existing, collector, 1);
        assertEq(existing.ownerOf(1), collector);

        // one-way, deployer-only
        vm.expectRevert(SurfaceFactory.AlreadyDeprecated.selector);
        factory.deprecate(address(0));
        vm.expectRevert(SurfaceFactory.NotDeployer.selector);
        vm.prank(stranger);
        factory.deprecate(address(0));
    }

    // ── factory pause (reversible off/on for NEW deploys) ────────────────────

    function test_factory_pause_isReversibleAndDeployerOnly() public {
        // baseline: a deploy works
        _collection(_freeConfig());
        assertFalse(factory.paused());

        // pause → new deploys revert; existing collections untouched
        vm.expectEmit(false, false, false, true, address(factory));
        emit SurfaceFactory.PausedSet(true);
        factory.setPaused(true);
        assertTrue(factory.paused());
        address[] memory none = new address[](0);
        vm.expectRevert(SurfaceFactory.FactoryPaused.selector);
        factory.createSurfaceCustom("Paused", "PAU", artist, _freeConfig(), none, address(0), none);

        // resume → deploys work again (the reversible part `deprecate` can't do)
        factory.setPaused(false);
        assertFalse(factory.paused());
        _collection(_freeConfig()); // no revert

        // deployer-only
        vm.expectRevert(SurfaceFactory.NotDeployer.selector);
        vm.prank(stranger);
        factory.setPaused(true);
    }

    function test_factory_deprecate_overrides_unpause() public {
        factory.deprecate(address(0));
        // even explicitly un-pausing can't revive a deprecated factory
        factory.setPaused(false);
        address[] memory none = new address[](0);
        vm.expectRevert(SurfaceFactory.FactoryDeprecated.selector);
        factory.createSurfaceCustom("Nope", "NOP", artist, _freeConfig(), none, address(0), none);
    }

    // ── renounceOwnership ─────────────────────────────────────────────────────

    function test_renounceOwnership_setsOwnerToZero() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.renounceOwnership();
        assertEq(c.owner(), address(0));
    }

    function test_renounceOwnership_onlyOwner() public {
        Surface c = _collection(_freeConfig());
        vm.prank(stranger);
        vm.expectRevert();
        c.renounceOwnership();
        assertEq(c.owner(), artist);
    }

    function test_renounceOwnership_freezesManagement() public {
        Surface c = _collection(_freeConfig());
        vm.prank(artist);
        c.renounceOwnership();
        // No owner: owner-or-admin management is uncallable.
        vm.prank(artist);
        vm.expectRevert();
        c.setRoyalty(100, address(0));
    }

    // ── Ownable2Step ─────────────────────────────────────────────────────────

    function test_ownable2Step_transferRequiresAcceptance() public {
        Surface c = _collection(_freeConfig());
        address newOwner = makeAddr("newOwner");

        vm.prank(artist);
        c.transferOwnership(newOwner);
        assertEq(c.owner(), artist); // not transferred until accepted
        assertEq(c.pendingOwner(), newOwner);

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        c.acceptOwnership();

        vm.prank(newOwner);
        c.acceptOwnership();
        assertEq(c.owner(), newOwner);
    }

    // ── fuzz: batch mint id assignment is exact ──────────────────────────────

    function testFuzz_mintTo_batchIdsAreContiguous(uint8 qtyRaw) public {
        uint256 qty = bound(qtyRaw, 1, 50);
        Surface c = _collection(_freeConfig());
        uint256 firstTokenId = _mintTo(c, collector, qty);
        assertEq(firstTokenId, 1);
        assertEq(c.balanceOf(collector), qty);
        for (uint256 i = 0; i < qty; i++) {
            assertEq(c.ownerOf(firstTokenId + i), collector);
        }
    }
}
