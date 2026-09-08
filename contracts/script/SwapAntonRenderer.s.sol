// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Base64} from "solady/utils/Base64.sol";

import {AntonScriptStore} from "../src/surface/works/anton/AntonScriptStore.sol";
import {AntonRenderer} from "../src/surface/works/anton/AntonRenderer.sol";
import {CodeKind, CodeRef} from "../src/surface/templates/CodeTypes.sol";
import {ISurfaceCore} from "../src/surface/interfaces/ISurfaceCore.sol";

/// @notice Deploys a fresh AntonScriptStore + AntonRenderer from the current
///         script/anton.js.gz and points an existing Surface collection at the
///         new renderer via setRenderer. Leaves the collection, minter and any
///         mints untouched. Requires the collection's renderer to be unlocked
///         and the signer to be its owner or an admin.
///
///         PRIVATE_KEY   deployer/signer (owner or admin of the collection)
///         ANTON_COLLECTION  existing Surface collection to repoint
contract SwapAntonRenderer is Script {
    address constant SCRIPTY_BUILDER_V2 = 0xD7587F110E08F4D120A231bA97d3B577A81Df022;
    address constant ETHFS_V2_FILE_STORAGE = 0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245;
    string constant GUNZIP_FILE = "gunzipScripts-0.0.1.js";

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address collection = vm.envAddress("ANTON_COLLECTION");
        // Scripty stores serve base64 TEXT (the EthFS convention).
        bytes memory scriptB64 = bytes(Base64.encode(vm.readFileBinary("script/anton.js.gz")));

        vm.startBroadcast(pk);

        address store = address(new AntonScriptStore(scriptB64));

        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: store, name: "anton.js", kind: CodeKind.ScriptGzip});
        address renderer = address(
            new AntonRenderer(
                SCRIPTY_BUILDER_V2, ETHFS_V2_FILE_STORAGE, GUNZIP_FILE, code, new CodeRef[](0), 1, address(0)
            )
        );

        ISurfaceCore(collection).setRenderer(renderer);

        vm.stopBroadcast();

        console2.log("new AntonScriptStore:", store);
        console2.log("new AntonRenderer:   ", renderer);
        console2.log("collection:          ", collection);
    }
}
