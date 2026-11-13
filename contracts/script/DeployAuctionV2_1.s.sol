// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {SovereignAuctionHouseV2_1} from "../src/SovereignAuctionHouseV2_1.sol";
import {SovereignAuctionHouseV2_1Factory} from "../src/SovereignAuctionHouseV2_1Factory.sol";

/// @notice Deploys the V2.1 auction system (SovereignAuctionHouseV2_1 and its
///         factory). Houses support ERC721 and ERC1155 lots; see
///         docs/auction-house-migration-plan.md, "V2.1", for what changed.
/// @dev The script deploys one implementation and one immutable factory. It
///      does not write any deployment record; add the printed addresses to
///      contracts/deployments.<network>.json by hand after verification.
///
///      Dry run (no broadcast) against a fork first:
///        forge script script/DeployAuctionV2_1.s.sol --rpc-url $MAINNET_RPC_URL
///
///      Then run with:
///        forge script script/DeployAuctionV2_1.s.sol \
///          --rpc-url $MAINNET_RPC_URL \
///          --private-key $DEPLOYER_PK \
///          --broadcast --verify \
///          --etherscan-api-key $ETHERSCAN_API_KEY
///
///      Required:
///        PND_FEE_RECIPIENT — must be nonzero when the fee is nonzero.
///      Optional:
///        PND_PROTOCOL_FEE_BPS — defaults to 0, capped at 500 (5%).
contract DeployAuctionV2_1Script is Script {
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
        SovereignAuctionHouseV2_1 implementation = new SovereignAuctionHouseV2_1();
        SovereignAuctionHouseV2_1Factory factory = new SovereignAuctionHouseV2_1Factory(
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

        console2.log("Auction V2.1 implementation:", address(implementation));
        console2.log("Auction V2.1 factory:     ", address(factory));
        console2.log("Protocol fee (bps, locked):", protocolFeeBps);
        console2.log("Fee recipient (locked):    ", feeRecipient);
        console2.log("Implementation version:    ", implementation.version());
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
        require(
            keccak256(bytes(SovereignAuctionHouseV2_1(payable(expectedImplementation)).version()))
                == keccak256("2.1.0"),
            "implementation version mismatch"
        );
    }
}
