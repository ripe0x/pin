// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BatchRenderRouter} from "../src/surface/renderers/BatchRenderRouter.sol";
import {MockRenderer} from "./mocks/MockRenderer.sol";

/// @notice Sepolia integration rehearsal: deploy a BatchRenderRouter and two
///         MockRenderers, then register two batches (ids 1..3 -> A, 4..6 -> B).
///         Point a collection's cfg.renderer at the printed router address (via
///         the deploy page) to exercise the deploy -> router dispatch -> mint
///         -> frontend batch-view pipeline without the escape renderer's
///         onchain file dependencies.
///
///         The signer comes from the CLI (vm.startBroadcast takes no key): pass
///         --account/--ledger. The broadcasting EOA becomes the router owner,
///         so its addBatch calls in this same run are authorized. Never passes
///         --broadcast itself; that is the operator's explicit CLI choice.
///
///         Run (Sepolia, keystore):
///           forge script script/DeployMockBatchSepolia.s.sol \
///             --rpc-url $SEPOLIA_RPC_URL \
///             --account <name> --sender <deployer> --broadcast --verify
///
///         Post-deploy: after createSurface returns a collection address,
///         optionally call router.bindCollection(collection) to enable the
///         ERC-4906 relay (not needed for the mock, which has no holder toggle).
contract DeployMockBatchSepoliaScript is Script {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;

    function run() external {
        require(block.chainid == SEPOLIA_CHAIN_ID, "this script targets Sepolia only");

        vm.startBroadcast();
        MockRenderer rendererA = new MockRenderer("Batch A", "#c0392b");
        MockRenderer rendererB = new MockRenderer("Batch B", "#2980b9");
        BatchRenderRouter router = new BatchRenderRouter();
        router.addBatch(1, 3, address(rendererA), "Batch A");
        router.addBatch(4, 6, address(rendererB), "Batch B");
        vm.stopBroadcast();

        require(router.batchCount() == 2, "expected 2 batches");
        require(router.batchOf(2).renderer == address(rendererA), "batch A dispatch mismatch");
        require(router.batchOf(5).renderer == address(rendererB), "batch B dispatch mismatch");
        require(router.owner() == msg.sender, "router owner is not the deployer");

        console2.log("MockRenderer A (ids 1-3):", address(rendererA));
        console2.log("MockRenderer B (ids 4-6):", address(rendererB));
        console2.log("BatchRenderRouter:     ", address(router));
        console2.log("");
        console2.log("Next: deploy a collection with cfg.renderer =", address(router));
        console2.log("supply cap 6, then mint ids 1-6 to see both batch cards.");
    }
}
