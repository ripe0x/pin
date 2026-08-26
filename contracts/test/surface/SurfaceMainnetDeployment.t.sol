// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

interface ISurfaceFactoryDeployed {
    function sequentialImplementation() external view returns (address);
    function pooledImplementation() external view returns (address);
    function minterImplementation() external view returns (address);
    function defaultRenderer() external view returns (address);
    function catalog() external view returns (address);
}

/// @notice Drift guard: asserts the addresses recorded in
///         deployments.mainnet.json are live on mainnet and that the factory's
///         wiring matches. Catches a deployments file that drifts from chain.
///         Source-level drift (repo source != deployed bytecode) is guarded
///         separately by `forge verify-bytecode` under the default profile
///         against these same addresses (see contracts/README.md).
///
///         Run: MAINNET_RPC_URL=<url> forge test --match-contract SurfaceMainnetDeployment
contract SurfaceMainnetDeploymentTest is Test {
    // Mirrors deployments.mainnet.json (chainId 1). Keep in sync with that file.
    address constant FACTORY = 0xdB81d3F33EF3D84685486916E0d372E247558094;
    address constant SEQUENTIAL_IMPL = 0xd0cC38cB3BD18FbdAD278f14AD1f40E513f846Ef;
    address constant POOLED_IMPL = 0xd2e3Ac74DbF40c454a4211db5CF137c7355421eA;
    address constant MINTER_IMPL = 0x50941e5fd0B177826AB86419502b221049821Ba3;
    address constant CATALOG = 0x467a9c39e03C595EC3075D856f19C7386b6b915d;

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
        // A configured but unavailable endpoint is a real drift-check failure.
        vm.createSelectFork(rpc);
    }

    function test_RecordedAddressesHaveCode() public view {
        assertGt(FACTORY.code.length, 0, "factory has no code");
        assertGt(SEQUENTIAL_IMPL.code.length, 0, "sequential impl has no code");
        assertGt(POOLED_IMPL.code.length, 0, "pooled impl has no code");
        assertGt(MINTER_IMPL.code.length, 0, "minter impl has no code");
        assertGt(CATALOG.code.length, 0, "catalog has no code");
    }

    function test_FactoryWiringMatchesRecord() public view {
        ISurfaceFactoryDeployed f = ISurfaceFactoryDeployed(FACTORY);
        assertEq(f.sequentialImplementation(), SEQUENTIAL_IMPL, "sequential impl drift");
        assertEq(f.pooledImplementation(), POOLED_IMPL, "pooled impl drift");
        assertEq(f.minterImplementation(), MINTER_IMPL, "minter impl drift");
        assertEq(f.catalog(), CATALOG, "catalog drift");
        // Mainnet factory has no default renderer; a collection must supply one.
        assertEq(f.defaultRenderer(), address(0), "default renderer unexpectedly set");
    }
}
