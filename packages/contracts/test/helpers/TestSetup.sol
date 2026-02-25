// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/EscrowFactory.sol";
import "../../src/EscrowInstance.sol";
import "../../src/PaymentChannel.sol";
import "../../src/test/MockUSDC.sol";

/// @dev Shared test fixtures for all escrow tests.
abstract contract TestSetup is Test {
    MockUSDC public usdc;
    EscrowFactory public factory;

    address public owner = address(this);
    address public gateway;
    uint256 public gatewayKey;
    address public treasury = makeAddr("treasury");
    address public buyerAddr = makeAddr("buyer");
    address public sellerAddr = makeAddr("seller");

    uint256 public constant AMOUNT = 1000e6;     // 1000 USDC
    uint256 public constant COLLATERAL = 100e6;   // 100 USDC
    uint256 public constant DEADLINE_OFFSET = 1 hours;

    bytes32 public constant ESCROW_ID = keccak256("escrow-001");

    function setUp() public virtual {
        // Generate gateway keypair for signature verification
        (gateway, gatewayKey) = makeAddrAndKey("gateway");

        usdc = new MockUSDC();
        factory = new EscrowFactory(address(usdc), gateway, treasury);

        // Mint USDC to buyer and seller
        usdc.mint(buyerAddr, 10_000e6);
        usdc.mint(sellerAddr, 10_000e6);
    }

    function _deployEscrow() internal returns (EscrowInstance) {
        return _deployEscrow(ESCROW_ID);
    }

    function _deployEscrow(bytes32 escrowId) internal returns (EscrowInstance) {
        uint256 deadline = block.timestamp + DEADLINE_OFFSET;
        address addr = factory.create(escrowId, buyerAddr, sellerAddr, AMOUNT, COLLATERAL, deadline);
        return EscrowInstance(addr);
    }

    function _fundBoth(EscrowInstance instance) internal {
        // Buyer approves and funds
        vm.startPrank(buyerAddr);
        usdc.approve(address(instance), AMOUNT);
        instance.fund();
        vm.stopPrank();

        // Seller approves and funds
        vm.startPrank(sellerAddr);
        usdc.approve(address(instance), COLLATERAL);
        instance.fundSeller();
        vm.stopPrank();
    }

    function _signGatewayRelease(bytes32 escrowId, bytes32 resultDigest, address instanceAddr)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 messageHash = keccak256(abi.encodePacked(escrowId, resultDigest, instanceAddr));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (v, r, s) = vm.sign(gatewayKey, ethSignedHash);
    }

    function _signGatewayFail(bytes32 escrowId, bytes32 resultDigest, address instanceAddr)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 messageHash = keccak256(abi.encodePacked("FAIL", escrowId, resultDigest, instanceAddr));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (v, r, s) = vm.sign(gatewayKey, ethSignedHash);
    }
}
