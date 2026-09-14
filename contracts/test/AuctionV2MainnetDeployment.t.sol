// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

interface IAuctionV2FactoryDeployed {
    function implementation() external view returns (address);
    function defaultFeeRecipient() external view returns (address);
    function defaultProtocolFeeBps() external view returns (uint16);
}

/// @notice Drift guard: asserts the Sovereign Auction House V2 addresses
///         recorded in deployments.mainnet.json are live on mainnet and that
///         the factory's wiring and locked fee terms match the record.
///         Source-level drift (repo source != deployed bytecode) is covered by
///         the Etherscan verification of both addresses under the default
///         profile (see contracts/README.md).
///
///         Run: RUN_MAINNET_FORK_TESTS=true MAINNET_RPC_URL=<url> \
///              forge test --match-contract AuctionV2MainnetDeployment
contract AuctionV2MainnetDeploymentTest is Test {
    // Mirrors deployments.mainnet.json (chainId 1). Keep in sync with that file.
    address constant FACTORY = 0x77aB853543286C9Cdd7dd6c01222A7cC4Ac93d63;
    address constant IMPLEMENTATION = 0x88b48793f38EF7370F2e7BC12E2f73DC565C117F;
    uint16 constant PROTOCOL_FEE_BPS = 0;
    address constant FEE_RECIPIENT = address(0);

    function setUp() public {
        if (!vm.envOr("RUN_MAINNET_FORK_TESTS", false)) {
            emit log("skipping mainnet deployment drift test: set RUN_MAINNET_FORK_TESTS=true to run");
            vm.skip(true);
            return;
        }
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            revert("MAINNET_RPC_URL required when RUN_MAINNET_FORK_TESTS=true");
        }
        vm.createSelectFork(rpc);
    }

    function test_RecordedAddressesHaveCode() public view {
        assertGt(FACTORY.code.length, 0, "factory has no code");
        // An EIP-7702 delegation indicator is 23 bytes; contract code is far larger.
        assertGt(IMPLEMENTATION.code.length, 23, "implementation is not contract code");
    }

    function test_FactoryWiringMatchesRecord() public view {
        IAuctionV2FactoryDeployed f = IAuctionV2FactoryDeployed(FACTORY);
        assertEq(f.implementation(), IMPLEMENTATION, "implementation drift");
        assertEq(f.defaultProtocolFeeBps(), PROTOCOL_FEE_BPS, "protocol fee drift");
        assertEq(f.defaultFeeRecipient(), FEE_RECIPIENT, "fee recipient drift");
    }
}
