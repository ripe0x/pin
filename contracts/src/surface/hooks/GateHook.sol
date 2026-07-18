// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";

import {HookBase} from "./HookBase.sol";
import {IMintHook} from "../interfaces/IMintHook.sol";

/// @title GateHook
/// @notice Merkle allowlist and per-wallet cap combined in one hook. The core
///         has a single mintHook slot, so combining both gates lets a gated
///         drop enforce an allowlist and a per-wallet cap at once (an allowlist
///         without a cap lets a listed wallet buy the entire supply). Each gate
///         is independently optional per collection: root 0 = no allowlist,
///         cap 0 = no cap, so this hook also covers the single-gate cases (the
///         single-purpose AllowlistHook/PerWalletCapHook remain as minimal
///         references).
///
///         Semantics match the single-purpose hooks: same OZ
///         standard-merkle-tree leaf format, same hookData shape
///         (abi.encode(bytes32[] proof)), and the same custom errors.
///         `NotAllowlisted()` / `WalletCapExceeded(cap, attempted)` share
///         signatures (and therefore selectors) with AllowlistHook and
///         PerWalletCapHook, so a UI can map one set of errors for all three.
///         hookData travels through `mintWithReferral` / `mintFor` and the
///         extension `mintTo`/`mintToId` paths; plain `mint()` sends none, so
///         an allowlist-gated public mint must go through `mintWithReferral`.
///
///         Config authority is the collection's owner or admins (via
///         HookBase.onlySurfaceAdmin, the same authority root as the
///         collection's own setters).
///
///         Gas: the wallet counter is written only while a cap is active.
///         Enabling a cap mid-sale counts from that point; earlier uncapped
///         mints are not retroactively counted. This avoids a counting SSTORE
///         per mint on uncapped collections. Set the cap before opening if it
///         must bind the whole sale.
contract GateHook is HookBase {
    mapping(address => bytes32) public rootOf; // collection => merkle root (0 = open)
    mapping(address => uint256) public capOf; // collection => per-wallet cap (0 = unlimited)
    mapping(address => mapping(address => uint256)) public mintedBy; // collection => wallet => count while capped

    /// @dev Selector-identical to AllowlistHook.NotAllowlisted.
    error NotAllowlisted();
    /// @dev Selector-identical to PerWalletCapHook.WalletCapExceeded.
    error WalletCapExceeded(uint256 cap, uint256 attempted);

    event RootSet(address indexed collection, bytes32 root);
    event CapSet(address indexed collection, uint256 cap);

    function setRoot(address collection, bytes32 root) external onlySurfaceAdmin(collection) {
        rootOf[collection] = root;
        emit RootSet(collection, root);
    }

    function setCap(address collection, uint256 cap) external onlySurfaceAdmin(collection) {
        capOf[collection] = cap;
        emit CapSet(collection, cap);
    }

    /// @notice Tokens `wallet` may still mint from `collection` under the
    ///         current cap. type(uint256).max when uncapped. Returns 0 if the
    ///         cap was lowered below the wallet's existing count.
    function remainingFor(address collection, address wallet) external view returns (uint256) {
        uint256 cap = capOf[collection];
        if (cap == 0) return type(uint256).max;
        uint256 used = mintedBy[collection][wallet];
        return used >= cap ? 0 : cap - used;
    }

    function beforeMint(address minter, uint256 quantity, uint256, address, bytes calldata hookData)
        external
        view
        override
        returns (bytes4)
    {
        bytes32 root = rootOf[msg.sender];
        if (root != bytes32(0)) {
            bytes32[] memory proof = abi.decode(hookData, (bytes32[]));
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(minter))));
            if (!MerkleProof.verify(proof, root, leaf)) revert NotAllowlisted();
        }
        uint256 cap = capOf[msg.sender];
        if (cap != 0) {
            uint256 attempted = mintedBy[msg.sender][minter] + quantity;
            if (attempted > cap) revert WalletCapExceeded(cap, attempted);
        }
        return IMintHook.beforeMint.selector;
    }

    /// @dev Counts only after the mint succeeds (afterMint runs post-payment),
    ///      and only while a cap is active (see the gas note above).
    function afterMint(address minter, uint256 quantity, uint256, address, bytes calldata) external override {
        if (capOf[msg.sender] != 0) {
            mintedBy[msg.sender][minter] += quantity;
        }
    }
}
