// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BatchRenderRouter} from "../src/surface/renderers/BatchRenderRouter.sol";
import {ISurfaceCore} from "../src/surface/interfaces/ISurfaceCore.sol";
import {SnapshotRenderer} from "./mocks/SnapshotRenderer.sol";

/// @notice Move the Sepolia rehearsal onto a SnapshotRenderer that serves the
///         work's hi-res Arweave still as `image`, and onto a router that has
///         setRenderer (the deployed one predates it). Deploys both, registers
///         the batch, then points the collection's renderer slot at the new
///         router. The collection address, its owner, its minter, and its
///         existing mints are all unchanged; only what the tokens render moves.
///
///         The signer must own the collection and be the router deployer (both
///         are the rehearsal deployer). Run:
///           forge script script/UpdateEscapeSnapshotSepolia.s.sol \
///             --rpc-url $SEPOLIA_RPC_URL \
///             --account <name> --sender <deployer> --broadcast --verify
contract UpdateEscapeSnapshotSepoliaScript is Script {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;

    address internal constant COLLECTION = 0x9738d574dA42C1c699F29bf22b51550c9bEa3bce;

    string internal constant HTML_URL = "https://surface-sepolia--art-pin.netlify.app/snapshots/escape/render.html";
    string internal constant IMAGE_URL = "https://arweave.net/Wd2RuKlbUNn3mZgDJO4GAoDCq-_D_RosToXGQrFIxRw";

    function run() external {
        require(block.chainid == SEPOLIA_CHAIN_ID, "this script targets Sepolia only");

        vm.startBroadcast();
        SnapshotRenderer renderer = new SnapshotRenderer("Escape (blue)", "go right ahead", HTML_URL, IMAGE_URL);
        BatchRenderRouter router = new BatchRenderRouter();
        router.addBatch(1, 20, address(renderer), "Escape (blue)");
        ISurfaceCore(COLLECTION).setRenderer(address(router));
        vm.stopBroadcast();

        require(router.batchOf(1).renderer == address(renderer), "batch not registered");

        console2.log("SnapshotRenderer:  ", address(renderer));
        console2.log("BatchRenderRouter: ", address(router));
        console2.log("Collection renderer repointed. Address, owner, minter, mints unchanged.");
    }
}
