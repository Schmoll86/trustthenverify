// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IEscrowFactory {
    function authorizedGateway() external view returns (address);
    function treasury() external view returns (address);
}

/// @title EscrowInstance — individual escrow contract for a single transaction.
/// @notice Per SPEC-v2 §8.1. Deployed via EscrowFactory CREATE2.
///
/// States: Created → BuyerFunded → Active (both funded) → Delivered → Released/Failed
///         Active/Delivered → Burned (dispute)
///         Created/BuyerFunded/Active → Expired (timeout)
///
/// Fund distribution:
///   Released → seller gets buyer amount + own collateral returned
///   Failed/Expired → buyer refunded, seller collateral sent to treasury
///   Burned → both buyer amount + seller collateral sent to treasury
contract EscrowInstance {
    using SafeERC20 for IERC20;

    enum State {
        Created,      // 0 — deployed, awaiting funding
        BuyerFunded,  // 1 — buyer deposited, awaiting seller
        Active,       // 2 — both funded, work in progress
        Delivered,    // 3 — seller submitted deliverable
        Released,     // 4 — funds released to seller (terminal)
        Failed,       // 5 — verification failed (terminal)
        Burned,       // 6 — dispute burn (terminal)
        Expired       // 7 — timeout (terminal)
    }

    IERC20 public immutable usdc;
    IEscrowFactory public immutable factory;
    address public immutable buyer;
    address public immutable seller;
    uint256 public immutable amount;
    uint256 public immutable collateral;
    uint256 public deadline;

    State public state;
    bytes32 public resultHash;

    event Funded(address indexed party, uint256 value);
    event Activated(uint256 deadline);
    event DeliverableSubmitted(bytes32 resultHash);
    event Released(address indexed seller, uint256 total);
    event Failed(address indexed buyer, uint256 refund);
    event Burned(address indexed treasury, uint256 total);
    event Expired(address indexed buyer, uint256 refund);
    event Disputed(address indexed initiator, bytes32 reasonHash);

    modifier onlyBuyer() {
        require(msg.sender == buyer, "EscrowInstance: not buyer");
        _;
    }

    modifier onlySeller() {
        require(msg.sender == seller, "EscrowInstance: not seller");
        _;
    }

    modifier onlyParty() {
        require(msg.sender == buyer || msg.sender == seller, "EscrowInstance: not party");
        _;
    }

    constructor(
        address _usdc,
        address _factory,
        address _buyer,
        address _seller,
        uint256 _amount,
        uint256 _collateral,
        uint256 _deadline
    ) {
        usdc = IERC20(_usdc);
        factory = IEscrowFactory(_factory);
        buyer = _buyer;
        seller = _seller;
        amount = _amount;
        collateral = _collateral;
        deadline = _deadline;
        state = State.Created;
    }

    /// @notice Buyer deposits `amount` USDC. If seller already funded (via fundSeller), activates.
    function fund() external onlyBuyer {
        require(state == State.Created, "EscrowInstance: invalid state for buyer fund");
        usdc.safeTransferFrom(buyer, address(this), amount);
        state = State.BuyerFunded;
        emit Funded(buyer, amount);

        // Check if this completes both sides (seller could have pre-funded via fundSeller)
        // In normal flow: buyer funds first, then seller funds in separate tx
    }

    /// @notice Seller deposits `collateral` USDC. Both funded → Active.
    function fundSeller() external onlySeller {
        require(state == State.BuyerFunded, "EscrowInstance: buyer must fund first");
        if (collateral > 0) {
            usdc.safeTransferFrom(seller, address(this), collateral);
        }
        state = State.Active;
        emit Funded(seller, collateral);
        emit Activated(deadline);
    }

    /// @notice Seller marks deliverable submitted with result hash.
    function submitDeliverable(bytes32 _resultHash) external onlySeller {
        require(state == State.Active, "EscrowInstance: not active");
        require(block.timestamp <= deadline, "EscrowInstance: past deadline");
        resultHash = _resultHash;
        state = State.Delivered;
        emit DeliverableSubmitted(_resultHash);
    }

    /// @notice Buyer manually confirms delivery (buyer_confirm method).
    function confirmDelivery() external onlyBuyer {
        require(state == State.Delivered, "EscrowInstance: not delivered");
        _release();
    }

    /// @notice Gateway-authorized release with signature verification.
    /// @param escrowId The escrow identifier used for signing
    /// @param resultDigest The result digest signed by gateway
    /// @param v Recovery byte of the signature
    /// @param r First 32 bytes of signature
    /// @param s Second 32 bytes of signature
    function gatewayRelease(
        bytes32 escrowId,
        bytes32 resultDigest,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(state == State.Delivered, "EscrowInstance: not delivered");

        // Verify the gateway signed this release
        bytes32 messageHash = keccak256(abi.encodePacked(escrowId, resultDigest, address(this)));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        address signer = ecrecover(ethSignedHash, v, r, s);
        require(signer == factory.authorizedGateway(), "EscrowInstance: invalid gateway signature");

        _release();
    }

    /// @notice Gateway-authorized fail (verification failed).
    function gatewayFail(
        bytes32 escrowId,
        bytes32 resultDigest,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(state == State.Delivered, "EscrowInstance: not delivered");

        bytes32 messageHash = keccak256(abi.encodePacked("FAIL", escrowId, resultDigest, address(this)));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        address signer = ecrecover(ethSignedHash, v, r, s);
        require(signer == factory.authorizedGateway(), "EscrowInstance: invalid gateway signature");

        _fail();
    }

    /// @notice Either party disputes. Burns both deposits.
    function dispute(bytes32 reasonHash) external onlyParty {
        require(state == State.Active || state == State.Delivered, "EscrowInstance: invalid state for dispute");

        address treasury = factory.treasury();
        uint256 total = usdc.balanceOf(address(this));
        if (total > 0) {
            usdc.safeTransfer(treasury, total);
        }
        state = State.Burned;
        emit Disputed(msg.sender, reasonHash);
        emit Burned(treasury, total);
    }

    /// @notice Anyone can trigger timeout after deadline. Refunds buyer, burns collateral.
    function timeout() external {
        require(block.timestamp > deadline, "EscrowInstance: not past deadline");
        require(
            state == State.Created || state == State.BuyerFunded || state == State.Active,
            "EscrowInstance: invalid state for timeout"
        );

        address treasury = factory.treasury();

        if (state == State.Created) {
            // Nothing to refund
            state = State.Expired;
            emit Expired(buyer, 0);
            return;
        }

        // Refund buyer their amount
        if (amount > 0) {
            usdc.safeTransfer(buyer, amount);
        }

        // Burn seller collateral (if any deposited)
        uint256 remaining = usdc.balanceOf(address(this));
        if (remaining > 0) {
            usdc.safeTransfer(treasury, remaining);
        }

        state = State.Expired;
        emit Expired(buyer, amount);
    }

    // ── Internal ──────────────────────────────────────────────────────────

    function _release() internal {
        uint256 total = usdc.balanceOf(address(this));
        if (total > 0) {
            usdc.safeTransfer(seller, total);
        }
        state = State.Released;
        emit Released(seller, total);
    }

    function _fail() internal {
        address treasury = factory.treasury();

        // Refund buyer
        if (amount > 0) {
            usdc.safeTransfer(buyer, amount);
        }

        // Burn seller collateral
        uint256 remaining = usdc.balanceOf(address(this));
        if (remaining > 0) {
            usdc.safeTransfer(treasury, remaining);
        }

        state = State.Failed;
        emit Failed(buyer, amount);
    }
}
