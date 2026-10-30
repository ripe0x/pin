// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {
    ReentrancyGuardUpgradeable
} from "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {IERC721Receiver} from "openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC165} from "openzeppelin-contracts/contracts/utils/introspection/IERC165.sol";

import {IMinter} from "./interfaces/IMinter.sol";
import {IGate} from "./interfaces/IGate.sol";
import {ISurface} from "./interfaces/ISurface.sol";

/// @title FixedPriceSale
/// @notice The sale primitive: one EIP-1167 clone per sale, bound to one
///         collection at initialize. Holds this sale's rules and money and
///         nothing about the artifact. Every mint pays exactly
///         `price * quantity`; proceeds accrue as pull balances. Config
///         authority is borrowed from the collection's owner, so a renounced
///         collection freezes its sale while payouts keep flowing.
contract FixedPriceSale is Initializable, ReentrancyGuardUpgradeable, IMinter, IERC165 {
    /// @notice Implementation lineage marker.
    uint256 public constant version = 2;

    /// @notice The referral share, 5%. No setter, no init param.
    uint16 public constant REFERRAL_SHARE_BPS = 500;
    uint16 internal constant BPS = 10_000;

    address public collection;
    uint256 public price;
    uint64 public mintStart; // 0 = open now
    uint64 public mintEnd; // 0 = open ended
    uint256 public maxMints; // 0 = unlimited
    uint256 public walletCap; // 0 = unlimited
    address public payoutRecipient; // never zero
    address public gate; // 0 = none
    /// @notice The referrer `mint(quantity)` pays. Copied at initialize
    ///         (the launcher passes PND's address); no setter.
    address public defaultReferrer;
    bool public closed;

    uint256 public totalMinted;
    /// @notice Tokens minted to each recipient through this sale. Counted on
    ///         every mint, capped or not, so a cap set later bounds the true
    ///         total.
    mapping(address => uint256) public mintedBy;

    mapping(address => uint256) internal _pending;

    error CollectionRequired();
    error NotAContract(address account);
    error BadMintWindow();
    error PayoutRecipientRequired();
    error NotAuthorized();
    error ZeroAccount();
    error NothingToWithdraw();
    error WithdrawFailed();

    event PriceSet(uint256 price);
    event MintWindowSet(uint64 mintStart, uint64 mintEnd);
    event MaxMintsSet(uint256 maxMints);
    event WalletCapSet(uint256 walletCap);
    event PayoutRecipientSet(address indexed payoutRecipient);
    event GateSet(address indexed gate);
    event Closed();
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    constructor() {
        _disableInitializers();
    }

    /// @dev Authority: the collection already names this clone as its
    ///      minter (the launcher's path: the token granted it first), or the
    ///      caller is the collection's owner.
    function initialize(
        address collection_,
        uint256 price_,
        uint64 mintStart_,
        uint64 mintEnd_,
        uint256 maxMints_,
        uint256 walletCap_,
        address payoutRecipient_,
        address gate_,
        address defaultReferrer_
    ) external initializer {
        if (collection_ == address(0)) revert CollectionRequired();
        if (collection_.code.length == 0) revert NotAContract(collection_);
        if (ISurface(collection_).minter() != address(this) && msg.sender != ISurface(collection_).owner()) {
            revert NotAuthorized();
        }
        __ReentrancyGuard_init();
        collection = collection_;
        defaultReferrer = defaultReferrer_;
        // Every config value is logged at init through the same events its
        // setter emits, so an indexer learns the sale's state from logs.
        price = price_;
        emit PriceSet(price_);
        _setMintWindow(mintStart_, mintEnd_);
        maxMints = maxMints_;
        emit MaxMintsSet(maxMints_);
        walletCap = walletCap_;
        emit WalletCapSet(walletCap_);
        _setPayoutRecipient(payoutRecipient_);
        _setGate(gate_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IMinter
    function mint(uint256 quantity) external payable override nonReentrant {
        _mint(msg.sender, quantity, defaultReferrer, "");
    }

    /// @inheritdoc IMinter
    function mintWithReferral(address to, uint256 quantity, address referrer, bytes calldata data)
        external
        payable
        override
        nonReentrant
    {
        _mint(to, quantity, referrer, data);
    }

    /// @dev The ten checks of the spec (3.2), in order. Quantity 0 is
    ///      rejected by the collection at step 8. Steps 7 and 8 call out
    ///      before the step 9 writes; both entrypoints are nonReentrant, the
    ///      collection accepts mints only from this sale, and no other
    ///      function reads totalMinted or mintedBy mid-mint.
    // slither-disable-next-line reentrancy-no-eth,reentrancy-benign
    function _mint(address to, uint256 quantity, address referrer, bytes memory data) internal {
        if (closed) revert SaleClosed(); // 1
        if (mintStart != 0 && block.timestamp < mintStart) revert MintNotStarted(); // 2
        if (mintEnd != 0 && block.timestamp >= mintEnd) revert MintEnded();
        uint256 minted = totalMinted;
        if (maxMints != 0 && minted + quantity > maxMints) revert MaxMintsExceeded(maxMints, minted + quantity); // 3
        address collection_ = collection;
        // Neither this sale nor the collection can ever withdraw a balance,
        // so naming either as referrer counts as no referrer.
        if (referrer == address(this) || referrer == collection_) referrer = address(0);
        if (gate != address(0) && !IGate(gate).check(collection_, to, quantity, data)) revert GateRejected(); // 4
        uint256 mintedByTo = mintedBy[to];
        if (walletCap != 0 && mintedByTo + quantity > walletCap) {
            revert WalletCapExceeded(walletCap, mintedByTo + quantity); // 5
        }
        uint256 paid = price * quantity;
        if (msg.value != paid) revert WrongPayment(paid, msg.value); // 6
        if (to.code.length != 0) _checkReceiver(collection_, to, quantity); // 7
        uint256 firstTokenId = ISurface(collection_).mintTo(to, quantity); // 8
        totalMinted = minted + quantity; // 9
        mintedBy[to] = mintedByTo + quantity;
        // 10: settle as pull balances. No external call here, so a reverting
        //     recipient can never block a mint.
        if (paid != 0) {
            uint256 referral = referrer == address(0) ? 0 : (paid * REFERRAL_SHARE_BPS) / BPS;
            if (referral != 0) {
                _pending[referrer] += referral;
                emit ReferralPaid(referrer, referral);
            }
            _pending[payoutRecipient] += paid - referral;
        }
        emit Sold(msg.sender, to, referrer, quantity, paid, firstTokenId);
    }

    /// @dev The receiver check the token deliberately skips (it never calls
    ///      out). Asked once for every id this call will mint, before any
    ///      of them exists.
    function _checkReceiver(address collection_, address to, uint256 quantity) internal {
        // slither-disable-next-line unused-return
        (,,,,, uint256 mintedEver) = ISurface(collection_).config();
        for (uint256 i = 1; i <= quantity; i++) {
            try IERC721Receiver(to).onERC721Received(msg.sender, address(0), mintedEver + i, "") returns (bytes4 ret) {
                if (ret != IERC721Receiver.onERC721Received.selector) revert ReceiverRejected(to);
            } catch {
                revert ReceiverRejected(to);
            }
        }
    }

    /// @inheritdoc IMinter
    function priceOf(address, uint256 quantity) external view override returns (uint256) {
        return price * quantity;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pull payments
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Send `account` its owed balance. Callable by anyone; funds go
    ///         only to the owed address.
    function withdraw(address account) external nonReentrant {
        _withdraw(account, account);
    }

    /// @notice Send the caller's own owed balance to `to`.
    function withdrawTo(address to) external nonReentrant {
        _withdraw(msg.sender, to);
    }

    function pendingWithdrawal(address account) external view returns (uint256) {
        return _pending[account];
    }

    function _withdraw(address account, address to) internal {
        if (to == address(0)) revert ZeroAccount();
        uint256 amount = _pending[account];
        if (amount == 0) revert NothingToWithdraw();
        _pending[account] = 0;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(account, to, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config (borrowed authority: the collection's owner)
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyCollectionOwner() {
        if (msg.sender != ISurface(collection).owner()) revert NotAuthorized();
        _;
    }

    function setPrice(uint256 price_) external onlyCollectionOwner {
        price = price_;
        emit PriceSet(price_);
    }

    function setMintWindow(uint64 start, uint64 end) external onlyCollectionOwner {
        _setMintWindow(start, end);
    }

    function setMaxMints(uint256 maxMints_) external onlyCollectionOwner {
        maxMints = maxMints_;
        emit MaxMintsSet(maxMints_);
    }

    function setWalletCap(uint256 walletCap_) external onlyCollectionOwner {
        walletCap = walletCap_;
        emit WalletCapSet(walletCap_);
    }

    /// @notice Balances already accrued stay with the old recipient.
    function setPayoutRecipient(address payoutRecipient_) external onlyCollectionOwner {
        _setPayoutRecipient(payoutRecipient_);
    }

    /// @notice 0 = no gate.
    function setGate(address gate_) external onlyCollectionOwner {
        _setGate(gate_);
    }

    /// @notice One-way. A new sale needs a new clone and `setMinter`.
    function close() external onlyCollectionOwner {
        closed = true;
        emit Closed();
    }

    function _setMintWindow(uint64 start, uint64 end) internal {
        if (end != 0 && end <= start) revert BadMintWindow();
        mintStart = start;
        mintEnd = end;
        emit MintWindowSet(start, end);
    }

    function _setPayoutRecipient(address payoutRecipient_) internal {
        if (payoutRecipient_ == address(0)) revert PayoutRecipientRequired();
        payoutRecipient = payoutRecipient_;
        emit PayoutRecipientSet(payoutRecipient_);
    }

    function _setGate(address gate_) internal {
        if (gate_ != address(0) && gate_.code.length == 0) revert NotAContract(gate_);
        gate = gate_;
        emit GateSet(gate_);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IMinter).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
