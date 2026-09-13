// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";

import {Surface} from "../src/surface/Surface.sol";
import {PooledSurface} from "../src/surface/PooledSurface.sol";
import {FixedPriceMinter} from "../src/surface/minters/FixedPriceMinter.sol";
import {SurfaceFactory, SaleConfig} from "../src/surface/SurfaceFactory.sol";
import {SurfaceConfig} from "../src/surface/SurfaceTypes.sol";

import {AntonDeploy} from "./AntonDeploy.sol";

/// @notice Full local/rehearsal path for the anton work: store + renderer,
///         then `createSurface` (which bundles the stock fixed-price minter —
///         no custom minter, no per-token params). Placeholder config is
///         env-overridable. On mainnet, use DeployAntonRenderer instead; the
///         artist creates the collection from their own wallet in the studio.
///
///         Requires the scripty v2 builder + EthFS at their deterministic
///         addresses (mainnet or a fork). Run against a local anvil fork first:
///
///           anvil --fork-url https://ethereum-rpc.publicnode.com --port 8545
///           PRIVATE_KEY=<key> RENDER_ASSETS=<addr> forge script script/DeployAntonWork.s.sol \
///             --rpc-url http://localhost:8545 --broadcast
///
///         PRIVATE_KEY    deployer/signer
///         RENDER_ASSETS  deployed RenderAssets singleton; required, non-zero
///         ANTON_OWNER    collection owner; defaults to the signer
///         ANTON_FACTORY  canonical SurfaceFactory; unset deploys a fresh one
///         ANTON_SUPPLY   supply cap; defaults to 999
///         ANTON_ROYALTY_BPS  royalty bps; defaults to 500
///         ANTON_PRICE    mint price in wei; defaults to 0.001 ether
///         ANTON_NAME     collection name; defaults to "Form of Solitude"
///         ANTON_SYMBOL   collection symbol; defaults to "SOLITUDE"
contract DeployAntonWork is AntonDeploy {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.envOr("ANTON_OWNER", vm.addr(pk));
        address renderAssets = vm.envAddress("RENDER_ASSETS");

        vm.startBroadcast(pk);

        (address store, address renderer) = deployAntonRenderer(renderAssets);
        address factory = _factory();

        SurfaceConfig memory cfg = SurfaceConfig({
            supplyCap: vm.envOr("ANTON_SUPPLY", uint256(999)),
            royaltyBps: uint16(vm.envOr("ANTON_ROYALTY_BPS", uint256(500))),
            royaltyReceiver: owner,
            renderer: renderer,
            rendererLocked: false,
            supplyLocked: false
        });
        SaleConfig memory sale;
        sale.price = vm.envOr("ANTON_PRICE", uint256(0.001 ether)); // rest defaults to 0 (open, owner payout)

        (address collection, address minter) = SurfaceFactory(factory).createSurface(
            vm.envOr("ANTON_NAME", string("Form of Solitude")),
            vm.envOr("ANTON_SYMBOL", string("SOLITUDE")),
            owner,
            cfg,
            sale,
            new address[](0)
        );

        vm.stopBroadcast();

        console2.log("AntonScriptStore:", store);
        console2.log("AntonRenderer:   ", renderer);
        console2.log("SurfaceFactory:  ", factory);
        console2.log("collection:      ", collection);
        console2.log("minter (stock):  ", minter);
        console2.log("owner:           ", owner);
    }

    function _factory() internal returns (address) {
        // The canonical factory (its SurfaceCreated is what the PND indexer
        // watches) when set; otherwise a fresh one for an isolated dry-run.
        address canonical = vm.envOr("ANTON_FACTORY", address(0));
        if (canonical != address(0)) return canonical;
        return address(
            new SurfaceFactory(
                address(new Surface()),
                address(new PooledSurface()),
                address(new FixedPriceMinter()),
                address(0),
                address(0)
            )
        );
    }
}
