// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Base64} from "solady/utils/Base64.sol";

import {Surface} from "../src/surface/Surface.sol";
import {PooledSurface} from "../src/surface/PooledSurface.sol";
import {FixedPriceMinter} from "../src/surface/minters/FixedPriceMinter.sol";
import {SurfaceFactory, SaleConfig} from "../src/surface/SurfaceFactory.sol";
import {SurfaceConfig} from "../src/surface/SurfaceTypes.sol";
import {CodeKind, CodeRef} from "../src/surface/templates/CodeTypes.sol";

import {AntonScriptStore} from "../src/surface/works/anton/AntonScriptStore.sol";
import {AntonRenderer} from "../src/surface/works/anton/AntonRenderer.sol";

/// @notice Deploys the anton work as a Surface collection. Fully generative:
///         the script store + renderer, then `createSurface` (which bundles the
///         stock fixed-price minter — no custom minter, no per-token params).
///         Placeholder config is env-overridable.
///
///         Requires the scripty v2 builder + EthFS at their deterministic
///         addresses (mainnet or a fork). Run against a local anvil fork first:
///
///           anvil --fork-url https://ethereum-rpc.publicnode.com --port 8545
///           PRIVATE_KEY=<key> forge script script/DeployAntonWork.s.sol \
///             --rpc-url http://localhost:8545 --broadcast
contract DeployAntonWork is Script {
    address constant SCRIPTY_BUILDER_V2 = 0xD7587F110E08F4D120A231bA97d3B577A81Df022;
    address constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;
    string constant GUNZIP_FILE = "gunzipScripts-0.0.1.js";

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(pk);
        // Scripty stores serve base64 TEXT (the EthFS convention).
        bytes memory scriptB64 = bytes(Base64.encode(vm.readFileBinary("script/anton.js.gz")));

        vm.startBroadcast(pk);

        address store = address(new AntonScriptStore(scriptB64));
        address renderer = _deployRenderer(store);
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

    function _deployRenderer(address store) internal returns (address) {
        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: store, name: "anton.js", kind: CodeKind.ScriptGzip});
        return address(
            new AntonRenderer(
                SCRIPTY_BUILDER_V2, ETHFS_V2_FILE_STORAGE, GUNZIP_FILE, code, new CodeRef[](0), 1, address(0)
            )
        );
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
