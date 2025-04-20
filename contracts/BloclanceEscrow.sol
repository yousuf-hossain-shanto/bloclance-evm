// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title BloclanceEscrow
 * @dev Smart contract for handling escrow payments in the Bloclance platform
 */
contract BloclanceEscrow is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    
    // Order states
    enum OrderState { ACTIVE, RELEASED, REFUNDED }
    
    // Optimized struct packing - total 64 bytes = 2 slots
    struct Order {
        uint128 amount;
        uint128 feeAmount; // Pre-calculated fee amount
        address seller; // 20 bytes
        OrderState state; // 1 byte (gets packed with seller)
        address buyer; // Added buyer field for proper refund handling
    }

    // State variables
    mapping(uint256 => Order) private orders;
    mapping(uint256 => bool) private usedNonces;
    
    // Pack these values into a single storage slot
    uint64 public platformFeePercentage; // in basis points (1% = 100)
    address public immutable USDC;
    address public feeCollector;

    // Events - indexed fields for more efficient filtering
    event OrderPlaced(uint256 indexed orderId, uint128 amount, address indexed seller);
    event OrderReleased(uint256 indexed orderId, address indexed releasedBy);
    event OrderRefunded(uint256 indexed orderId, address indexed refundedBy);
    event FeeUpdated(uint64 newPercentage);
    event FeeCollectorUpdated(address newFeeCollector);

    // Custom errors save gas compared to require statements with string messages
    error InvalidAddress();
    error InvalidAmount();
    error OrderAlreadyExists();
    error InvalidSignature();
    error TransferFailed();
    error OrderDoesNotExist();
    error OrderAlreadyProcessed();
    error NotAuthorized();
    error FeePercentageTooHigh();
    error NonceAlreadyUsed();

    constructor(
        uint64 _platformFeePercentage,
        address _feeCollector,
        address _usdc
    ) Ownable(msg.sender) {
        if (_platformFeePercentage > 1000) revert FeePercentageTooHigh();
        if (_feeCollector == address(0)) revert InvalidAddress();
        if (_usdc == address(0)) revert InvalidAddress();
        
        platformFeePercentage = _platformFeePercentage;
        feeCollector = _feeCollector;
        USDC = _usdc;
    }

    /**
     * @dev Process a payment order
     * @param orderId Unique identifier for the order
     * @param amount Amount to be paid
     * @param seller Address to receive the payment
     */
    function getOrderHash(uint256 orderId, uint256 amount, address seller, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(orderId, amount, seller, nonce));
    }

    function verifySignature(uint256 orderId, uint256 amount, address seller, uint256 nonce, bytes memory signature) public view returns (bool) {
        bytes32 orderHash = getOrderHash(orderId, amount, seller, nonce);
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(orderHash);
        address signer = ECDSA.recover(ethSignedMessageHash, signature);
        return signer == owner();
    }

    /**
     * @dev Places a new order with escrow
     */
    function placeOrder(
        uint256 orderId,
        uint128 amount,
        address seller,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant {
        // Group validation checks for better readability and gas optimization
        if (amount == 0) revert InvalidAmount();
        if (seller == address(0)) revert InvalidAddress();
        if (orders[orderId].amount != 0) revert OrderAlreadyExists();
        if (usedNonces[nonce]) revert NonceAlreadyUsed();
        if (!verifySignature(orderId, amount, seller, nonce, signature)) revert InvalidSignature();
        
        // Mark nonce as used
        usedNonces[nonce] = true;

        // Cache USDC address
        address usdc = USDC;

        // Transfer USDC from buyer to contract
        (bool success, bytes memory data) = usdc.call(
            abi.encodeWithSelector(
                IERC20.transferFrom.selector,
                msg.sender,
                address(this),
                amount
            )
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();

        // Calculate fee amount inline with unchecked math (can't overflow with reasonable fee percentage)
        uint128 feeAmount;
        unchecked {
            feeAmount = uint128((uint256(amount) * platformFeePercentage) / 10000);
        }

        // Store order details
        orders[orderId] = Order({
            amount: amount,
            feeAmount: feeAmount,
            seller: seller,
            state: OrderState.ACTIVE,
            buyer: msg.sender
        });

        emit OrderPlaced(orderId, amount, seller);
    }

    /**
     * @dev Releases funds to the seller
     */
    function releaseFunds(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        
        // Group validation checks
        if (order.amount == 0) revert OrderDoesNotExist();
        if (order.state != OrderState.ACTIVE) revert OrderAlreadyProcessed();
        if (msg.sender != order.buyer && msg.sender != owner()) revert NotAuthorized();

        // No need to recalculate fees - use pre-calculated value
        uint128 feeAmount = order.feeAmount;
        uint128 sellerAmount;
        unchecked {
            sellerAmount = order.amount - feeAmount;
        }

        // Mark as released first to prevent reentrancy
        order.state = OrderState.RELEASED;

        // Optimize transfer calls - avoid unnecessary storage reads
        address _feeCollector = feeCollector;
        address _seller = order.seller;
        address _usdc = USDC;

        // Transfer fee to fee collector
        _transferERC20(_usdc, _feeCollector, feeAmount);
        
        // Transfer remaining amount to seller
        _transferERC20(_usdc, _seller, sellerAmount);

        emit OrderReleased(orderId, msg.sender);
    }

    /**
     * @dev Refunds the buyer
     */
    function refund(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        
        // Group validation checks
        if (order.amount == 0) revert OrderDoesNotExist();
        if (order.state != OrderState.ACTIVE) revert OrderAlreadyProcessed();
        if (msg.sender != order.seller && msg.sender != owner()) revert NotAuthorized();

        // Mark as refunded first to prevent reentrancy
        order.state = OrderState.REFUNDED;
        
        // Cache variables to avoid multiple storage reads
        uint128 amount = order.amount;
        address buyer = order.buyer;
        
        // Transfer USDC back to buyer
        _transferERC20(USDC, buyer, amount);

        emit OrderRefunded(orderId, msg.sender);
    }

    /**
     * @dev Internal function to transfer ERC20 tokens
     */
    function _transferERC20(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /**
     * @dev Updates platform fee percentage
     */
    function updateFee(uint64 newPercentage) external onlyOwner {
        if (newPercentage > 1000) revert FeePercentageTooHigh();
        platformFeePercentage = newPercentage;
        emit FeeUpdated(newPercentage);
    }

    /**
     * @dev Updates fee collector address
     */
    function updateFeeCollector(address newFeeCollector) external onlyOwner {
        if (newFeeCollector == address(0)) revert InvalidAddress();
        feeCollector = newFeeCollector;
        emit FeeCollectorUpdated(newFeeCollector);
    }

    /**
     * @dev Checks if a nonce has been used
     */
    function isNonceUsed(uint256 nonce) external view returns (bool) {
        return usedNonces[nonce];
    }

    /**
     * @dev Returns the order details
     */
    function getOrder(uint256 orderId) external view returns (
        uint128 amount,
        uint128 feeAmount,
        address seller,
        OrderState state,
        address buyer
    ) {
        Order storage order = orders[orderId];
        return (order.amount, order.feeAmount, order.seller, order.state, order.buyer);
    }
}