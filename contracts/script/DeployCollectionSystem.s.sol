// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Attribution} from "../src/collection/Attribution.sol";
import {DefaultRenderer} from "../src/collection/renderers/DefaultRenderer.sol";
import {GenerativeRenderer} from "../src/collection/renderers/GenerativeRenderer.sol";
import {SovereignCollection} from "../src/collection/SovereignCollection.sol";
import {SovereignCollectionFactory} from "../src/collection/SovereignCollectionFactory.sol";

/// @notice Deploy script for the SovereignCollection system: Attribution,
///         DefaultRenderer, GenerativeRenderer, the SovereignCollection
///         implementation, and the factory that clones it.
///
/// @dev    CREATE2 discipline (Attribution only): Attribution has no
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
///         DefaultRenderer, the SovereignCollection implementation, and the
///         factory have no constructor args either, but are deployed via
///         plain CREATE here (not CREATE2) since nothing downstream needs
///         them at a predicted address ahead of time and a plain `new` keeps
///         the script simple. If cross-chain address parity for these ever
///         matters, they can be moved behind the same deterministic-deployer
///         pattern as Attribution with no other changes.
///
///         GenerativeRenderer DOES take constructor args (scriptyBuilder,
///         gunzipStore, gunzipFile), so — unlike Attribution — its init code
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
///           1. Attribution              (CREATE2, no args)
///           2. DefaultRenderer          (CREATE, no args)
///           3. GenerativeRenderer       (CREATE, scriptyBuilder/gunzipStore/gunzipFile)
///           4. SovereignCollection impl (CREATE, no args; constructor calls
///                                        _disableInitializers so the impl
///                                        itself can never be initialized)
///           5. SovereignCollectionFactory(impl, defaultRenderer, attribution)
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

    /// @dev Salt chosen for the Attribution deploy. Combined with the
    ///      contract's creationCode and the deployer proxy's address, this
    ///      fixes Attribution's address across chains. Salt is
    ///      `keccak256("Attribution")` so a future reader can recompute it
    ///      from the contract name alone.
    bytes32 internal constant ATTRIBUTION_SALT = keccak256("Attribution");

    /// @dev Real, deterministically-deployed mainnet scripty v2 builder and
    ///      EthFS v2 file storage. Same addresses this repo's
    ///      GenerativeRendererFork test exercises against
    ///      (test/collection/renderers/GenerativeRendererFork.t.sol).
    address internal constant SCRIPTY_BUILDER_V2 = 0xD7587F110E08F4D120A231bA97d3B577A81Df022;
    address internal constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;
    string internal constant GUNZIP_FILE = "gunzipScripts-0.0.1.js";

    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");

        // ── 1. Attribution — CREATE2 via the deterministic-deployment proxy ──
        bytes memory attributionCode = type(Attribution).creationCode;
        bytes32 attributionInitCodeHash = keccak256(attributionCode);
        address predictedAttribution = vm.computeCreate2Address(
            ATTRIBUTION_SALT, attributionInitCodeHash, DETERMINISTIC_DEPLOYER
        );
        console2.log("Predicted Attribution address:", predictedAttribution);

        address attribution;
        if (predictedAttribution.code.length > 0) {
            console2.log("Attribution already deployed at predicted address; skipping.");
            attribution = predictedAttribution;
        } else {
            vm.startBroadcast(deployerPk);
            (bool ok,) = DETERMINISTIC_DEPLOYER.call(
                abi.encodePacked(ATTRIBUTION_SALT, attributionCode)
            );
            vm.stopBroadcast();
            require(ok, "Attribution create2 deploy failed");
            require(
                predictedAttribution.code.length > 0,
                "Attribution deploy succeeded but predicted address has no code"
            );
            attribution = predictedAttribution;
            console2.log("Attribution deployed at:", attribution);
        }

        // ── 2. DefaultRenderer — plain CREATE, no args ──
        vm.startBroadcast(deployerPk);
        DefaultRenderer defaultRenderer = new DefaultRenderer();
        vm.stopBroadcast();
        console2.log("DefaultRenderer deployed at:", address(defaultRenderer));

        // ── 3. GenerativeRenderer — plain CREATE, constructor args pinned above ──
        vm.startBroadcast(deployerPk);
        GenerativeRenderer generativeRenderer =
            new GenerativeRenderer(SCRIPTY_BUILDER_V2, ETHFS_V2_FILE_STORAGE, GUNZIP_FILE);
        vm.stopBroadcast();
        console2.log("GenerativeRenderer deployed at:", address(generativeRenderer));

        // ── 4. SovereignCollection implementation — plain CREATE, no args ──
        vm.startBroadcast(deployerPk);
        SovereignCollection implementation = new SovereignCollection();
        vm.stopBroadcast();
        console2.log("SovereignCollection implementation deployed at:", address(implementation));

        // ── 5. SovereignCollectionFactory(implementation, defaultRenderer, attribution) ──
        vm.startBroadcast(deployerPk);
        SovereignCollectionFactory factory = new SovereignCollectionFactory(
            address(implementation), address(defaultRenderer), attribution
        );
        vm.stopBroadcast();

        require(factory.implementation() == address(implementation), "impl mismatch");
        require(factory.defaultRenderer() == address(defaultRenderer), "renderer mismatch");
        require(factory.attribution() == attribution, "attribution mismatch");
        require(address(implementation).code.length > 0, "impl has no code");
        require(address(factory).code.length > 0, "factory has no code");

        console2.log("SovereignCollectionFactory deployed at:", address(factory));
        console2.log("Post-deploy assertions: OK");
        console2.log("");
        console2.log("Summary:");
        console2.log("  Attribution:               ", attribution);
        console2.log("  DefaultRenderer:           ", address(defaultRenderer));
        console2.log("  GenerativeRenderer:        ", address(generativeRenderer));
        console2.log("  SovereignCollection impl:  ", address(implementation));
        console2.log("  SovereignCollectionFactory:", address(factory));
    }
}
