// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IERC165} from "openzeppelin-contracts/contracts/utils/introspection/IERC165.sol";

/// @title IMURIProtocolCreator
/// @notice Local, caller-side mirror of MURI's operator interface
///         (ygtdmn/muri-protocol). MURIProtocol calls `isTokenOwner` on a
///         contract's registered operator to gate collector actions (e.g.
///         addArtworkUris) for a token, and `registerContract` reverts with
///         InvalidInterface unless the operator reports this interface id via
///         ERC165. A single declared method, so its interfaceId is exactly
///         `isTokenOwner.selector` — identical to MURI's own definition.
interface IMURIProtocolCreator is IERC165 {
    /// @notice Whether `account` owns `tokenId` of `creatorContract`.
    function isTokenOwner(address creatorContract, address account, uint256 tokenId)
        external
        view
        returns (bool);
}
