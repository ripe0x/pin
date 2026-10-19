// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {AntonDeploy} from "./AntonDeploy.sol";

/// @notice One-transaction deployment of the current gzipped artwork.
///         Pass the signer with forge --account / --sender.
contract DeployAntonStore is AntonDeploy {
    function run() external {
        vm.startBroadcast();
        address store = deployAntonStore();
        vm.stopBroadcast();
        console2.log("AntonScriptStore:", store);
    }
}
