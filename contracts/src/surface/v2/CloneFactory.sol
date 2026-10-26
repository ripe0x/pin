// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {Address} from "openzeppelin-contracts/contracts/utils/Address.sol";

/// @title CloneFactory
/// @notice Plumbing, deployed once per implementation. Clones the
///         implementation, calls it with `initData` (an encoded initialize
///         call) in the same transaction, and records the instance.
///         Discovery is the Created event plus isInstance; there is no list.
contract CloneFactory {
    address public immutable implementation;
    /// @notice The only address that can pause or deprecate.
    address public immutable deployer;

    bool public paused;
    bool public deprecated;
    address public successor;

    mapping(address => bool) public isInstance;

    error NotAContract(address account);
    error NotDeployer();
    error FactoryPaused();
    error FactoryDeprecated();
    error AlreadyDeprecated();

    event Created(address indexed implementation, address indexed instance, address indexed caller);
    event PausedSet(bool paused);
    event Deprecated(address indexed successor);

    constructor(address implementation_) {
        if (implementation_.code.length == 0) revert NotAContract(implementation_);
        implementation = implementation_;
        deployer = msg.sender;
    }

    function create(bytes calldata initData) external returns (address instance) {
        _requireOpen();
        instance = Clones.clone(implementation);
        _init(instance, initData);
    }

    /// @notice `salt` is namespaced by the caller; see predict.
    function createDeterministic(bytes32 salt, bytes calldata initData) external returns (address instance) {
        _requireOpen();
        instance = Clones.cloneDeterministic(implementation, _salt(msg.sender, salt));
        _init(instance, initData);
    }

    /// @notice The address createDeterministic(salt, ...) returns when
    ///         called by `caller`.
    function predict(bytes32 salt, address caller) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(caller, salt));
    }

    /// @notice Deployer only. Halts new instances; existing ones are untouched.
    function setPaused(bool paused_) external {
        if (msg.sender != deployer) revert NotDeployer();
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Deployer only, one-way. Halts new instances and names where
    ///         new ones should come from; existing ones are untouched.
    function deprecate(address successor_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (deprecated) revert AlreadyDeprecated();
        deprecated = true;
        successor = successor_;
        emit Deprecated(successor_);
    }

    function _requireOpen() internal view {
        if (deprecated) revert FactoryDeprecated();
        if (paused) revert FactoryPaused();
    }

    /// @dev Bubbles the initializer's revert, so a bad init reverts the
    ///      whole create and no half-initialized instance is ever recorded.
    function _init(address instance, bytes calldata initData) internal {
        Address.functionCall(instance, initData);
        isInstance[instance] = true;
        emit Created(implementation, instance, msg.sender);
    }

    function _salt(address caller, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(caller, salt));
    }
}
