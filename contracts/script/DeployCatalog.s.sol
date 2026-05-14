// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Catalog} from "../src/Catalog.sol";

/// @notice Deploy Catalog via the canonical CREATE2
///         deterministic-deployment proxy so the registry lands at the
///         same address on every chain we ever deploy to.
///
/// @dev    The proxy at 0x4e59b44847b379578588920cA78FbF26c0B4956C is
///         present on essentially every EVM mainnet/testnet and is
///         called by sending it `salt (32 bytes) || creationCode`. It
///         executes CREATE2 with those parameters. Because the proxy's
///         address is identical on every chain, and our salt + bytecode
///         are identical, the registry lands at the same address
///         everywhere.
///
///         This is also what Safe / Permit2 / many other widely-deployed
///         contracts use. There's no provenance trust assumption: the
///         proxy contract is keyless (no admin) and well-known.
///
///         Run with (mainnet):
///           forge script script/DeployCatalog.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --private-key $DEPLOYER_PK \
///             --broadcast \
///             --verify \
///             --etherscan-api-key $ETHERSCAN_API_KEY
///
///         To preview the address without broadcasting:
///           forge script script/DeployCatalog.s.sol \
///             --rpc-url $MAINNET_RPC_URL
contract DeployCatalogScript is Script {
    /// @dev Canonical deterministic-deployment proxy. Same address on
    ///      every EVM chain. See
    ///      https://github.com/Arachnid/deterministic-deployment-proxy
    address internal constant DETERMINISTIC_DEPLOYER =
        0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Salt chosen for the Catalog deploy. Combined
    ///      with the contract's creationCode and the deployer proxy's
    ///      address, this fixes the registry's address across chains.
    ///      Salt is `keccak256("Catalog")` so a future
    ///      reader can recompute it from the contract name alone.
    bytes32 internal constant SALT =
        keccak256("Catalog");

    function run() external {
        bytes memory bytecode = type(Catalog).creationCode;
        bytes32 initCodeHash = keccak256(bytecode);

        // Predict the address before broadcasting so deploy-time logs
        // include the destination — useful for verifying that the
        // address matches what we expected, and for cross-chain
        // verification that all deploys landed at the same address.
        address predicted = vm.computeCreate2Address(
            SALT,
            initCodeHash,
            DETERMINISTIC_DEPLOYER
        );
        console2.log("Predicted address:", predicted);

        // If the registry is already at that address (e.g. someone
        // already ran the deploy), skip the broadcast — CREATE2 to an
        // occupied address reverts and we don't want the script to
        // fail on re-runs.
        if (predicted.code.length > 0) {
            console2.log("Already deployed at predicted address; skipping.");
            return;
        }

        vm.startBroadcast();
        (bool ok,) = DETERMINISTIC_DEPLOYER.call(
            abi.encodePacked(SALT, bytecode)
        );
        require(ok, "create2 deploy failed");
        vm.stopBroadcast();

        require(
            predicted.code.length > 0,
            "deploy succeeded but predicted address has no code"
        );
        console2.log("Catalog deployed at:", predicted);
    }
}
