// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IERC165} from "openzeppelin-contracts/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {IMURIProtocol} from "./interfaces/IMURIProtocol.sol";
import {IMURIProtocolCreator} from "./interfaces/IMURIProtocolCreator.sol";

/// @title PNDEditionsMuriOperator
/// @notice Shared, immutable, stateless operator that lets a PND edition anchor
///         its shared artwork in MURI (ygtdmn/muri-protocol) for onchain media
///         permanence, without PND ever custodying anything.
///
///         MURI keys token data by (contract, tokenId) and gates writes to the
///         contract's registered operator. PND editions share ONE artwork
///         across every token, so an edition anchors that artwork ONCE under a
///         canonical sentinel id (tokenId 0, which no edition token uses, since
///         editions mint from tokenId 1). The opt-in PNDMuriRenderer reads MURI
///         under that same id for every token while keeping the edition's live
///         Mint Marks.
///
///         Trust profile matches the shared default renderer: holds no funds
///         and no keys, has no owner, and is immutable. Anyone may register
///         their edition to it; only the edition's owner/admin may anchor.
///
///         Artist flow (all artist-signed, post-deploy):
///           1. MURI.registerContract(edition, address(this))  // owner-gated on MURI
///           2. this.anchor(edition, config)                   // owner-gated here
///           3. edition.setRenderer(pndMuriRenderer)            // owner-gated on edition
contract PNDEditionsMuriOperator is IMURIProtocolCreator {
    /// @notice The sentinel tokenId an edition's shared artwork is stored under
    ///         in MURI. Editions mint from tokenId 1, so 0 is always free.
    uint256 public constant CANONICAL_TOKEN_ID = 0;

    /// @notice The MURI protocol singleton this operator relays to.
    IMURIProtocol public immutable muri;

    error NotEditionOwner();

    event Anchored(address indexed edition, address indexed caller);

    constructor(address muriProtocol) {
        require(muriProtocol.code.length > 0, "muri has no code");
        muri = IMURIProtocol(muriProtocol);
    }

    /// @notice Anchor (or re-anchor) an edition's shared artwork in MURI under
    ///         the canonical id. The edition must already be registered to this
    ///         operator (the owner calls MURI.registerContract(edition, this)
    ///         first; that call is owner-gated on MURI). Otherwise MURI reverts
    ///         with ContractNotRegistered / UnauthorizedOperator.
    /// @param edition The PNDEditions contract whose shared artwork to anchor.
    /// @param config  The MURI InitConfig (fallback artwork URIs + SHA-256 hash
    ///                + permissions + display mode). v1 is fully off-chain: no
    ///                thumbnail chunks and no custom HTML template (MURI's
    ///                default onchain viewer is used).
    function anchor(address edition, IMURIProtocol.InitConfig calldata config) external {
        if (!_isOwnerOrAdmin(edition, msg.sender)) revert NotEditionOwner();
        bytes[] memory noThumbnailChunks = new bytes[](0);
        string[] memory noTemplateChunks = new string[](0);
        muri.initializeTokenData(
            edition, CANONICAL_TOKEN_ID, config, noThumbnailChunks, noTemplateChunks
        );
        emit Anchored(edition, msg.sender);
    }

    /// @inheritdoc IMURIProtocolCreator
    /// @notice MURI calls this to gate collector actions on a token. For the
    ///         canonical (shared-artwork) id, "owns the token" means "holds any
    ///         token in the edition" (balanceOf > 0), so any collector can help
    ///         preserve the shared work, the collaborative-fallback spirit of
    ///         MURI. For any other id it is strict ERC721 ownerOf, so a future
    ///         per-token anchor would stay scoped to that token's owner.
    function isTokenOwner(address creatorContract, address account, uint256 tokenId)
        external
        view
        override
        returns (bool)
    {
        if (account == address(0)) return false;
        if (tokenId == CANONICAL_TOKEN_ID) {
            (bool ok, bytes memory ret) =
                creatorContract.staticcall(abi.encodeWithSelector(IERC721.balanceOf.selector, account));
            return ok && ret.length >= 32 && abi.decode(ret, (uint256)) > 0;
        }
        (bool ok2, bytes memory ret2) =
            creatorContract.staticcall(abi.encodeWithSelector(IERC721.ownerOf.selector, tokenId));
        return ok2 && ret2.length >= 32 && abi.decode(ret2, (address)) == account;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IMURIProtocolCreator).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    /// @dev Mirrors MURI's owner/admin resolution: Manifold isAdmin(account) OR
    ///      Ownable.owner() == account. PND editions are Ownable, so owner()
    ///      qualifies; the isAdmin probe just keeps parity with MURI's gate.
    function _isOwnerOrAdmin(address target, address account) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            target.staticcall(abi.encodeWithSignature("isAdmin(address)", account));
        if (ok && ret.length >= 32 && abi.decode(ret, (bool))) return true;
        (ok, ret) = target.staticcall(abi.encodeWithSignature("owner()"));
        return ok && ret.length >= 32 && abi.decode(ret, (address)) == account;
    }
}
