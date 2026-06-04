// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";

import {PNDHookBase} from "./PNDHookBase.sol";
import {IPNDMintHook} from "../interfaces/IPNDMintHook.sol";

/// @title PNDAllowlistHook
/// @notice Gates minting to a Merkle allowlist (presale). The edition owner sets
///         a root; the minter passes a proof in `hookData`. Leaves use the
///         OpenZeppelin standard-merkle-tree format
///         (keccak256(bytes.concat(keccak256(abi.encode(account))))), so the
///         standard JS tooling produces compatible proofs.
contract PNDAllowlistHook is PNDHookBase {
    mapping(address => bytes32) public rootOf; // edition => merkle root (0 = open)

    event RootSet(address indexed edition, bytes32 root);

    function setRoot(address edition, bytes32 root) external onlyEditionOwner(edition) {
        rootOf[edition] = root;
        emit RootSet(edition, root);
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
            require(MerkleProof.verify(proof, root, leaf), "PND: not allowlisted");
        }
        return IPNDMintHook.beforeMint.selector;
    }
}
