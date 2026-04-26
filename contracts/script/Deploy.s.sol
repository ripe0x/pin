// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {PndAuctionHouse} from "../src/PndAuctionHouse.sol";
import {PndAuctionHouseFactory} from "../src/PndAuctionHouseFactory.sol";

/// @notice Mainnet deploy script for the PND auction house system.
/// @dev    Run with:
///           forge script script/Deploy.s.sol \
///             --rpc-url $MAINNET_RPC_URL \
///             --private-key $DEPLOYER_PK \
///             --broadcast \
///             --verify \
///             --etherscan-api-key $ETHERSCAN_API_KEY
///
///         Required env vars (besides the RPC + signer):
///           PND_BEACON_OWNER     — multisig that controls implementation upgrades
///           PND_FACTORY_OWNER    — operator account that controls factory defaults
///           PND_FEE_ADMIN        — multisig that controls per-house fee config
///           PND_FEE_RECIPIENT    — treasury that receives protocol fees
///         Optional:
///           PND_INITIAL_FEE_BPS  — initial protocol fee bps (default 0)
contract DeployScript is Script {
    function run() external {
        address beaconOwner = vm.envAddress("PND_BEACON_OWNER");
        address factoryOwner = vm.envAddress("PND_FACTORY_OWNER");
        address feeAdmin = vm.envAddress("PND_FEE_ADMIN");
        address payable feeRecipient = payable(vm.envAddress("PND_FEE_RECIPIENT"));
        uint16 initialFeeBps;
        try vm.envUint("PND_INITIAL_FEE_BPS") returns (uint256 bps) {
            require(bps <= 500, "fee bps over 5% cap");
            initialFeeBps = uint16(bps);
        } catch {
            initialFeeBps = 0;
        }

        vm.startBroadcast();
        PndAuctionHouse impl = new PndAuctionHouse();
        PndAuctionHouseFactory factory = new PndAuctionHouseFactory(
            address(impl),
            beaconOwner,
            factoryOwner,
            feeAdmin,
            feeRecipient,
            initialFeeBps
        );
        vm.stopBroadcast();

        console2.log("PndAuctionHouse implementation:", address(impl));
        console2.log("PndAuctionHouseFactory:        ", address(factory));
        console2.log("UpgradeableBeacon:             ", address(factory.beacon()));
        console2.log("");
        console2.log("Add to packages/addresses/src/index.ts:");
        console2.log("  PND_AUCTION_HOUSE_FACTORY[MAINNET_CHAIN_ID] =", address(factory));
    }
}
