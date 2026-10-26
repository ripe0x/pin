// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {Surface} from "../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../src/surface/v2/FixedPriceSale.sol";
import {AllowlistGate} from "../src/surface/v2/AllowlistGate.sol";
import {CloneFactory} from "../src/surface/v2/CloneFactory.sol";
import {Launcher} from "../src/surface/v2/Launcher.sol";

/// @notice Deploy script for the Surface v2 primitives, in order: the Surface
///         implementation, the FixedPriceSale implementation, AllowlistGate,
///         the token CloneFactory, the sale CloneFactory, and the Launcher.
///         One script for every chain; chain-specific requirements are gated
///         on block.chainid, everything else is a value passed in by the
///         caller (see script/deploy.sh and script/env/*.env).
///
/// @dev    This script writes nothing. script/deploy.sh builds the deploy
///         record from the broadcast receipts after checking each address has
///         code on chain, so a simulation can never produce a record.
///
///         Both factories land paused unless LAND_PAUSED=false. The
///         launcher's owner is the broadcasting signer; its initial default
///         referrer is DEFAULT_REFERRER (required on mainnet).
///
///         Run through script/deploy.sh. Direct invocation:
///
///           forge script script/DeploySurfaceV2.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeploySurfaceV2 is Script {
    uint256 internal constant MAINNET_CHAIN_ID = 1;
    uint256 internal constant SEPOLIA_CHAIN_ID = 11155111;
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    /// @dev The mainnet deployer is EIP-7702 delegated; forge's --slow
    ///      (passed by script/deploy.sh) sends its transactions one at a time.
    address internal constant MAINNET_DEPLOYER = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;

    error UnsupportedChain(uint256 chainId);
    error DeployerMismatch(address expected, address actual);
    error DefaultReferrerRequired();

    /// @dev The env-supplied inputs. Tests pass one directly (runWith),
    ///      since vm.setEnv is process-wide and forge runs tests in parallel.
    struct Config {
        address expectedDeployer; // DEPLOYER; 0 = unchecked
        address defaultReferrer; // DEFAULT_REFERRER; required on mainnet
        bool landPaused; // LAND_PAUSED; default true
    }

    struct Deployment {
        address surfaceImplV2;
        address saleImplV2;
        address allowlistGate;
        address surfaceFactoryV2;
        address saleFactoryV2;
        address launcherV2;
    }

    /// @dev CLI entrypoint: broadcasts as the sender forge supplies (--account,
    ///      --private-key, or the default sender).
    function run() external returns (Deployment memory d) {
        return _run(address(0), readConfig());
    }

    /// @dev Same deploy, broadcasting as `sender` with an explicit config.
    ///      Used by the tests, since vm.startBroadcast and an active prank are
    ///      not compatible.
    function runWith(address sender, Config memory cfg) external returns (Deployment memory d) {
        return _run(sender, cfg);
    }

    /// @dev Unset and empty variables both fall through to the default.
    function readConfig() public view returns (Config memory) {
        return Config({
            expectedDeployer: vm.envOr("DEPLOYER", address(0)),
            defaultReferrer: vm.envOr("DEFAULT_REFERRER", address(0)),
            landPaused: vm.envOr("LAND_PAUSED", true)
        });
    }

    function _run(address sender, Config memory cfg) private returns (Deployment memory d) {
        _requireChainSupported();
        address defaultReferrer = cfg.defaultReferrer;
        bool landPaused = cfg.landPaused;
        if (block.chainid == MAINNET_CHAIN_ID && defaultReferrer == address(0)) revert DefaultReferrerRequired();

        if (sender == address(0)) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(sender);
        }

        Surface surfaceImpl = new Surface();
        FixedPriceSale saleImpl = new FixedPriceSale();
        AllowlistGate gate = new AllowlistGate();
        CloneFactory surfaceFactory = new CloneFactory(address(surfaceImpl));
        CloneFactory saleFactory = new CloneFactory(address(saleImpl));
        // The factory's deployer is msg.sender at its construction: the only
        // value that reflects the broadcasting signer from inside a script.
        Launcher launcher = new Launcher(surfaceFactory, saleFactory, defaultReferrer, surfaceFactory.deployer());

        if (landPaused) {
            surfaceFactory.setPaused(true);
            saleFactory.setPaused(true);
        }

        vm.stopBroadcast();

        d = Deployment({
            surfaceImplV2: address(surfaceImpl),
            saleImplV2: address(saleImpl),
            allowlistGate: address(gate),
            surfaceFactoryV2: address(surfaceFactory),
            saleFactoryV2: address(saleFactory),
            launcherV2: address(launcher)
        });

        _requirePostflight(d, cfg.expectedDeployer, defaultReferrer, landPaused);
        _log(d);
    }

    /// @dev Mainnet, sepolia and a local chain only: nothing here knows what a
    ///      chain nobody named should carry.
    function _requireChainSupported() internal view {
        uint256 id = block.chainid;
        if (id != MAINNET_CHAIN_ID && id != SEPOLIA_CHAIN_ID && id != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(id);
        }
    }

    /// @dev Proves the wiring landed as intended and, on mainnet, that the
    ///      signer is the recorded protocol deployer.
    function _requirePostflight(Deployment memory d, address expectedDeployer, address defaultReferrer, bool landPaused)
        private
    {
        CloneFactory surfaceFactory = CloneFactory(d.surfaceFactoryV2);
        CloneFactory saleFactory = CloneFactory(d.saleFactoryV2);
        Launcher launcher = Launcher(d.launcherV2);
        address signer = surfaceFactory.deployer();

        if (block.chainid == MAINNET_CHAIN_ID && signer != MAINNET_DEPLOYER) {
            revert DeployerMismatch(MAINNET_DEPLOYER, signer);
        }
        if (expectedDeployer != address(0) && signer != expectedDeployer) {
            revert DeployerMismatch(expectedDeployer, signer);
        }

        require(surfaceFactory.implementation() == d.surfaceImplV2, "surface factory implementation mismatch");
        require(saleFactory.implementation() == d.saleImplV2, "sale factory implementation mismatch");
        require(saleFactory.deployer() == signer, "sale factory deployer mismatch");
        require(surfaceFactory.paused() == landPaused && saleFactory.paused() == landPaused, "pause state mismatch");
        require(!surfaceFactory.deprecated() && !saleFactory.deprecated(), "factory unexpectedly deprecated");
        require(address(launcher.tokenFactory()) == d.surfaceFactoryV2, "launcher token factory mismatch");
        require(address(launcher.saleFactory()) == d.saleFactoryV2, "launcher sale factory mismatch");
        require(launcher.owner() == signer, "launcher owner mismatch");
        require(launcher.defaultReferrer() == defaultReferrer, "launcher default referrer mismatch");
        require(d.allowlistGate.code.length != 0, "allowlist gate has no code");

        // The implementations are templates, never initialized directly.
        require(Surface(d.surfaceImplV2).version() == 2, "surface implementation version mismatch");
        require(FixedPriceSale(d.saleImplV2).version() == 2, "sale implementation version mismatch");
        vm.expectRevert();
        Surface(d.surfaceImplV2).initialize("", "", address(1), address(1), 0, 0, address(1), address(1));
        vm.expectRevert();
        FixedPriceSale(d.saleImplV2).initialize(address(1), 0, 0, 0, 0, 0, address(1), address(0), address(0));
    }

    function _log(Deployment memory d) private pure {
        console2.log("surfaceImplV2=%s", d.surfaceImplV2);
        console2.log("saleImplV2=%s", d.saleImplV2);
        console2.log("allowlistGate=%s", d.allowlistGate);
        console2.log("surfaceFactoryV2=%s", d.surfaceFactoryV2);
        console2.log("saleFactoryV2=%s", d.saleFactoryV2);
        console2.log("launcherV2=%s", d.launcherV2);
    }
}
