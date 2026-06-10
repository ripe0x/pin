// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IReleaseRenderer
/// @notice The entire rendering "framework": one function. A release whose
///         artist sets a renderer delegates tokenURI to it; the protocol
///         neither knows nor cares what is behind the pointer (generative,
///         onchain, oracle-driven — anything). v1 ships no implementations.
///         The slot exists only because immutable contracts cannot grow one
///         later.
interface IReleaseRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);
}
