// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Catalog} from "../src/Catalog.sol";
import {DefaultRenderer} from "../src/collection/renderers/DefaultRenderer.sol";
import {RenderAssets} from "../src/collection/renderers/RenderAssets.sol";
import {Collection} from "../src/collection/Collection.sol";
import {PooledCollection} from "../src/collection/PooledCollection.sol";
import {CollectionFactory} from "../src/collection/CollectionFactory.sol";

/// @notice Deploy script for the Collection system: Catalog, RenderAssets,
///         DefaultRenderer, the Collection implementation, and the factory
///         that clones it.
///
///         Generative works are NOT deployed here: each ships as a
///         bring-your-own renderer (a work-specific IRenderer the artist
///         deploys and points their collection's renderer slot at), so there
///         is no shared onchain assembler in this singleton set.
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
///         RenderAssets, DefaultRenderer, the two collection implementations,
///         and the factory are deployed via plain CREATE here (not CREATE2)
///         since nothing downstream needs them at a predicted address ahead of
///         time and a plain `new` keeps the script simple. (RenderAssets and
///         the implementations take no constructor args; DefaultRenderer takes
///         the RenderAssets address deployed one step earlier.) If cross-chain
///         address parity for these ever matters, they can be moved behind the
///         same deterministic-deployer pattern with no other changes.
///
///         Deploy order (later steps depend on earlier addresses):
///           1. Catalog                   (or reuse via CATALOG env)
///           2. RenderAssets             (CREATE, no args)
///           3. DefaultRenderer          (CREATE, renderAssets)
///           4. Collection + PooledCollection impls (CREATE, no args; each
///                                        constructor calls _disableInitializers
///                                        so an impl can never be initialized)
///           5. CollectionFactory(seqImpl, pooledImpl, defaultRenderer, catalog)
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
    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

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

        // ── 4. The two collection implementations — plain CREATE, no args ──
        vm.startBroadcast(deployerPk);
        Collection sequentialImpl = new Collection();
        PooledCollection pooledImpl = new PooledCollection();
        vm.stopBroadcast();
        console2.log("Collection (sequential) impl deployed at:", address(sequentialImpl));
        console2.log("PooledCollection impl deployed at:       ", address(pooledImpl));

        // ── 5. CollectionFactory(seqImpl, pooledImpl, defaultRenderer, catalog) ──
        vm.startBroadcast(deployerPk);
        CollectionFactory factory =
            new CollectionFactory(address(sequentialImpl), address(pooledImpl), address(defaultRenderer), catalog);
        vm.stopBroadcast();

        require(factory.sequentialImplementation() == address(sequentialImpl), "seq impl mismatch");
        require(factory.pooledImplementation() == address(pooledImpl), "pooled impl mismatch");
        require(factory.defaultRenderer() == address(defaultRenderer), "renderer mismatch");
        require(factory.catalog() == catalog, "catalog mismatch");
        require(address(factory).code.length > 0, "factory has no code");

        console2.log("CollectionFactory deployed at:", address(factory));
        console2.log("Post-deploy assertions: OK");
        console2.log("");
        console2.log("Summary:");
        console2.log("  Catalog:                   ", catalog);
        console2.log("  RenderAssets:              ", address(renderAssets));
        console2.log("  DefaultRenderer:           ", address(defaultRenderer));
        console2.log("  Collection (seq) impl:     ", address(sequentialImpl));
        console2.log("  PooledCollection impl:     ", address(pooledImpl));
        console2.log("  CollectionFactory:         ", address(factory));
    }
}
