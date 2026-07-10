// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";

import {HookBase} from "./HookBase.sol";
import {IMintHook} from "../interfaces/IMintHook.sol";
import {ICollectionView} from "../interfaces/IRenderer.sol";

/// @title GateHook
/// @notice Merkle allowlist + per-wallet cap in ONE hook. The core has a
///         single mintHook slot, and a real gated drop wants both at once —
///         an allowlist without a per-wallet cap invites a listed wallet to
///         sweep the supply. Each gate is independently optional per
///         collection: root 0 = no allowlist, cap 0 = no cap, so this hook
///         also serves the single-gate cases (the single-purpose
///         AllowlistHook/PerWalletCapHook remain as minimal references).
///
///         Semantics match the single-purpose hooks exactly: same OZ
///         standard-merkle-tree leaf format, same hookData shape
///         (abi.encode(bytes32[] proof) — which only travels through
///         mintWithReferral; plain mint() has no hookData, so an
///         allowlist-gated mint MUST go through mintWithReferral), same
///         error strings so UIs map one set of messages.
///
///         Config authority is the collection's owner OR admins (the
///         current protocol authority model, same borrow as the
///         renderer-land registries) — a drop is operated by the artist's
///         team, not only the owner key.
///
///         Gas: the wallet counter is written only while a cap is active.
///         Enabling a cap mid-sale therefore counts from that moment —
///         earlier uncapped mints are not retroactively charged against it.
///         (Deliberate: uncapped collections shouldn't pay a counting
///         SSTORE per mint. Set the cap before opening if it must bind the
///         whole sale.)
contract GateHook is HookBase {
    mapping(address => bytes32) public rootOf; // collection => merkle root (0 = open)
    mapping(address => uint256) public capOf; // collection => per-wallet cap (0 = unlimited)
    mapping(address => mapping(address => uint256)) public mintedBy; // collection => wallet => count while capped

    event RootSet(address indexed collection, bytes32 root);
    event CapSet(address indexed collection, uint256 cap);

    /// @dev Owner or explicit admin of the collection being configured.
    modifier onlyCollectionAdmin(address collection) {
        ICollectionView c = ICollectionView(collection);
        require(
            msg.sender == c.owner() || c.isAdmin(msg.sender), "SC: not collection owner/admin"
        );
        _;
    }

    function setRoot(address collection, bytes32 root) external onlyCollectionAdmin(collection) {
        rootOf[collection] = root;
        emit RootSet(collection, root);
    }

    function setCap(address collection, uint256 cap) external onlyCollectionAdmin(collection) {
        capOf[collection] = cap;
        emit CapSet(collection, cap);
    }

    /// @notice How many more tokens `wallet` may mint from `collection`
    ///         under the current cap. type(uint256).max when uncapped.
    ///         Saturates at 0 if a cap was lowered below what a wallet
    ///         already minted.
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
            require(MerkleProof.verify(proof, root, leaf), "SC: not allowlisted");
        }
        uint256 cap = capOf[msg.sender];
        if (cap != 0) {
            require(mintedBy[msg.sender][minter] + quantity <= cap, "SC: wallet cap");
        }
        return IMintHook.beforeMint.selector;
    }

    /// @dev Count only after the mint succeeds (afterMint runs post-payment),
    ///      and only while a cap is active (see the gas note above).
    function afterMint(address minter, uint256 quantity, uint256, address, bytes calldata)
        external
        override
    {
        if (capOf[msg.sender] != 0) {
            mintedBy[msg.sender][minter] += quantity;
        }
    }
}
