// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PNDEditions} from "../src/editions/PNDEditions.sol";
import {PNDEditionsFactory} from "../src/editions/PNDEditionsFactory.sol";
import {PNDDefaultRenderer} from "../src/editions/PNDDefaultRenderer.sol";
import {PNDPerWalletCapHook} from "../src/editions/hooks/PNDPerWalletCapHook.sol";
import {PNDAllowlistHook} from "../src/editions/hooks/PNDAllowlistHook.sol";
import {PNDHoldsEditionHook} from "../src/editions/hooks/PNDHoldsEditionHook.sol";
import {PNDEditionsMuriOperator} from "../src/editions/PNDEditionsMuriOperator.sol";
import {PNDMuriRenderer} from "../src/editions/PNDMuriRenderer.sol";

/// @notice Deploy script for the PND Editions system: the built-in default
///         renderer, the shared PNDEditions implementation, and the factory.
///         No constructor parameters and no admin — there is no protocol fee,
///         so there is nothing to misconfigure.
///
///         Run with:
///           forge script script/DeployEditions.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --private-key $DEPLOYER_PK \
///             --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY
///
///         After deploy:
///           node scripts/emit-editions-abi.mjs   # refresh frontend ABIs
///           # then paste the factory address into packages/addresses/src/index.ts
contract DeployEditions is Script {
    /// @notice MURIProtocol mainnet singleton (immutable; ygtdmn/muri-protocol).
    ///         Present on any mainnet fork too. Overridable for other networks.
    address internal constant MURI_DEFAULT = 0x0000000000C2A0B63ab4aA971B08B905E5875b01;

    function run() external {
        address muri = vm.envOr("MURI_PROTOCOL", MURI_DEFAULT);

        vm.startBroadcast();
        PNDDefaultRenderer renderer = new PNDDefaultRenderer();
        PNDEditions impl = new PNDEditions();
        PNDEditionsFactory factory = new PNDEditionsFactory(address(impl), address(renderer));
        // Reference hook library (public goods; one shared instance serves many
        // editions, configured per-edition by each edition's owner). Optional:
        // an artist opts in by pointing setMintHook at one of these.
        PNDPerWalletCapHook perWalletCapHook = new PNDPerWalletCapHook();
        PNDAllowlistHook allowlistHook = new PNDAllowlistHook();
        PNDHoldsEditionHook holdsEditionHook = new PNDHoldsEditionHook();

        // The MURI anchor pieces only deploy where MURIProtocol actually exists
        // (mainnet or a mainnet fork). On a bare chain they are skipped so the
        // base editions system still deploys.
        address operator;
        address muriRenderer;
        if (muri.code.length > 0) {
            operator = address(new PNDEditionsMuriOperator(muri));
            muriRenderer = address(new PNDMuriRenderer(muri));
        }
        vm.stopBroadcast();

        require(factory.implementation() == address(impl), "impl mismatch");
        require(factory.defaultRenderer() == address(renderer), "renderer mismatch");
        require(address(impl).code.length > 0, "impl has no code");
        require(address(factory).code.length > 0, "factory has no code");

        console2.log("PNDDefaultRenderer:   ", address(renderer));
        console2.log("PNDEditions impl:     ", address(impl));
        console2.log("PNDEditionsFactory:   ", address(factory));
        console2.log("PNDPerWalletCapHook:  ", address(perWalletCapHook));
        console2.log("PNDAllowlistHook:     ", address(allowlistHook));
        console2.log("PNDHoldsEditionHook:  ", address(holdsEditionHook));
        if (operator != address(0)) {
            require(address(PNDEditionsMuriOperator(operator).muri()) == muri, "operator muri mismatch");
            console2.log("PNDEditionsMuriOperator:", operator);
            console2.log("PNDMuriRenderer:      ", muriRenderer);
        } else {
            console2.log("MURI pieces skipped (no MURIProtocol at", muri);
            console2.log(") on this chain.");
        }
        console2.log("Post-deploy assertions: OK");
        console2.log("");
        console2.log("Add to packages/addresses/src/index.ts:");
        console2.log("  PND_EDITIONS_FACTORY[MAINNET_CHAIN_ID] =", address(factory));
        console2.log("  PND_EDITIONS_MURI_OPERATOR[MAINNET_CHAIN_ID] =", operator);
        console2.log("  PND_MURI_RENDERER[MAINNET_CHAIN_ID] =", muriRenderer);
    }
}
