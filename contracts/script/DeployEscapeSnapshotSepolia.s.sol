// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BatchRenderRouter} from "../src/surface/renderers/BatchRenderRouter.sol";
import {SnapshotRenderer} from "./mocks/SnapshotRenderer.sol";

/// @notice Sepolia rehearsal: deploy a SnapshotRenderer serving the artist's real
///         captured render (escape (blue)) via URLs hosted on the Sepolia site,
///         behind a BatchRenderRouter as batch 1 (ids 1..20). Point a
///         collection's cfg.renderer at the printed router address (via the
///         deploy page, with the artist's own config) so the artist sees his
///         work in the real PND UI. Signer comes from the CLI (--account); the
///         broadcasting EOA owns the router. Never passes --broadcast itself.
///
///         Run (Sepolia, keystore):
///           forge script script/DeployEscapeSnapshotSepolia.s.sol \
///             --rpc-url $SEPOLIA_RPC_URL \
///             --account <name> --sender <deployer> --broadcast --verify
contract DeployEscapeSnapshotSepoliaScript is Script {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;

    // 3-segment path so the root-level [handle]/[tokenId] catch-all does not
    // shadow this static file (a 2-segment /snapshots/escape.html matched it).
    string internal constant HTML_URL = "https://surface-sepolia--art-pin.netlify.app/snapshots/escape/render.html";
    // The work's own hi-res still, from the artist's Arweave pin (the same URI
    // his renderer's getImageHiRes() returns). Used instead of the fully
    // onchain GIF: it is what the mainnet renderer should serve as `image`,
    // and it keeps the heavy payload out of every grid and card that renders
    // a thumbnail.
    string internal constant IMAGE_URL = "https://arweave.net/Wd2RuKlbUNn3mZgDJO4GAoDCq-_D_RosToXGQrFIxRw";

    function run() external {
        require(block.chainid == SEPOLIA_CHAIN_ID, "this script targets Sepolia only");

        vm.startBroadcast();
        SnapshotRenderer renderer = new SnapshotRenderer("Escape (blue)", "go right ahead", HTML_URL, IMAGE_URL);
        BatchRenderRouter router = new BatchRenderRouter();
        router.addBatch(1, 20, address(renderer), "Escape (blue)");
        vm.stopBroadcast();

        require(router.batchCount() == 1, "expected 1 batch");
        require(router.batchOf(1).renderer == address(renderer), "batch dispatch mismatch");
        require(router.owner() == msg.sender, "router owner is not the deployer");

        console2.log("SnapshotRenderer:    ", address(renderer));
        console2.log("BatchRenderRouter: ", address(router));
        console2.log("");
        console2.log("Next: deploy a collection with cfg.renderer =", address(router));
        console2.log("using the artist's config (name/symbol/price/cap), then mint to see his work.");
    }
}
