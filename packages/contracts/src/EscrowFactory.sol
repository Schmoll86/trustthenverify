// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./EscrowInstance.sol";

/// @title EscrowFactory — deploys deterministic EscrowInstance contracts via CREATE2.
/// @notice Per SPEC-v2 §8.1. Each escrow gets a unique contract address derived from escrowId.
contract EscrowFactory is Ownable {
    IERC20 public immutable usdc;
    address public authorizedGateway;
    address public treasury;

    mapping(bytes32 => address) public escrows;

    event EscrowDeployed(bytes32 indexed escrowId, address escrowAddress, address buyer, address seller);
    event GatewayRotated(address indexed oldGateway, address indexed newGateway);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    constructor(address _usdc, address _gateway, address _treasury) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        authorizedGateway = _gateway;
        treasury = _treasury;
    }

    /// @notice Deploy a new EscrowInstance with deterministic address from escrowId.
    function create(
        bytes32 escrowId,
        address buyer,
        address seller,
        uint256 amount,
        uint256 collateral,
        uint256 deadline
    ) external returns (address) {
        require(escrows[escrowId] == address(0), "EscrowFactory: already deployed");
        require(buyer != address(0) && seller != address(0), "EscrowFactory: zero address");
        require(buyer != seller, "EscrowFactory: same address");
        require(amount > 0, "EscrowFactory: zero amount");

        bytes memory bytecode = abi.encodePacked(
            type(EscrowInstance).creationCode,
            abi.encode(address(usdc), address(this), buyer, seller, amount, collateral, deadline)
        );

        address instance;
        assembly {
            instance := create2(0, add(bytecode, 0x20), mload(bytecode), escrowId)
        }
        require(instance != address(0), "EscrowFactory: deploy failed");

        escrows[escrowId] = instance;
        emit EscrowDeployed(escrowId, instance, buyer, seller);
        return instance;
    }

    /// @notice Predict the deterministic address for an escrowId before deployment.
    function predictAddress(
        bytes32 escrowId,
        address buyer,
        address seller,
        uint256 amount,
        uint256 collateral,
        uint256 deadline
    ) external view returns (address) {
        bytes memory bytecode = abi.encodePacked(
            type(EscrowInstance).creationCode,
            abi.encode(address(usdc), address(this), buyer, seller, amount, collateral, deadline)
        );
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), escrowId, keccak256(bytecode))
        );
        return address(uint160(uint256(hash)));
    }

    /// @notice Rotate the authorized gateway address. Owner only.
    function rotateGateway(address newGateway) external onlyOwner {
        require(newGateway != address(0), "EscrowFactory: zero address");
        address old = authorizedGateway;
        authorizedGateway = newGateway;
        emit GatewayRotated(old, newGateway);
    }

    /// @notice Update treasury address. Owner only.
    function updateTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "EscrowFactory: zero address");
        address old = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(old, newTreasury);
    }
}
