// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";

import {HookBase} from "./HookBase.sol";
import {IMintHook} from "../interfaces/IMintHook.sol";

/// @title AllowlistHook
/// @notice Gates minting to a Merkle allowlist (presale). The collection owner sets
///         a root; the minter passes a proof in `hookData`. Leaves use the
///         OpenZeppelin standard-merkle-tree format
///         (keccak256(bytes.concat(keccak256(abi.encode(account))))), so the
///         standard JS tooling produces compatible proofs.
contract AllowlistHook is HookBase {
    mapping(address => bytes32) public rootOf; // collection => merkle root (0 = open)

    event RootSet(address indexed collection, bytes32 root);

    function setRoot(address collection, bytes32 root) external onlyCollectionOwner(collection) {
        rootOf[collection] = root;
        emit RootSet(collection, root);
    }

    function beforeMint(address minter, uint256, uint256, address, bytes calldata hookData)
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
        return IMintHook.beforeMint.selector;
    }
}
