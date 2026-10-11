// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

/// @notice The deploy wrapper keeps credentials out of process arguments.
///         forge reads ETHERSCAN_API_KEY from the environment, so the wrapper
///         must pass --verify alone.
contract DeployWrapperSecretsTest is Test {
    function test_deployWrapper_keepsEtherscanKeyOutOfArgv() public view {
        string memory wrapper = vm.readFile("script/deploy.sh");
        assertFalse(
            vm.contains(wrapper, "--etherscan-api-key"),
            "deploy.sh passes the Etherscan key as an argument"
        );
        assertTrue(vm.contains(wrapper, "--verify"), "deploy.sh no longer verifies");
    }
}
