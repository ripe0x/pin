// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {SovereignAuctionHouse} from "../src/SovereignAuctionHouse.sol";
import {SovereignAuctionHouseFactory} from "../src/SovereignAuctionHouseFactory.sol";

/// @notice Mainnet deploy script for the Sovereign Auction House system.
/// @dev    The system is fully immutable post-deploy. Whatever protocol fee
///         and fee recipient you pass in are locked forever for this factory.
///         To change either, deploy a new factory and migrate.
///
///         Run with:
///           forge script script/Deploy.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --private-key $DEPLOYER_PK \
///             --broadcast \
///             --verify \
///             --etherscan-api-key $ETHERSCAN_API_KEY
///
///         Required env vars (besides the RPC + signer):
///           PND_FEE_RECIPIENT — treasury that receives protocol fees. Use
///                                0x0 only when PND_PROTOCOL_FEE_BPS is 0 —
///                                the constructor enforces that pairing.
///         Optional:
///           PND_PROTOCOL_FEE_BPS — protocol fee bps. Default 0. Capped at 500
///                                  (5%). Cannot be changed after deploy.
///
///         Reminder: if any contract changed since the last ABI emit, run
///           node scripts/emit-sovereign-abi.mjs
///         after deploy so the frontend picks up the new ABI.
contract DeployScript is Script {
    function run() external {
        address payable feeRecipient = payable(vm.envAddress("PND_FEE_RECIPIENT"));
        uint16 protocolFeeBps;
        try vm.envUint("PND_PROTOCOL_FEE_BPS") returns (uint256 bps) {
            require(bps <= 500, "fee bps over 5% cap");
            protocolFeeBps = uint16(bps);
        } catch {
            protocolFeeBps = 0;
        }

        vm.startBroadcast();
        SovereignAuctionHouse impl = new SovereignAuctionHouse();
        SovereignAuctionHouseFactory factory = new SovereignAuctionHouseFactory(
            address(impl),
            feeRecipient,
            protocolFeeBps
        );
        vm.stopBroadcast();

        // Post-deploy assertions: catch any constructor-arg or wiring mistake
        // before the deploy is considered "done." Any failure here aborts the
        // run with a loud revert so we don't paste a bad factory address.
        require(
            factory.implementation() == address(impl),
            "factory.implementation mismatch"
        );
        require(
            factory.defaultFeeRecipient() == feeRecipient,
            "factory.defaultFeeRecipient mismatch"
        );
        require(
            factory.defaultProtocolFeeBps() == protocolFeeBps,
            "factory.defaultProtocolFeeBps mismatch"
        );
        require(
            address(impl).code.length > 0,
            "impl has no code (deploy failed?)"
        );
        require(
            address(factory).code.length > 0,
            "factory has no code (deploy failed?)"
        );

        console2.log("SovereignAuctionHouse implementation:", address(impl));
        console2.log("SovereignAuctionHouseFactory:        ", address(factory));
        console2.log("Protocol fee (bps, locked):    ", protocolFeeBps);
        console2.log("Fee recipient (locked):        ", feeRecipient);
        console2.log("Post-deploy assertions:        OK");
        console2.log("");
        console2.log("Add to packages/addresses/src/index.ts:");
        console2.log("  SOVEREIGN_AUCTION_HOUSE_FACTORY[MAINNET_CHAIN_ID] =", address(factory));
    }
}
