// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Catalog} from "../src/Catalog.sol";
import {DefaultRenderer} from "../src/collection/renderers/DefaultRenderer.sol";
import {GenerativeRenderer} from "../src/collection/renderers/GenerativeRenderer.sol";
import {RenderAssets} from "../src/collection/renderers/RenderAssets.sol";
import {Collection} from "../src/collection/Collection.sol";
import {CollectionFactory} from "../src/collection/CollectionFactory.sol";

/// @notice Deploy script for the Collection system: Catalog,
///         DefaultRenderer, GenerativeRenderer, the Collection
///         implementation, and the factory that clones it.
///
/// @dev    Deploy order (Catalog first so the factory can wire it): Catalog has no
///         constructor arguments, so — exactly like `Catalog` (see
///         `DeployCatalog.s.sol`) — it is deployed through the canonical
///         deterministic-deployment proxy
///         (0x4e59b44847b379578588920cA78FbF26c0B4956C) with a fixed salt, so
///         it lands at the same address on every chain we ever deploy to.
///         Identical addresses across chains require ALL of: same deployer
///         (the proxy is identical everywhere), same salt, same init code
///         hash, same solc version, same optimizer settings (including
///         `runs`), same source. Pin the toolchain (solc 0.8.24, optimizer
///         runs = 200, per `foundry.toml`) — salt alone is not enough.
///
///         DefaultRenderer, the Collection implementation, and the
///         factory have no constructor args either, but are deployed via
///         plain CREATE here (not CREATE2) since nothing downstream needs
///         them at a predicted address ahead of time and a plain `new` keeps
///         the script simple. If cross-chain address parity for these ever
///         matters, they can be moved behind the same deterministic-deployer
///         pattern with no other changes.
///
///         GenerativeRenderer DOES take constructor args (scriptyBuilder,
///         gunzipStore, gunzipFile), so its init code
///         hash depends on those args as well as the bytecode. Even if it
///         were deployed via CREATE2 with a fixed salt, it would only land at
///         the same address on chains where the scripty builder and gunzip
///         store happen to be deployed at the same addresses AND the same
///         args are passed. Scripty v2 and EthFS are deployed deterministically
///         on many chains, but that's an external project's guarantee, not
///         this script's — verify the args are correct for the target chain
///         before relying on any address prediction here. This script uses
///         plain CREATE for GenerativeRenderer, so no address is predicted or
///         asserted; it is deployed at whatever address `new` returns on the
///         target chain.
///
///         Deploy order (later steps depend on earlier addresses):
///           1. Catalog                   (or reuse via CATALOG env)
///           2. DefaultRenderer          (CREATE, no args)
///           3. GenerativeRenderer       (CREATE, scriptyBuilder/gunzipStore/gunzipFile)
///           4. Collection impl (CREATE, no args; constructor calls
///                                        _disableInitializers so the impl
///                                        itself can never be initialized)
///           5. CollectionFactory(impl, defaultRenderer, catalog)
///
///         Run with (mainnet):
///           forge script script/DeployCollectionSystem.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --private-key $DEPLOYER_PK \
///             --broadcast \
///             --verify \
///             --etherscan-api-key $ETHERSCAN_API_KEY
///
///         To preview addresses without broadcasting (dry run; PRIVATE_KEY
///         still must be set in env because `run()` reads it unconditionally,
///         but no tx is sent without --broadcast):
///           forge script script/DeployCollectionSystem.s.sol \
///             --rpc-url $MAINNET_RPC_URL
///
///         PRIVATE_KEY is read from env for `vm.startBroadcast(pk)` so the
///         script works identically for a dry run and a real broadcast — the
///         key is never printed, logged, or echoed anywhere in this script.
contract DeployCollectionSystemScript is Script {
    /// @dev Canonical deterministic-deployment proxy. Same address on every
    ///      EVM chain. See
    ///      https://github.com/Arachnid/deterministic-deployment-proxy
    address internal constant DETERMINISTIC_DEPLOYER =
        0x4e59b44847b379578588920cA78FbF26c0B4956C;


    /// @dev Real, deterministically-deployed mainnet scripty v2 builder and
    ///      EthFS v2 file storage. Same addresses this repo's
    ///      GenerativeRendererFork test exercises against
    ///      (test/collection/renderers/GenerativeRendererFork.t.sol).
    address internal constant SCRIPTY_BUILDER_V2 = 0xD7587F110E08F4D120A231bA97d3B577A81Df022;
    address internal constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;
    string internal constant GUNZIP_FILE = "gunzipScripts-0.0.1.js";

    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");

        // ── 1. Catalog — the collection reads it to confirm creators. On
        //      mainnet this is the existing Catalog public good: set CATALOG in
        //      the env to reuse it. Unset (harness/fork) deploys a fresh one.
        address catalog = vm.envOr("CATALOG", address(0));
        if (catalog == address(0)) {
            vm.startBroadcast(deployerPk);
            catalog = address(new Catalog());
            vm.stopBroadcast();
            console2.log("Catalog deployed at:", catalog);
        } else {
            console2.log("Using existing Catalog at:", catalog);
        }

        // ── 2a. RenderAssets — plain CREATE, no args (covers + captures) ──
        vm.startBroadcast(deployerPk);
        RenderAssets renderAssets = new RenderAssets();
        vm.stopBroadcast();
        console2.log("RenderAssets deployed at:", address(renderAssets));

        // ── 2b. DefaultRenderer(renderAssets) ──
        vm.startBroadcast(deployerPk);
        DefaultRenderer defaultRenderer = new DefaultRenderer(address(renderAssets));
        vm.stopBroadcast();
        console2.log("DefaultRenderer deployed at:", address(defaultRenderer));

        // ── 3. GenerativeRenderer — plain CREATE, constructor args pinned above ──
        vm.startBroadcast(deployerPk);
        GenerativeRenderer generativeRenderer = new GenerativeRenderer(
            SCRIPTY_BUILDER_V2, address(renderAssets), ETHFS_V2_FILE_STORAGE, GUNZIP_FILE
        );
        vm.stopBroadcast();
        console2.log("GenerativeRenderer deployed at:", address(generativeRenderer));

        // ── 4. Collection implementation — plain CREATE, no args ──
        vm.startBroadcast(deployerPk);
        Collection implementation = new Collection();
        vm.stopBroadcast();
        console2.log("Collection implementation deployed at:", address(implementation));

        // ── 5. CollectionFactory(implementation, defaultRenderer, catalog) ──
        vm.startBroadcast(deployerPk);
        CollectionFactory factory = new CollectionFactory(
            address(implementation), address(defaultRenderer), catalog
        );
        vm.stopBroadcast();

        require(factory.implementation() == address(implementation), "impl mismatch");
        require(factory.defaultRenderer() == address(defaultRenderer), "renderer mismatch");
        require(factory.catalog() == catalog, "catalog mismatch");
        require(address(implementation).code.length > 0, "impl has no code");
        require(address(factory).code.length > 0, "factory has no code");

        console2.log("CollectionFactory deployed at:", address(factory));
        console2.log("Post-deploy assertions: OK");
        console2.log("");
        console2.log("Summary:");
        console2.log("  Catalog:                   ", catalog);
        console2.log("  DefaultRenderer:           ", address(defaultRenderer));
        console2.log("  GenerativeRenderer:        ", address(generativeRenderer));
        console2.log("  Collection impl:  ", address(implementation));
        console2.log("  CollectionFactory:", address(factory));
    }
}
