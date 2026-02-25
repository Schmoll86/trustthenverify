// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PaymentChannel — unidirectional USDC payment channel for micro-transactions.
/// @notice Per SPEC-v2 §8. Amortizes N micro-txns into 2 on-chain txns (open + close).
///
/// Flow:
///   1. Buyer opens channel with USDC deposit
///   2. Off-chain: buyer sends incrementing signed (channelAddress, amount) messages
///   3. Seller closes with latest signed amount (gets paid, buyer gets remainder)
///   4. Or buyer reclaims after expiration
contract PaymentChannel {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public immutable buyer;
    address public immutable seller;
    uint256 public immutable deposit;
    uint256 public expiration;

    bool public closed;

    event ChannelOpened(address indexed buyer, address indexed seller, uint256 deposit, uint256 expiration);
    event ChannelClosed(address indexed seller, uint256 amount);
    event ExpirationExtended(uint256 newExpiration);
    event TimeoutClaimed(address indexed buyer, uint256 amount);

    constructor(
        address _usdc,
        address _buyer,
        address _seller,
        uint256 _expiration
    ) {
        require(_buyer != _seller, "PaymentChannel: same address");
        usdc = IERC20(_usdc);
        buyer = _buyer;
        seller = _seller;
        expiration = _expiration;

        // Deposit is transferred in during open — record the amount
        // The deployer should transfer USDC to this contract after deployment
        deposit = 0; // Will be set by open()
    }

    // Storage slot for actual deposited amount (set after construction)
    uint256 public depositAmount;

    /// @notice Buyer opens channel by depositing USDC. Must be called after deployment.
    function open(uint256 amount) external {
        require(msg.sender == buyer, "PaymentChannel: not buyer");
        require(depositAmount == 0, "PaymentChannel: already opened");
        require(amount > 0, "PaymentChannel: zero amount");

        usdc.safeTransferFrom(buyer, address(this), amount);
        depositAmount = amount;
        emit ChannelOpened(buyer, seller, amount, expiration);
    }

    /// @notice Seller closes channel with buyer's latest signed payment amount.
    function close(uint256 amount, bytes memory signature) external {
        require(msg.sender == seller, "PaymentChannel: not seller");
        require(!closed, "PaymentChannel: already closed");
        require(amount <= depositAmount, "PaymentChannel: amount exceeds deposit");

        // Verify buyer signed (channelAddress, amount)
        bytes32 messageHash = keccak256(abi.encodePacked(address(this), amount));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));

        require(signature.length == 65, "PaymentChannel: invalid sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;

        address signer = ecrecover(ethSignedHash, v, r, s);
        require(signer == buyer, "PaymentChannel: invalid signature");

        closed = true;

        // Pay seller
        if (amount > 0) {
            usdc.safeTransfer(seller, amount);
        }

        // Return remainder to buyer
        uint256 remainder = depositAmount - amount;
        if (remainder > 0) {
            usdc.safeTransfer(buyer, remainder);
        }

        emit ChannelClosed(seller, amount);
    }

    /// @notice Buyer extends the expiration.
    function extend(uint256 newExpiration) external {
        require(msg.sender == buyer, "PaymentChannel: not buyer");
        require(!closed, "PaymentChannel: already closed");
        require(newExpiration > expiration, "PaymentChannel: must extend forward");
        expiration = newExpiration;
        emit ExpirationExtended(newExpiration);
    }

    /// @notice Buyer reclaims deposit after expiration.
    function claimTimeout() external {
        require(msg.sender == buyer, "PaymentChannel: not buyer");
        require(!closed, "PaymentChannel: already closed");
        require(block.timestamp > expiration, "PaymentChannel: not expired");

        closed = true;
        uint256 balance = usdc.balanceOf(address(this));
        if (balance > 0) {
            usdc.safeTransfer(buyer, balance);
        }
        emit TimeoutClaimed(buyer, balance);
    }
}
