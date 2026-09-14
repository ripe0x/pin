// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {SovereignAuctionHouseV2} from "../src/SovereignAuctionHouseV2.sol";
import {SovereignAuctionHouseV2Factory} from "../src/SovereignAuctionHouseV2Factory.sol";

/// @notice Deploys the V2 auction system, whose houses support ERC721 and ERC1155 lots.
/// @dev The script deploys one implementation and one immutable factory.
///
///      Run with:
///        forge script script/DeployAuctionV2.s.sol \
///          --rpc-url $MAINNET_RPC_URL \
///          --private-key $DEPLOYER_PK \
///          --broadcast --verify \
///          --etherscan-api-key $ETHERSCAN_API_KEY
///
///      Required:
///        PND_FEE_RECIPIENT — must be nonzero when the fee is nonzero.
///      Optional:
///        PND_PROTOCOL_FEE_BPS — defaults to 0, capped at 500 (5%).
contract DeployAuctionV2Script is Script {
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
        SovereignAuctionHouseV2 implementation = new SovereignAuctionHouseV2();
        SovereignAuctionHouseV2Factory factory = new SovereignAuctionHouseV2Factory(
            address(implementation), feeRecipient, protocolFeeBps
        );
        vm.stopBroadcast();

        _assertFactory(
            factory.implementation(),
            factory.defaultFeeRecipient(),
            factory.defaultProtocolFeeBps(),
            address(implementation),
            feeRecipient,
            protocolFeeBps
        );

        console2.log("Auction V2 implementation:", address(implementation));
        console2.log("Auction V2 factory:       ", address(factory));
        console2.log("Protocol fee (bps, locked):", protocolFeeBps);
        console2.log("Fee recipient (locked):    ", feeRecipient);
        console2.log("Post-deploy assertions:     OK");
    }

    function _assertFactory(
        address actualImplementation,
        address actualFeeRecipient,
        uint16 actualProtocolFeeBps,
        address expectedImplementation,
        address expectedFeeRecipient,
        uint16 expectedProtocolFeeBps
    ) private view {
        require(actualImplementation == expectedImplementation, "factory implementation mismatch");
        require(actualFeeRecipient == expectedFeeRecipient, "factory fee recipient mismatch");
        require(actualProtocolFeeBps == expectedProtocolFeeBps, "factory fee mismatch");
        require(expectedImplementation.code.length != 0, "implementation deploy failed");
    }
}
