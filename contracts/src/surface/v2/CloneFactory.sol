// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {Address} from "openzeppelin-contracts/contracts/utils/Address.sol";

/// @title CloneFactory
/// @notice Plumbing, deployed once per implementation. Clones the
///         implementation, calls its initializer with `initData` in the same
///         transaction, and records the instance. Discovery is the Created
///         event plus isInstance; there is no list.
///
/// @dev    Every clone is CREATE2 with a salt namespaced by the caller, so no
///         caller can land on an address another caller can predict for
///         themselves. A sale authorizes itself through the token naming it
///         as minter, so an owner who grants a predicted address before the
///         sale exists must be the only one able to deploy there.
contract CloneFactory {
    address public immutable implementation;
    /// @notice The only selector `initData` may call: the implementation's
    ///         initializer, which either initializes the clone or reverts.
    bytes4 public immutable initSelector;
    /// @notice The only address that can pause or deprecate.
    address public immutable deployer;

    bool public paused;
    bool public deprecated;
    address public successor;

    mapping(address => bool) public isInstance;
    /// @notice Number of `create` calls made by each caller.
    mapping(address => uint256) public createNonce;

    error NotAContract(address account);
    error NotInitializer(bytes4 selector);
    error NotDeployer();
    error FactoryPaused();
    error FactoryDeprecated();
    error AlreadyDeprecated();

    event Created(address indexed implementation, address indexed instance, address indexed caller);
    event PausedSet(bool paused);
    event Deprecated(address indexed successor);

    constructor(address implementation_, bytes4 initSelector_) {
        if (implementation_.code.length == 0) revert NotAContract(implementation_);
        if (initSelector_ == bytes4(0)) revert NotInitializer(initSelector_);
        implementation = implementation_;
        initSelector = initSelector_;
        deployer = msg.sender;
    }

    /// @notice Clones at `predictCreate(msg.sender)`, then bumps the caller's
    ///         nonce. Another caller's create never moves or takes it.
    function create(bytes calldata initData) external returns (address instance) {
        _requireOpen();
        instance = Clones.cloneDeterministic(implementation, _createSalt(msg.sender, createNonce[msg.sender]++));
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

    /// @notice The address the next create() by `caller` returns.
    function predictCreate(address caller) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _createSalt(caller, createNonce[caller]));
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

    /// @dev Only the pinned initializer is called, and it either initializes
    ///      the clone or reverts (bubbled here), so an instance is recorded
    ///      only once it is initialized.
    function _init(address instance, bytes calldata initData) internal {
        bytes4 selector = initData.length < 4 ? bytes4(0) : bytes4(initData[:4]);
        if (selector != initSelector) revert NotInitializer(selector);
        // slither-disable-next-line unused-return,reentrancy-benign,reentrancy-events
        Address.functionCall(instance, initData);
        isInstance[instance] = true;
        emit Created(implementation, instance, msg.sender);
    }

    function _salt(address caller, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(caller, salt));
    }

    /// @dev A longer encoding than _salt (it carries a string tag), so a
    ///      create can never collide with a createDeterministic.
    function _createSalt(address caller, uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(caller, "create", nonce));
    }
}
