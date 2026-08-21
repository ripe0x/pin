// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Base64} from "solady/utils/Base64.sol";

import {Surface} from "../src/surface/Surface.sol";
import {PooledSurface} from "../src/surface/PooledSurface.sol";
import {FixedPriceMinter} from "../src/surface/minters/FixedPriceMinter.sol";
import {SurfaceFactory} from "../src/surface/SurfaceFactory.sol";
import {SurfaceConfig} from "../src/surface/SurfaceTypes.sol";
import {ISurfaceCore} from "../src/surface/interfaces/ISurfaceCore.sol";
import {CodeKind, CodeRef} from "../src/surface/templates/CodeTypes.sol";

import {AntonParams} from "../src/surface/works/anton/AntonParams.sol";
import {AntonScriptStore} from "../src/surface/works/anton/AntonScriptStore.sol";
import {AntonRenderer} from "../src/surface/works/anton/AntonRenderer.sol";
import {AntonMinter} from "../src/surface/works/anton/AntonMinter.sol";

/// @notice Deploys the anton work as a Surface collection: params registry,
///         onchain script store, chain-live renderer, custom minter, and the
///         collection itself wired to both. Placeholder config is
///         env-overridable.
///
///         Requires the scripty v2 builder + EthFS at their deterministic
///         addresses (mainnet or a fork). Run against a local anvil fork first:
///
///           anvil --fork-url https://ethereum-rpc.publicnode.com --port 8545
///           PRIVATE_KEY=<anvil key 0> \
///             forge script script/DeployAntonWork.s.sol \
///             --rpc-url http://localhost:8545 --broadcast
contract DeployAntonWork is Script {
    address constant SCRIPTY_BUILDER_V2 = 0xD7587F110E08F4D120A231bA97d3B577A81Df022;
    address constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;
    string constant GUNZIP_FILE = "gunzipScripts-0.0.1.js";
    uint8 constant PALETTE_COUNT = 10;
    uint8 constant TONE_COUNT = 2;

    struct Deployed {
        address params;
        address store;
        address renderer;
        address factory;
        address collection;
        address minter;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(pk);
        // Scripty stores serve content as base64 TEXT (the EthFS convention),
        // so the store holds base64(gzip), not the raw gzip bytes.
        bytes memory scriptB64 = bytes(Base64.encode(vm.readFileBinary("script/anton.js.gz")));

        vm.startBroadcast(pk);
        Deployed memory d = _deploy(owner, scriptB64);
        vm.stopBroadcast();

        console2.log("AntonParams:     ", d.params);
        console2.log("AntonScriptStore:", d.store);
        console2.log("AntonRenderer:   ", d.renderer);
        console2.log("SurfaceFactory:  ", d.factory);
        console2.log("collection:      ", d.collection);
        console2.log("AntonMinter:     ", d.minter);
        console2.log("owner:           ", owner);
    }

    function _deploy(address owner, bytes memory scriptB64) internal returns (Deployed memory d) {
        d.params = address(new AntonParams(PALETTE_COUNT, TONE_COUNT));
        d.store = address(new AntonScriptStore(scriptB64));
        d.renderer = _deployRenderer(d.store, d.params);
        // Use the canonical factory when set (its SurfaceCreated is what the PND
        // indexer watches, so the collection is auto-discovered); otherwise a
        // fresh factory for an isolated dry-run.
        address canonical = vm.envOr("ANTON_FACTORY", address(0));
        d.factory = canonical != address(0)
            ? canonical
            : address(
                new SurfaceFactory(
                    address(new Surface()),
                    address(new PooledSurface()),
                    address(new FixedPriceMinter()),
                    address(0),
                    address(0)
                )
            );
        d.collection = _createCollection(d.factory, owner, d.renderer);
        d.minter = address(
            new AntonMinter(
                d.collection, d.params, vm.envOr("ANTON_PRICE", uint256(0.001 ether)), 0, 0, owner
            )
        );
        ISurfaceCore(d.collection).setMinter(d.minter, true);
    }

    function _deployRenderer(address store, address params) internal returns (address) {
        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: store, name: "anton.js", kind: CodeKind.ScriptGzip});
        return address(
            new AntonRenderer(
                SCRIPTY_BUILDER_V2, ETHFS_V2_FILE_STORAGE, GUNZIP_FILE, code, new CodeRef[](0), 1, address(0), params
            )
        );
    }

    function _createCollection(address factory, address owner, address renderer) internal returns (address) {
        SurfaceConfig memory cfg = SurfaceConfig({
            supplyCap: vm.envOr("ANTON_SUPPLY", uint256(999)),
            royaltyBps: uint16(vm.envOr("ANTON_ROYALTY_BPS", uint256(500))),
            royaltyReceiver: owner,
            renderer: renderer,
            rendererLocked: false,
            supplyLocked: false
        });
        return SurfaceFactory(factory).createSurfaceCustom(
            vm.envOr("ANTON_NAME", string("untitled")),
            vm.envOr("ANTON_SYMBOL", string("UNTITLED")),
            owner,
            cfg,
            new address[](0),
            address(0),
            new address[](0)
        );
    }
}
