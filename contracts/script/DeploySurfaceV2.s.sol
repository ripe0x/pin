// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {Catalog} from "../src/Catalog.sol";
import {SurfaceV2} from "../src/surface/v2/SurfaceV2.sol";
import {SurfaceFactoryV2} from "../src/surface/v2/SurfaceFactoryV2.sol";
import {FixedPriceMinterV2} from "../src/surface/v2/minters/FixedPriceMinterV2.sol";
import {InitParamsV2} from "../src/surface/v2/interfaces/ISurfaceV2.sol";
import {SurfaceConfig} from "../src/surface/SurfaceTypes.sol";
import {RenderAssets} from "../src/surface/renderers/RenderAssets.sol";
import {DefaultRenderer} from "../src/surface/renderers/DefaultRenderer.sol";

/// @notice Deploy script for the Surface v2 core: the SurfaceV2 implementation,
///         the FixedPriceMinterV2 implementation, RenderAssets, DefaultRenderer,
///         and SurfaceFactoryV2. One script for every chain; chain-specific
///         requirements are gated on block.chainid, everything else is a value
///         passed in by the caller (see script/deploy.sh and script/env/*.env).
///
/// @dev    RENDER_ASSETS and DEFAULT_RENDERER are each reused when the env
///         supplies an address with deployed code, otherwise deployed fresh.
///         CATALOG is required to already exist (the v1 Catalog is a public
///         good shared across the Surface protocol; this script never deploys
///         one) except on a local chain with no chainid match, where a fresh
///         Catalog is deployed so the script runs standalone.
///
///         Deploy order: SurfaceV2 impl, FixedPriceMinterV2 impl, RenderAssets
///         (reuse or deploy), DefaultRenderer (reuse or deploy, wired to
///         RenderAssets), SurfaceFactoryV2(seqImpl, minterImpl, defaultRenderer,
///         catalog). The factory lands paused unless LAND_PAUSED=false.
///
///         Run through script/deploy.sh, which supplies the chain-specific RPC,
///         wallet and env values from script/env/<name>.env. Direct invocation:
///
///           forge script script/DeploySurfaceV2.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeploySurfaceV2 is Script {
    uint256 internal constant MAINNET_CHAIN_ID = 1;
    uint256 internal constant SEPOLIA_CHAIN_ID = 11155111;
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    /// @dev The mainnet deployer is EIP-7702 delegated; forge's --slow
    ///      (passed by script/deploy.sh) sends its transactions one at a time.
    address internal constant MAINNET_DEPLOYER = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;

    /// @dev The Surface protocol's Catalog public good, same address on every
    ///      chain it is deployed to (see deployments.mainnet.json). Reused,
    ///      never redeployed, by the v2 factory on mainnet.
    address internal constant MAINNET_CATALOG = 0x467a9c39e03C595EC3075D856f19C7386b6b915d;

    error UnsupportedChain(uint256 chainId);
    error DeployerMismatch(address expected, address actual);
    error CatalogRequired();
    error CatalogMismatch(address expected, address actual);

    struct Deployment {
        address surfaceFactoryV2;
        address sequentialImplementationV2;
        address minterImplementationV2;
        address defaultRenderer;
        address renderAssets;
        address catalog;
    }

    function run() external returns (Deployment memory d) {
        _requireChainSupported();

        address catalog = vm.envOr("CATALOG", address(0));
        address renderAssetsIn = vm.envOr("RENDER_ASSETS", address(0));
        address defaultRendererIn = vm.envOr("DEFAULT_RENDERER", address(0));
        address expectedDeployer = vm.envOr("DEPLOYER", address(0));
        bool landPaused = vm.envOr("LAND_PAUSED", true);

        if (block.chainid == MAINNET_CHAIN_ID) {
            if (catalog == address(0)) revert CatalogRequired();
        } else if (catalog == address(0) && block.chainid != LOCAL_CHAIN_ID) {
            revert CatalogRequired();
        }

        vm.startBroadcast();

        if (catalog == address(0)) {
            // Local-chain convenience only: mainnet and sepolia both require an
            // existing Catalog above and never reach this branch.
            catalog = address(new Catalog());
        }

        SurfaceV2 sequentialImpl = new SurfaceV2();
        FixedPriceMinterV2 minterImpl = new FixedPriceMinterV2();

        RenderAssets renderAssets = _hasCode(renderAssetsIn) ? RenderAssets(renderAssetsIn) : new RenderAssets();

        DefaultRenderer defaultRenderer = _hasCode(defaultRendererIn)
            ? DefaultRenderer(defaultRendererIn)
            : new DefaultRenderer(address(renderAssets));

        SurfaceFactoryV2 factory = new SurfaceFactoryV2(
            address(sequentialImpl), address(minterImpl), address(defaultRenderer), catalog
        );

        if (landPaused) factory.setPaused(true);

        vm.stopBroadcast();

        d = Deployment({
            surfaceFactoryV2: address(factory),
            sequentialImplementationV2: address(sequentialImpl),
            minterImplementationV2: address(minterImpl),
            defaultRenderer: address(defaultRenderer),
            renderAssets: address(renderAssets),
            catalog: catalog
        });

        _requirePostflight(d, expectedDeployer, landPaused);
        // `forge script` runs every cheatcode in this function, including
        // vm.writeJson, during a plain simulation. The record is written
        // when the run broadcasts or resumes a broadcast, the two modes
        // that land transactions.
        if (
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
                || vm.isContext(VmSafe.ForgeContext.ScriptResume)
        ) _writeRecord(d);
        _log(d);
    }

    /// @dev Mainnet requires the ripe0x deployer; sepolia and a local chain
    ///      accept whatever DEPLOYER the env supplies (or skip the check if
    ///      unset). Any chain id other than mainnet, sepolia, or local reverts:
    ///      nothing here knows what a chain nobody named should carry.
    function _requireChainSupported() internal view {
        uint256 id = block.chainid;
        if (id != MAINNET_CHAIN_ID && id != SEPOLIA_CHAIN_ID && id != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(id);
        }
    }

    function _hasCode(address a) internal view returns (bool) {
        return a != address(0) && a.code.length != 0;
    }

    /// @dev Proves the constructor wiring landed as intended and, on mainnet,
    ///      that the catalog and signer match the recorded protocol values.
    function _requirePostflight(Deployment memory d, address expectedDeployer, bool landPaused) private {
        if (block.chainid == MAINNET_CHAIN_ID) {
            if (tx.origin != MAINNET_DEPLOYER) revert DeployerMismatch(MAINNET_DEPLOYER, tx.origin);
            if (d.catalog != MAINNET_CATALOG) revert CatalogMismatch(MAINNET_CATALOG, d.catalog);
        }
        if (expectedDeployer != address(0) && tx.origin != expectedDeployer) {
            revert DeployerMismatch(expectedDeployer, tx.origin);
        }

        SurfaceFactoryV2 factory = SurfaceFactoryV2(d.surfaceFactoryV2);
        require(factory.sequentialImplementation() == d.sequentialImplementationV2, "sequential impl mismatch");
        require(factory.minterImplementation() == d.minterImplementationV2, "minter impl mismatch");
        require(factory.defaultRenderer() == d.defaultRenderer, "default renderer mismatch");
        require(factory.catalog() == d.catalog, "catalog mismatch");
        require(factory.deployer() == tx.origin, "factory deployer mismatch");
        require(factory.paused() == landPaused, "factory pause state mismatch");
        require(!factory.deprecated(), "factory unexpectedly deprecated");

        // The implementation is a template, never initialized directly: proves
        // _disableInitializers ran and reports the protocol's v2 lineage marker.
        SurfaceV2 impl = SurfaceV2(d.sequentialImplementationV2);
        require(impl.version() == 2, "sequential implementation version mismatch");
        vm.expectRevert();
        impl.initialize(_emptyInitParams());

        require(d.catalog.code.length != 0, "catalog has no code");
        require(d.renderAssets.code.length != 0, "render assets has no code");
        require(d.defaultRenderer.code.length != 0, "default renderer has no code");
        require(DefaultRenderer(d.defaultRenderer).renderAssets() == RenderAssets(d.renderAssets), "renderer/assets mismatch");
    }

    /// @dev A zeroed InitParamsV2 to prove an implementation clone rejects
    ///      initialize() (InvalidInitialization from _disableInitializers,
    ///      fired before any field is inspected), never a real init payload.
    function _emptyInitParams() private pure returns (InitParamsV2 memory p) {
        p.cfg = SurfaceConfig({
            supplyCap: 0,
            royaltyBps: 0,
            royaltyReceiver: address(0),
            renderer: address(0),
            rendererLocked: false,
            supplyLocked: false
        });
    }

    /// @dev The repo's canonical per-chain record: deployments.mainnet.json
    ///      and deployments.sepolia.json already carry the v1 protocol's
    ///      addresses and are read by packages/addresses/src/index.ts and
    ///      scripts/generate-docs.ts. deployments.anvil.json is this script's
    ///      own local-chain equivalent (gitignored, never a real deployment).
    ///      _requireChainSupported already reverted any other chain id.
    function _recordPath() private view returns (string memory) {
        if (block.chainid == MAINNET_CHAIN_ID) return "deployments.mainnet.json";
        if (block.chainid == SEPOLIA_CHAIN_ID) return "deployments.sepolia.json";
        return "deployments.anvil.json";
    }

    /// @dev Writes the v2 record keys into the file _recordPath() names. A
    ///      file that already exists (deployments.mainnet.json and
    ///      deployments.sepolia.json always do) is merged key by key so the
    ///      v1 keys this script never names survive untouched; a missing
    ///      file (deployments.anvil.json, the first time) is created fresh
    ///      with only these keys.
    function _writeRecord(Deployment memory d) private {
        string memory path = _recordPath();

        if (!vm.isFile(path)) {
            string memory json = "record";
            vm.serializeUint(json, "chainId", block.chainid);
            vm.serializeUint(json, "deployedAt", block.timestamp);
            vm.serializeAddress(json, "deployer", tx.origin);
            vm.serializeAddress(json, "surfaceFactoryV2", d.surfaceFactoryV2);
            vm.serializeAddress(json, "sequentialImplementationV2", d.sequentialImplementationV2);
            vm.serializeAddress(json, "minterImplementationV2", d.minterImplementationV2);
            vm.serializeAddress(json, "defaultRenderer", d.defaultRenderer);
            vm.serializeAddress(json, "renderAssets", d.renderAssets);
            vm.serializeAddress(json, "catalog", d.catalog);
            string memory out = vm.serializeUint(json, "factoryDeployBlock", block.number);
            vm.writeJson(out, path);
            return;
        }

        vm.writeJson(vm.toString(block.chainid), path, ".chainId");
        vm.writeJson(vm.toString(block.timestamp), path, ".deployedAt");
        _writeAddressKey(path, ".deployer", tx.origin);
        _writeAddressKey(path, ".surfaceFactoryV2", d.surfaceFactoryV2);
        _writeAddressKey(path, ".sequentialImplementationV2", d.sequentialImplementationV2);
        _writeAddressKey(path, ".minterImplementationV2", d.minterImplementationV2);
        _writeAddressKey(path, ".defaultRenderer", d.defaultRenderer);
        _writeAddressKey(path, ".renderAssets", d.renderAssets);
        _writeAddressKey(path, ".catalog", d.catalog);
        vm.writeJson(vm.toString(block.number), path, ".factoryDeployBlock");
    }

    function _writeAddressKey(string memory path, string memory key, address value) private {
        vm.writeJson(string.concat('"', vm.toString(value), '"'), path, key);
    }

    function _log(Deployment memory d) private pure {
        console2.log("surfaceFactoryV2=%s", d.surfaceFactoryV2);
        console2.log("sequentialImplementationV2=%s", d.sequentialImplementationV2);
        console2.log("minterImplementationV2=%s", d.minterImplementationV2);
        console2.log("defaultRenderer=%s", d.defaultRenderer);
        console2.log("renderAssets=%s", d.renderAssets);
        console2.log("catalog=%s", d.catalog);
    }
}
