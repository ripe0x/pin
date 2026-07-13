// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "openzeppelin-contracts/contracts/utils/introspection/IERC165.sol";

import {IMURIProtocol, IMURIProtocolCreator} from "./vendor/IMURIProtocol.sol";

/// @title MuriOperator
/// @notice The small adapter that lets a Collection (or any ERC721 with an
///         owner) plug into the MURI media-permanence protocol. MURI wants
///         each registered contract to name an operator contract that (a)
///         answers `isTokenOwner` for collector permission checks and (b) is
///         the only caller allowed to initialize a token's MURI data. This
///         is that operator: one immutable, ownerless singleton any number
///         of collections can register.
///
///         Who may do what mirrors MURI's own rule for registration: the
///         contract's admins (isAdmin, which counts the owner) or, for
///         contracts without an admin concept, the owner. Whoever could
///         register the contract with MURI can initialize its tokens here.
///         Everything else — adding fallback URIs, updating metadata,
///         collector actions — goes to MURI directly; this adapter only
///         holds the two roles MURI insists an operator holds.
contract MuriOperator is IMURIProtocolCreator, IERC165 {
    /// @notice The MURI protocol singleton this adapter forwards to.
    IMURIProtocol public immutable muri;

    error MuriRequired();
    error NotContractAdmin();

    constructor(address muri_) {
        if (muri_ == address(0) || muri_.code.length == 0) revert MuriRequired();
        muri = IMURIProtocol(muri_);
    }

    /// @dev MURI's own registration rule, mirrored: try isAdmin(account) on
    ///      the contract (Collection answers it, owner included), fall back
    ///      to owner() == account for plain Ownable contracts.
    function _isContractAdmin(address contractAddress, address account) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            contractAddress.staticcall(abi.encodeWithSignature("isAdmin(address)", account));
        if (ok && ret.length >= 32) return abi.decode(ret, (bool));
        (ok, ret) = contractAddress.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && ret.length >= 32) return abi.decode(ret, (address)) == account;
        return false;
    }

    /// @notice Initialize a token's MURI data. MURI only accepts this call
    ///         from the registered operator, so the adapter forwards it —
    ///         gated by the same keys that could have registered the
    ///         contract in the first place.
    function initializeTokenData(
        address contractAddress,
        uint256 tokenId,
        IMURIProtocol.InitConfig calldata config,
        bytes[] calldata thumbnailChunks,
        string[] calldata htmlTemplateChunks
    ) external {
        if (!_isContractAdmin(contractAddress, msg.sender)) revert NotContractAdmin();
        muri.initializeTokenData(contractAddress, tokenId, config, thumbnailChunks, htmlTemplateChunks);
    }

    /// @notice MURI's collector check: does `account` hold this token? A
    ///         nonexistent token answers false rather than reverting, so
    ///         MURI's admin-or-owner fallthrough stays intact.
    function isTokenOwner(address creatorContract, address account, uint256 tokenId)
        external
        view
        override
        returns (bool)
    {
        try IERC721(creatorContract).ownerOf(tokenId) returns (address holder) {
            return holder == account;
        } catch {
            return false;
        }
    }

    /// @notice Exactly the two interfaces this contract is: ERC-165 and
    ///         MURI's creator/operator interface (the id MURI probes at
    ///         registration).
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IMURIProtocolCreator).interfaceId;
    }
}
