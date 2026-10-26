// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";

import {IGate} from "./interfaces/IGate.sol";
import {ISurface} from "./interfaces/ISurface.sol";

/// @title AllowlistGate
/// @notice One ownerless singleton serving every collection: a Merkle root
///         per collection, set by that collection's owner. Leaves follow the
///         OpenZeppelin standard Merkle tree over `abi.encode(address)`.
contract AllowlistGate is IGate {
    mapping(address => bytes32) public root;

    error NotAuthorized();

    event RootSet(address indexed collection, bytes32 root);

    /// @notice Collection owner only. 0 clears the list (every check fails).
    function setRoot(address collection, bytes32 root_) external {
        if (msg.sender != ISurface(collection).owner()) revert NotAuthorized();
        root[collection] = root_;
        emit RootSet(collection, root_);
    }

    /// @notice `data` is an abi-encoded `bytes32[]` proof for `to`. Empty data
    ///         or an unset root fails rather than reverting.
    function check(address collection, address to, uint256, bytes calldata data) external view returns (bool) {
        bytes32 r = root[collection];
        if (r == bytes32(0) || data.length == 0) return false;
        bytes32[] memory proof = abi.decode(data, (bytes32[]));
        return MerkleProof.verify(proof, r, keccak256(bytes.concat(keccak256(abi.encode(to)))));
    }
}
