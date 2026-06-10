// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC721A} from "erc721a/contracts/ERC721A.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {
    GateMode,
    IERC721Burn,
    IRelease,
    ReleaseParams,
    ReleaseStatus,
    ReleaseSummary
} from "./IRelease.sol";
import {IReleaseRenderer} from "./IReleaseRenderer.sol";

/// @title Release
/// @notice One release: a complete, self-contained ERC721A contract owned by
///         its artist from construction. The terms of a release — price,
///         window, supply cap, gate, surface fee — are Solidity immutables,
///         compiled into this contract's own bytecode and fixed forever the
///         moment it deploys. There is no admin but the artist, no upgrade
///         path for anyone, and no dependency on any other account's code.
///
///         The protocol in three sentences, which every function here must
///         survive contact with:
///           1. Free means gas only.
///           2. The artist gets everything they priced.
///           3. The surface earns only when chosen.
///
///         Money: a mint makes zero external calls. It does accounting only
///         (artistBalance, owed[surface]) and both legs are pulled later —
///         withdraw() to the artist's payout, claimSurfaceFees() to each
///         surface. A reverting recipient can never brick a live window.
///
///         Continuation: a release may name one gate (any ERC721) at
///         creation. HOLD lets each gate token claim exactly one mint; BURN
///         consumes the gate token. The participation record is events
///         (Claimed), never token state — nothing about the gate's tokens
///         mutates except a BURN's own burn.
contract Release is ERC721A, Ownable2Step, IRelease {
    /// @notice Fat-finger guard on the artist-set ERC-2981 royalty (50%).
    ///         2981 is advisory signaling; the cap is not an opinion.
    uint96 public constant MAX_ROYALTY_BPS = 5_000;

    // ── Immutable terms ──────────────────────────────────────────────────

    /// @notice Permanent attribution: whoever created the release. The
    ///         transferable owner handles operations; this never changes.
    address public immutable artist;

    /// @notice Price per token in wei. 0 means free, and free means gas
    ///         only — see surfaceFee.
    uint256 public immutable price;

    /// @notice Per-token fee owed to the surface that serves a mint,
    ///         snapshotted from the factory at creation. Immutably 0 when
    ///         price is 0: a free release cannot charge a fee, on any
    ///         surface, ever.
    uint256 public immutable surfaceFee;

    /// @notice Mint opens at startTime (inclusive)…
    uint64 public immutable startTime;

    /// @notice …and closes at endTime (exclusive). 0 = open-ended (runs
    ///         until close()). Windows can never be extended: everyone who
    ///         mints does so against a public closing time, and lengthening
    ///         it retroactively dilutes them with no exit. Closing early
    ///         only makes the edition scarcer than promised — that
    ///         asymmetry is the fairness.
    uint64 public immutable endTime;

    /// @notice Hard cap on tokens ever minted (burns do not reopen it).
    ///         0 = uncapped: supply is decided by who shows up during the
    ///         window.
    uint64 public immutable maxSupply;

    /// @notice The ERC721 this release gates on (address(0) iff ungated).
    ///         A release trusts the gate it names: a malicious gate can
    ///         corrupt its own gating, never this contract's funds.
    address public immutable gateToken;

    /// @notice NONE, HOLD, or BURN. Fixed at creation like every term.
    GateMode public immutable gateMode;

    // ── State ────────────────────────────────────────────────────────────

    /// @notice One-way switch: the artist ended minting forever.
    bool public closed;

    /// @notice Where withdraw() sends artist proceeds. Artist-mutable
    ///         (wallet rotation, split contracts) — the one money knob,
    ///         and it only ever points money the artist already owns.
    address public payout;

    /// @notice Accrued artist proceeds (pull).
    uint256 public artistBalance;

    /// @notice Accrued fees per surface (pull).
    mapping(address => uint256) public owed;

    /// @notice HOLD gate: which gate token ids have spent their claim.
    mapping(uint256 => bool) public gateUsed;

    /// @notice Token metadata URI; uriPerToken appends the token id.
    string public uri;
    bool public uriPerToken;

    /// @notice Optional IReleaseRenderer; overrides uri when set.
    address public renderer;

    /// @notice One-way switch: tokenURI inputs are fixed forever. Frozen
    ///         means the *pointer* is frozen — a renderer that is itself
    ///         mutable is the artist's published choice, visible onchain.
    bool public metadataFrozen;

    /// @notice ERC-7572 collection-level metadata URI.
    string public contractURI;

    address public royaltyReceiver;
    uint96 public royaltyBps;

    /// @param artist_     The creator; becomes owner and permanent artist.
    /// @param surfaceFee_ The factory's current per-token fee, snapshotted
    ///                    here forever (zeroed when the release is free).
    /// @param p           The artist's terms. Validated here, not in the
    ///                    factory, so a release defends itself regardless
    ///                    of how it was deployed.
    constructor(address artist_, uint256 surfaceFee_, ReleaseParams memory p)
        ERC721A(p.name, p.symbol)
        Ownable(artist_)
    {
        require(
            p.endTime == 0 ||
                (p.endTime > p.startTime && p.endTime > block.timestamp),
            "end not after start/now"
        );
        if (p.gateMode == GateMode.NONE) {
            require(p.gateToken == address(0), "gate token without mode");
        } else {
            require(p.gateToken.code.length > 0, "gate token has no code");
        }
        require(p.royaltyBps <= MAX_ROYALTY_BPS, "royalty above cap");
        if (p.renderer != address(0)) {
            require(p.renderer.code.length > 0, "renderer has no code");
        }

        artist = artist_;
        price = p.price;
        // Free means free, baked into bytecode: a zero-price release
        // snapshots a zero fee, so no surface can ever be owed anything.
        surfaceFee = p.price == 0 ? 0 : surfaceFee_;
        startTime = p.startTime;
        endTime = p.endTime;
        maxSupply = p.maxSupply;
        gateToken = p.gateToken;
        gateMode = p.gateMode;

        payout = p.payout == address(0) ? artist_ : p.payout;
        if (p.royaltyBps > 0) {
            royaltyReceiver = p.royaltyReceiver == address(0)
                ? payout
                : p.royaltyReceiver;
            royaltyBps = p.royaltyBps;
        }
        uri = p.uri;
        uriPerToken = p.uriPerToken;
        renderer = p.renderer;
        contractURI = p.contractURI;
    }

    // ── Minting ──────────────────────────────────────────────────────────

    /// @inheritdoc IRelease
    function mint(address to, uint256 quantity, address surface)
        external
        payable
        returns (uint256 firstTokenId)
    {
        require(gateMode == GateMode.NONE, "release is gated");
        firstTokenId = _mintPaid(to, quantity, surface);
    }

    /// @inheritdoc IRelease
    function mintGated(
        address to,
        uint256[] calldata sourceTokenIds,
        address surface
    ) external payable returns (uint256 firstTokenId) {
        GateMode mode = gateMode;
        require(mode != GateMode.NONE, "release is not gated");
        uint256 quantity = sourceTokenIds.length;
        require(quantity != 0, "no source tokens");

        // Checks: the caller must own every source token (owner, not
        // merely approved — approval moves tokens, it doesn't spend their
        // rights). ownerOf is a view call (STATICCALL); the gate cannot
        // reenter from here. HOLD marks each id spent — once per id, ever.
        address gate = gateToken;
        for (uint256 i = 0; i < quantity; i++) {
            uint256 sourceId = sourceTokenIds[i];
            require(
                IERC721(gate).ownerOf(sourceId) == msg.sender,
                "not source owner"
            );
            if (mode == GateMode.HOLD) {
                require(!gateUsed[sourceId], "source already used");
                gateUsed[sourceId] = true;
            }
        }

        // Effects: payment accounting + our own mint, all internal.
        firstTokenId = _mintPaid(to, quantity, surface);

        // Interactions: burns run after every effect is final. The caller
        // must have approved this release on the gate contract. A
        // duplicated source id passes the ownerOf checks but reverts here
        // on its second burn, reverting the whole claim.
        if (mode == GateMode.BURN) {
            for (uint256 i = 0; i < quantity; i++) {
                IERC721Burn(gate).burn(sourceTokenIds[i]);
            }
        }

        for (uint256 i = 0; i < quantity; i++) {
            emit Claimed(sourceTokenIds[i], firstTokenId + i);
        }
    }

    /// @dev The one mint path. Window + supply checks, exact payment,
    ///      accounting, ERC721A batch mint. Zero external calls — the
    ///      reentrancy surface of a mint is nothing, by construction.
    function _mintPaid(address to, uint256 quantity, address surface)
        internal
        returns (uint256 firstTokenId)
    {
        require(!closed, "release closed");
        require(block.timestamp >= startTime, "release not started");
        require(
            endTime == 0 || block.timestamp < endTime,
            "release ended"
        );
        if (maxSupply != 0) {
            require(
                _totalMinted() + quantity <= maxSupply,
                "exceeds max supply"
            );
        }

        uint256 pricePaid = price * quantity;
        uint256 feePaid = _surfaceFeeFor(surface, quantity);
        require(msg.value == pricePaid + feePaid, "wrong payment");

        if (pricePaid != 0) artistBalance += pricePaid;
        if (feePaid != 0) owed[surface] += feePaid;

        firstTokenId = _nextTokenId();
        _mint(to, quantity);
        emit Minted(to, surface, firstTokenId, quantity, pricePaid, feePaid);
    }

    /// @dev Free means free: a zero-price release never charges a fee
    ///      (also enforced by the constructor zeroing surfaceFee). A mint
    ///      that names no surface was served by no one and owes no fee.
    function _surfaceFeeFor(address surface, uint256 quantity)
        internal
        view
        returns (uint256)
    {
        if (price == 0 || surface == address(0)) return 0;
        return surfaceFee * quantity;
    }

    /// @inheritdoc IRelease
    function burn(uint256 tokenId) external {
        _burn(tokenId, true);
    }

    // ── Funds ────────────────────────────────────────────────────────────

    /// @inheritdoc IRelease
    function withdraw() external {
        uint256 amount = artistBalance;
        require(amount != 0, "nothing to withdraw");
        artistBalance = 0;
        address to = payout;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw failed");
        emit ArtistWithdrawn(to, amount);
    }

    /// @inheritdoc IRelease
    function claimSurfaceFees(address surface) external {
        uint256 amount = owed[surface];
        require(amount != 0, "nothing owed");
        owed[surface] = 0;
        (bool ok, ) = surface.call{value: amount}("");
        require(ok, "claim failed");
        emit SurfaceFeesClaimed(surface, amount);
    }

    // ── Owner ────────────────────────────────────────────────────────────

    /// @inheritdoc IRelease
    function close() external onlyOwner {
        require(!closed, "already closed");
        closed = true;
        emit Closed();
    }

    /// @inheritdoc IRelease
    function setPayout(address payout_) external onlyOwner {
        require(payout_ != address(0), "payout required");
        payout = payout_;
        emit PayoutSet(payout_);
    }

    /// @inheritdoc IRelease
    function setMetadata(
        string calldata uri_,
        bool uriPerToken_,
        address renderer_
    ) external onlyOwner {
        require(!metadataFrozen, "metadata frozen");
        if (renderer_ != address(0)) {
            require(renderer_.code.length > 0, "renderer has no code");
        }
        uri = uri_;
        uriPerToken = uriPerToken_;
        renderer = renderer_;
        emit MetadataSet(uri_, uriPerToken_, renderer_);
        emit BatchMetadataUpdate(_startTokenId(), type(uint256).max);
    }

    /// @inheritdoc IRelease
    function setContractURI(string calldata contractURI_) external onlyOwner {
        require(!metadataFrozen, "metadata frozen");
        contractURI = contractURI_;
        emit ContractURIUpdated();
    }

    /// @inheritdoc IRelease
    function freezeMetadata() external onlyOwner {
        require(!metadataFrozen, "metadata frozen");
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    /// @inheritdoc IRelease
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        require(bps <= MAX_ROYALTY_BPS, "royalty above cap");
        require(bps == 0 || receiver != address(0), "receiver required");
        royaltyReceiver = receiver;
        royaltyBps = bps;
        emit RoyaltySet(receiver, bps);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @inheritdoc IRelease
    function status() public view returns (ReleaseStatus) {
        if (closed) return ReleaseStatus.Closed;
        if (maxSupply != 0 && _totalMinted() >= maxSupply) {
            return ReleaseStatus.SoldOut;
        }
        if (block.timestamp < startTime) return ReleaseStatus.Scheduled;
        if (endTime != 0 && block.timestamp >= endTime) {
            return ReleaseStatus.Ended;
        }
        return ReleaseStatus.Live;
    }

    /// @inheritdoc IRelease
    function summary() external view returns (ReleaseSummary memory) {
        return ReleaseSummary({
            name: name(),
            symbol: symbol(),
            artist: artist,
            payout: payout,
            price: price,
            surfaceFee: surfaceFee,
            startTime: startTime,
            endTime: endTime,
            maxSupply: maxSupply,
            gateToken: gateToken,
            gateMode: gateMode,
            status: status(),
            totalMinted: _totalMinted(),
            totalSupply: totalSupply(),
            closed: closed,
            metadataFrozen: metadataFrozen,
            uri: uri,
            uriPerToken: uriPerToken,
            renderer: renderer,
            royaltyReceiver: royaltyReceiver,
            royaltyBps: royaltyBps
        });
    }

    /// @notice Tokens ever minted (burns do not decrease this; the supply
    ///         cap is on minted, not on outstanding).
    function totalMinted() external view returns (uint256) {
        return _totalMinted();
    }

    /// @notice ERC-2981.
    function royaltyInfo(uint256, uint256 salePrice)
        external
        view
        returns (address, uint256)
    {
        if (royaltyReceiver == address(0)) return (address(0), 0);
        return (royaltyReceiver, (salePrice * royaltyBps) / 10_000);
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override
        returns (string memory)
    {
        if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
        if (renderer != address(0)) {
            return IReleaseRenderer(renderer).tokenURI(tokenId);
        }
        if (uriPerToken) return string.concat(uri, _toString(tokenId));
        return uri;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return
            interfaceId == 0x2a55205a || // ERC-2981
            interfaceId == 0x49064906 || // ERC-4906
            super.supportsInterface(interfaceId);
    }

    /// @dev Token ids start at 1.
    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }
}
