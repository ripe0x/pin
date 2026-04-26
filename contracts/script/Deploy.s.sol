// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {PndAuctionHouse} from "../src/PndAuctionHouse.sol";
import {PndAuctionHouseFactory} from "../src/PndAuctionHouseFactory.sol";

/// @notice Mainnet deploy script for the PND auction house system.
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
///           PND_FEE_RECIPIENT — treasury that receives protocol fees
///         Optional:
///           PND_PROTOCOL_FEE_BPS — protocol fee bps. Default 0. Capped at 500
///                                  (5%). Cannot be changed after deploy.
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
        PndAuctionHouse impl = new PndAuctionHouse();
        PndAuctionHouseFactory factory = new PndAuctionHouseFactory(
            address(impl),
            feeRecipient,
            protocolFeeBps
        );
        vm.stopBroadcast();

        console2.log("PndAuctionHouse implementation:", address(impl));
        console2.log("PndAuctionHouseFactory:        ", address(factory));
        console2.log("Protocol fee (bps, locked):    ", protocolFeeBps);
        console2.log("Fee recipient (locked):        ", feeRecipient);
        console2.log("");
        console2.log("Add to packages/addresses/src/index.ts:");
        console2.log("  PND_AUCTION_HOUSE_FACTORY[MAINNET_CHAIN_ID] =", address(factory));
    }
}
