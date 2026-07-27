// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Catalog} from "../src/Catalog.sol";
import {Surface} from "../src/surface/Surface.sol";
import {PooledSurface} from "../src/surface/PooledSurface.sol";
import {SurfaceFactory} from "../src/surface/SurfaceFactory.sol";
import {FixedPriceMinter} from "../src/surface/minters/FixedPriceMinter.sol";

/// @notice Sepolia deploy of the Surface platform core: Catalog (if not
///         already at its canonical address), the two collection
///         implementations, the canonical minter implementation, and the
///         factory that clones them. Mirrors DeploySurfaceSystem.s.sol
///         (mainnet); the only differences are the chain-id guard and the
///         Catalog resolution step below.
///
///         Not part of this deploy: DefaultRenderer and RenderAssets. The
///         Sepolia rehearsal uses the RENDERER preset (a router or other
///         bring-your-own IRenderer in cfg.renderer), which needs neither.
///
/// @dev    Catalog resolution: DeploySurfaceSystem.s.sol reuses the mainnet
///         CREATE2 deploy at 0x467a9c39e03C595EC3075D856f19C7386b6b915d by
///         address literal, and deploys a plain-CREATE fallback on any other
///         chain when CATALOG is unset. This script instead predicts the
///         same CREATE2 address (DETERMINISTIC_DEPLOYER + SALT, both taken
///         from DeployCatalogScript) and deploys there if it is empty, so a
///         Catalog deployed once via DeployCatalogScript.s.sol on any chain,
///         Sepolia included, lands at the identical address everywhere. This
///         keeps the registry address chain-independent instead of
///         introducing a second, Sepolia-only Catalog address that would
///         need its own bookkeeping in packages/addresses.
///
///         The two implementations and the factory deploy via plain CREATE
///         (not CREATE2): nothing needs them at a predicted address ahead of
///         time. Each implementation constructor calls _disableInitializers
///         so an impl can never be initialized; only clones are.
///
///         Deploy order:
///           1. Catalog        (reuse the canonical CREATE2 address if
///                              already deployed there on this chain, else
///                              deploy fresh via the same CREATE2 salt)
///           2. Surface + PooledSurface + FixedPriceMinter impls (CREATE, no args)
///           3. SurfaceFactory(seqImpl, pooledImpl, minterImpl, 0, catalog), then paused
///
///         The signer comes from the CLI, not from the script: vm.startBroadcast()
///         takes no key, so forge uses whatever --account / --ledger / --private-key
///         you pass. Prefer an encrypted keystore account (no raw key on disk).
///
///         Run with (Sepolia, keystore account):
///           forge script script/DeploySurfaceSystemSepolia.s.sol \
///             --rpc-url $SEPOLIA_RPC_URL \
///             --account <name> --sender <deployer address> \
///             --broadcast \
///             --verify \
///             --etherscan-api-key $ETHERSCAN_API_KEY
///
///         To preview without broadcasting (dry run; pass --sender so the
///         simulation has an origin, but no tx is sent without --broadcast):
///           forge script script/DeploySurfaceSystemSepolia.s.sol \
///             --rpc-url $SEPOLIA_RPC_URL --sender <deployer address>
///
///         No private key is read, printed, logged, or echoed anywhere in
///         this script; signing and the password prompt are handled by
///         forge. This script never passes --broadcast itself; that flag is
///         the operator's explicit choice on the command line.
contract DeploySurfaceSystemSepoliaScript is Script {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;

    /// @dev Canonical deterministic-deployment proxy. Same address on every
    ///      EVM chain. See
    ///      https://github.com/Arachnid/deterministic-deployment-proxy
    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Matches the salt DeployCatalogScript.s.sol uses on mainnet, so
    ///      the CREATE2 address this script predicts is the same one that
    ///      script would predict on any chain.
    bytes32 internal constant SALT = keccak256("Catalog");

    function run() external {
        require(block.chainid == SEPOLIA_CHAIN_ID, "this script targets Sepolia only");

        // ── 1. Catalog. Reuse the canonical CREATE2 address if it already
        //      has code on this chain (e.g. a prior DeployCatalogScript run,
        //      or a prior run of this script); set CATALOG to override with
        //      an already-known address instead. Otherwise deploy fresh at
        //      that same predicted address via the deterministic-deployment
        //      proxy.
        bytes memory catalogInitCode = type(Catalog).creationCode;
        address predictedCatalog =
            vm.computeCreate2Address(SALT, keccak256(catalogInitCode), DETERMINISTIC_DEPLOYER);

        address catalog = vm.envOr("CATALOG", address(0));
        if (catalog != address(0)) {
            console2.log("Using CATALOG override at:", catalog);
        } else if (predictedCatalog.code.length > 0) {
            catalog = predictedCatalog;
            console2.log("Reusing Catalog at canonical CREATE2 address:", catalog);
        } else {
            vm.startBroadcast();
            (bool ok,) = DETERMINISTIC_DEPLOYER.call(abi.encodePacked(SALT, catalogInitCode));
            require(ok, "Catalog CREATE2 deploy failed");
            vm.stopBroadcast();
            require(predictedCatalog.code.length > 0, "Catalog deploy succeeded but predicted address has no code");
            catalog = predictedCatalog;
            console2.log("Catalog deployed at canonical CREATE2 address:", catalog);
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
        //        flip it back with factory.setPaused(false) when ready to run
        //        the deploy-page rehearsal. Distinct from the one-way
        //        deprecate.
        vm.startBroadcast();
        factory.setPaused(true);
        vm.stopBroadcast();
        require(factory.paused(), "factory not paused at deploy");
        console2.log("SurfaceFactory paused at deploy (call setPaused(false) to open)");

        console2.log("Post-deploy assertions: OK");
        console2.log("");
        console2.log("Summary (Sepolia):");
        console2.log("  Catalog:               ", catalog);
        console2.log("  Surface (seq) impl:    ", address(sequentialImpl));
        console2.log("  PooledSurface impl:    ", address(pooledImpl));
        console2.log("  FixedPriceMinter impl: ", address(minterImpl));
        console2.log("  SurfaceFactory:        ", address(factory));
        console2.log("");
        console2.log("Next: add these addresses to packages/addresses (Sepolia chain entry),");
        console2.log("verify on sepolia.etherscan.io, then call factory.setPaused(false) when");
        console2.log("ready for the artist's deploy-page rehearsal.");
    }
}
