// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Catalog} from "../src/Catalog.sol";
import {Surface} from "../src/surface/Surface.sol";
import {PooledSurface} from "../src/surface/PooledSurface.sol";
import {SurfaceFactory} from "../src/surface/SurfaceFactory.sol";
import {FixedPriceMinter} from "../src/surface/minters/FixedPriceMinter.sol";

/// @notice Deploy script for the Surface platform core: the two collection
///         implementations and the factory that clones them. Nothing else.
///
///         The factory reuses the already-deployed Catalog and has no default
///         renderer: every collection supplies its own via cfg.renderer, so
///         RenderAssets and DefaultRenderer are not part of this deploy.
///         Either can be deployed later as a standalone singleton and used
///         per collection with no factory change.
///
/// @dev    Catalog is a public good already live on mainnet at
///         0x467a9c39e03C595EC3075D856f19C7386b6b915d (a CREATE2 deterministic
///         deploy, the same address on every chain). On mainnet the script
///         reuses it by default; set CATALOG to override. On a fresh chain
///         (unset, off mainnet) it deploys one so harness/fork runs have a
///         Catalog to point at.
///
///         The two implementations and the factory deploy via plain CREATE
///         (not CREATE2): nothing needs them at a predicted address ahead of
///         time. Each implementation constructor calls _disableInitializers so
///         an impl can never be initialized; only clones are.
///
///         Deploy order:
///           1. Catalog        (reuse the mainnet public good, or deploy fresh
///                              off mainnet)
///           2. Surface + PooledSurface + FixedPriceMinter impls (CREATE, no args)
///           3. SurfaceFactory(seqImpl, pooledImpl, minterImpl, 0, catalog), then paused
///
///         The signer comes from the CLI, not from the script: vm.startBroadcast()
///         takes no key, so forge uses whatever --account / --ledger / --private-key
///         you pass. Prefer an encrypted keystore account (no raw key on disk).
///
///         Run with (mainnet, keystore account):
///           forge script script/DeploySurfaceSystem.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --account <name> --sender <deployer address> \
///             --broadcast \
///             --verify \
///             --etherscan-api-key $ETHERSCAN_API_KEY
///
///         To preview without broadcasting (dry run; pass --sender so the
///         simulation has an origin, but no tx is sent without --broadcast):
///           forge script script/DeploySurfaceSystem.s.sol \
///             --rpc-url $MAINNET_RPC_URL --sender <deployer address>
///
///         No private key is read, printed, logged, or echoed anywhere in this
///         script; signing and the password prompt are handled by forge.
contract DeploySurfaceSystemScript is Script {
    /// @dev The Catalog public good, live on mainnet. Same CREATE2 address on
    ///      every chain it has been deployed to. Reused by default on mainnet.
    address internal constant MAINNET_CATALOG = 0x467a9c39e03C595EC3075D856f19C7386b6b915d;

    function run() external {
        // ── 1. Catalog. On mainnet, reuse the existing public good (the default
        //      below); set CATALOG to override. On a fresh chain (unset, off
        //      mainnet) deploy one so harness/fork runs have a Catalog to point
        //      at. Defaulting to the known address on mainnet means a forgotten
        //      env var reuses it instead of deploying a duplicate.
        address catalog = vm.envOr("CATALOG", block.chainid == 1 ? MAINNET_CATALOG : address(0));
        if (catalog == address(0)) {
            vm.startBroadcast();
            catalog = address(new Catalog());
            vm.stopBroadcast();
            console2.log("Catalog deployed at:", catalog);
        } else {
            console2.log("Using existing Catalog at:", catalog);
        }

        // ── 2. The two collection implementations + the canonical minter
        //      implementation — plain CREATE, no args.
        vm.startBroadcast();
        Surface sequentialImpl = new Surface();
        PooledSurface pooledImpl = new PooledSurface();
        FixedPriceMinter minterImpl = new FixedPriceMinter();
        vm.stopBroadcast();
        console2.log("Surface (sequential) impl deployed at:", address(sequentialImpl));
        console2.log("PooledSurface impl deployed at:       ", address(pooledImpl));
        console2.log("FixedPriceMinter impl deployed at:    ", address(minterImpl));

        // ── 3. SurfaceFactory(seqImpl, pooledImpl, minterImpl, defaultRenderer=0, catalog).
        //      No default renderer: every collection brings its own via
        //      cfg.renderer, and one that names none reverts RendererRequired.
        vm.startBroadcast();
        SurfaceFactory factory =
            new SurfaceFactory(address(sequentialImpl), address(pooledImpl), address(minterImpl), address(0), catalog);
        vm.stopBroadcast();

        require(factory.sequentialImplementation() == address(sequentialImpl), "seq impl mismatch");
        require(factory.pooledImplementation() == address(pooledImpl), "pooled impl mismatch");
        require(factory.minterImplementation() == address(minterImpl), "minter impl mismatch");
        require(factory.defaultRenderer() == address(0), "expected no default renderer");
        require(factory.catalog() == catalog, "catalog mismatch");
        require(address(factory).code.length > 0, "factory has no code");
        console2.log("SurfaceFactory deployed at:", address(factory));

        // ── 3b. Land the factory PAUSED so no clone can be created until the
        //        deployer opens it. setPaused is deployer-only and reversible:
        //        flip it back with factory.setPaused(false) when ready to go
        //        live. Distinct from the one-way deprecate.
        vm.startBroadcast();
        factory.setPaused(true);
        vm.stopBroadcast();
        require(factory.paused(), "factory not paused at deploy");
        console2.log("SurfaceFactory paused at deploy (call setPaused(false) to open)");

        console2.log("Post-deploy assertions: OK");
        console2.log("");
        console2.log("Summary:");
        console2.log("  Catalog:               ", catalog);
        console2.log("  Surface (seq) impl:    ", address(sequentialImpl));
        console2.log("  PooledSurface impl:    ", address(pooledImpl));
        console2.log("  FixedPriceMinter impl: ", address(minterImpl));
        console2.log("  SurfaceFactory:        ", address(factory));
    }
}
