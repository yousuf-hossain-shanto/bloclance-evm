import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { getAddress, parseUnits, Hex, encodePacked, hashMessage, stringToHex, toHex, keccak256 } from "viem";

// Define types for order details - note state is a number not bigint
type OrderDetails = [bigint, bigint, string, number, string];

describe("BloclanceEscrow", function () {
  // We define a fixture to reuse the same setup in every test
  async function deployEscrowFixture() {
    // Contracts are deployed using the first signer/account by default
    const [owner, feeCollector, seller, buyer, otherAccount] = await hre.viem.getWalletClients();
    
    // Deploy MockUSDC first
    const mockUSDC = await hre.viem.deployContract("MockUSDC");
    
    // Deploy BloclanceEscrow with 5% fee (500 basis points)
    const platformFeePercentage = 500n; // 5%
    const bloclanceEscrow = await hre.viem.deployContract("BloclanceEscrow", [
      platformFeePercentage,
      feeCollector.account.address,
      mockUSDC.address
    ]);
    
    // Mint some USDC to buyer for testing
    const mintAmount = parseUnits("1000", 6); // 1000 USDC with 6 decimals
    await mockUSDC.write.mint([buyer.account.address, mintAmount]);
    
    // Approve the escrow contract to spend buyer's USDC
    const mockUSDCForBuyer = await hre.viem.getContractAt(
      "MockUSDC",
      mockUSDC.address,
      { client: { wallet: buyer } }
    );
    await mockUSDCForBuyer.write.approve([bloclanceEscrow.address, mintAmount]);
    
    const publicClient = await hre.viem.getPublicClient();

    return {
      bloclanceEscrow,
      mockUSDC,
      owner,
      feeCollector,
      seller,
      buyer,
      otherAccount,
      platformFeePercentage,
      mintAmount,
      publicClient,
    };
  }

  describe("Deployment", function () {
    it("Should set the correct initial values", async function () {
      const { bloclanceEscrow, feeCollector, platformFeePercentage, mockUSDC } = 
        await loadFixture(deployEscrowFixture);
      
      expect(await bloclanceEscrow.read.platformFeePercentage()).to.equal(platformFeePercentage);
      expect(await bloclanceEscrow.read.feeCollector()).to.equal(getAddress(feeCollector.account.address));
      expect(await bloclanceEscrow.read.USDC()).to.equal(getAddress(mockUSDC.address));
    });
  });

  describe("Order Management", function () {
    it("Should place an order with escrow", async function () {
      const { 
        bloclanceEscrow, 
        mockUSDC, 
        seller, 
        buyer, 
        owner, 
        publicClient 
      } = await loadFixture(deployEscrowFixture);
      
      const orderId = 1n;
      const orderAmount = parseUnits("100", 6); // 100 USDC
      const nonce = 12345n;
      
      // Generate signature
      const orderHash = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId, orderAmount, seller.account.address, nonce]));
      const signature = await owner.signMessage({ message: { raw: orderHash } });
      
      // Call placeOrder through the buyer's account
      const escrowForBuyer = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: buyer } }
      );
      
      // Place the order
      const tx = await escrowForBuyer.write.placeOrder([
        orderId,
        orderAmount,
        seller.account.address,
        nonce,
        signature
      ]);
      
      await publicClient.waitForTransactionReceipt({ hash: tx });
      
      // Check order was stored correctly - get the order tuple
      const orderResult = await bloclanceEscrow.read.getOrder([orderId]);
      const [amount, feeAmount, sellerAddress, state, buyerAddress] = orderResult as OrderDetails;
      
      expect(amount).to.equal(orderAmount);
      expect(sellerAddress).to.equal(getAddress(seller.account.address));
      expect(state).to.equal(0); // state = ACTIVE
      expect(buyerAddress).to.equal(getAddress(buyer.account.address));
      
      // Check funds were transferred to escrow
      const escrowBalance = await mockUSDC.read.balanceOf([bloclanceEscrow.address]);
      expect(escrowBalance).to.equal(orderAmount);
    });

    it("Should release funds to seller", async function () {
      const { 
        bloclanceEscrow, 
        mockUSDC, 
        seller, 
        buyer, 
        owner, 
        feeCollector,
        publicClient 
      } = await loadFixture(deployEscrowFixture);
      
      const orderId = 1n;
      const orderAmount = parseUnits("100", 6); // 100 USDC
      const nonce = 12345n;
      
      // Generate signature
      const orderHash = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId, orderAmount, seller.account.address, nonce]));
      const signature = await owner.signMessage({ message: { raw: orderHash } });
      
      // Place order
      const escrowForBuyer = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: buyer } }
      );
      
      await escrowForBuyer.write.placeOrder([
        orderId,
        orderAmount,
        seller.account.address,
        nonce,
        signature
      ]);
      
      // Get initial balances
      const initialFeeCollectorBalance = await mockUSDC.read.balanceOf([feeCollector.account.address]) as bigint;
      const initialSellerBalance = await mockUSDC.read.balanceOf([seller.account.address]) as bigint;
      
      // Release funds from seller account
      const escrowForSeller = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: seller } }
      );
      
      const releaseTx = await escrowForBuyer.write.releaseFunds([orderId]);
      await publicClient.waitForTransactionReceipt({ hash: releaseTx });
      
      // Get expected fee amount (5% of order amount)
      const feeAmount = (orderAmount * 500n) / 10000n;
      const sellerAmount = orderAmount - feeAmount;
      
      // Check balances after release
      const finalFeeCollectorBalance = await mockUSDC.read.balanceOf([feeCollector.account.address]) as bigint;
      const finalSellerBalance = await mockUSDC.read.balanceOf([seller.account.address]) as bigint;
      
      expect(finalFeeCollectorBalance - initialFeeCollectorBalance).to.equal(feeAmount);
      expect(finalSellerBalance - initialSellerBalance).to.equal(sellerAmount);
      
      // Check order state
      const orderResult = await bloclanceEscrow.read.getOrder([orderId]);
      const [,, , state,] = orderResult as OrderDetails;
      expect(state).to.equal(1); // state = RELEASED
    });

    it("Should refund the buyer", async function () {
      const { 
        bloclanceEscrow, 
        mockUSDC, 
        seller, 
        buyer, 
        owner, 
        publicClient 
      } = await loadFixture(deployEscrowFixture);
      
      const orderId = 1n;
      const orderAmount = parseUnits("100", 6); // 100 USDC
      const nonce = 12345n;
      
      // Generate signature
      const orderHash = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId, orderAmount, seller.account.address, nonce]));
      const signature = await owner.signMessage({ message: { raw: orderHash } });
      
      // Place order
      const escrowForBuyer = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: buyer } }
      );
      
      await escrowForBuyer.write.placeOrder([
        orderId,
        orderAmount,
        seller.account.address,
        nonce,
        signature
      ]);
      
      // Get buyer's initial balance
      const initialBuyerBalance = await mockUSDC.read.balanceOf([buyer.account.address]) as bigint;
      
      // Refund from seller account
      const escrowForSeller = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: seller } }
      );
      
      const refundTx = await escrowForSeller.write.refund([orderId]);
      await publicClient.waitForTransactionReceipt({ hash: refundTx });
      
      // Check buyer received full refund
      const finalBuyerBalance = await mockUSDC.read.balanceOf([buyer.account.address]) as bigint;
      expect(finalBuyerBalance - initialBuyerBalance).to.equal(orderAmount);
      
      // Check order state
      const orderResult = await bloclanceEscrow.read.getOrder([orderId]);
      const [,, , state,] = orderResult as OrderDetails;
      expect(state).to.equal(2); // state = REFUNDED
    });

    it("Should allow owner to update fee percentage", async function () {
      const { bloclanceEscrow, owner, publicClient } = await loadFixture(deployEscrowFixture);
      
      const newFeePercentage = 600n; // 6%
      
      // Update fee
      const tx = await bloclanceEscrow.write.updateFee([newFeePercentage]);
      await publicClient.waitForTransactionReceipt({ hash: tx });
      
      // Check updated fee
      expect(await bloclanceEscrow.read.platformFeePercentage()).to.equal(newFeePercentage);
    });

    it("Should allow owner to update fee collector", async function () {
      const { bloclanceEscrow, otherAccount, publicClient } = await loadFixture(deployEscrowFixture);
      
      const newFeeCollector = otherAccount.account.address;
      
      // Update fee collector
      const tx = await bloclanceEscrow.write.updateFeeCollector([newFeeCollector]);
      await publicClient.waitForTransactionReceipt({ hash: tx });
      
      // Check updated fee collector
      expect(await bloclanceEscrow.read.feeCollector()).to.equal(getAddress(newFeeCollector));
    });

    it("Should not allow non-owner to update fee percentage", async function () {
      const { bloclanceEscrow, otherAccount } = await loadFixture(deployEscrowFixture);
      
      const newFeePercentage = 600n; // 6%
      
      // Try to update fee from non-owner account
      const escrowForOther = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: otherAccount } }
      );
      
      await expect(escrowForOther.write.updateFee([newFeePercentage]))
        .to.be.rejectedWith(/OwnableUnauthorizedAccount/);
    });

    it("Should allow buyer to release funds", async function () {
      const { 
        bloclanceEscrow, 
        mockUSDC, 
        seller, 
        buyer, 
        owner, 
        feeCollector,
        publicClient 
      } = await loadFixture(deployEscrowFixture);
      
      const orderId = 1n;
      const orderAmount = parseUnits("100", 6); // 100 USDC
      const nonce = 12345n;
      
      // Generate signature
      const orderHash = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId, orderAmount, seller.account.address, nonce]));
      const signature = await owner.signMessage({ message: { raw: orderHash } });
      
      // Place order
      const escrowForBuyer = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: buyer } }
      );
      
      await escrowForBuyer.write.placeOrder([
        orderId,
        orderAmount,
        seller.account.address,
        nonce,
        signature
      ]);
      
      // Release funds from buyer account
      const releaseTx = await escrowForBuyer.write.releaseFunds([orderId]);
      await publicClient.waitForTransactionReceipt({ hash: releaseTx });
      
      // Check order state
      const orderResult = await bloclanceEscrow.read.getOrder([orderId]);
      const [,, , state,] = orderResult as OrderDetails;
      expect(state).to.equal(1); // state = RELEASED
    });

    it("Should allow owner to release funds", async function () {
      const { 
        bloclanceEscrow, 
        mockUSDC, 
        seller, 
        buyer, 
        owner, 
        publicClient 
      } = await loadFixture(deployEscrowFixture);
      
      const orderId = 1n;
      const orderAmount = parseUnits("100", 6); // 100 USDC
      const nonce = 12345n;
      
      // Generate signature
      const orderHash = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId, orderAmount, seller.account.address, nonce]));
      const signature = await owner.signMessage({ message: { raw: orderHash } });
      
      // Place order
      const escrowForBuyer = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: buyer } }
      );
      
      await escrowForBuyer.write.placeOrder([
        orderId,
        orderAmount,
        seller.account.address,
        nonce,
        signature
      ]);
      
      // Release funds from owner account
      const releaseTx = await bloclanceEscrow.write.releaseFunds([orderId]);
      await publicClient.waitForTransactionReceipt({ hash: releaseTx });
      
      // Check order state
      const orderResult = await bloclanceEscrow.read.getOrder([orderId]);
      const [,, , state,] = orderResult as OrderDetails;
      expect(state).to.equal(1); // state = RELEASED
    });

    it("Should not allow seller to release funds", async function () {
      const { 
        bloclanceEscrow, 
        seller, 
        buyer, 
        owner
      } = await loadFixture(deployEscrowFixture);
      
      const orderId = 1n;
      const orderAmount = parseUnits("100", 6); // 100 USDC
      const nonce = 12345n;
      
      // Generate signature
      const orderHash = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId, orderAmount, seller.account.address, nonce]));
      const signature = await owner.signMessage({ message: { raw: orderHash } });
      
      // Place order
      const escrowForBuyer = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: buyer } }
      );
      
      await escrowForBuyer.write.placeOrder([
        orderId,
        orderAmount,
        seller.account.address,
        nonce,
        signature
      ]);
      
      // Try to release funds from seller account - should fail
      const escrowForSeller = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: seller } }
      );
      
      await expect(escrowForSeller.write.releaseFunds([orderId]))
        .to.be.rejectedWith(/NotAuthorized/);
    });

    it("Should allow owner to refund", async function () {
      const { 
        bloclanceEscrow, 
        mockUSDC, 
        seller, 
        buyer, 
        owner, 
        publicClient 
      } = await loadFixture(deployEscrowFixture);
      
      const orderId = 1n;
      const orderAmount = parseUnits("100", 6); // 100 USDC
      const nonce = 12345n;
      
      // Generate signature
      const orderHash = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId, orderAmount, seller.account.address, nonce]));
      const signature = await owner.signMessage({ message: { raw: orderHash } });
      
      // Place order
      const escrowForBuyer = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: buyer } }
      );
      
      await escrowForBuyer.write.placeOrder([
        orderId,
        orderAmount,
        seller.account.address,
        nonce,
        signature
      ]);
      
      // Get buyer's initial balance
      const initialBuyerBalance = await mockUSDC.read.balanceOf([buyer.account.address]) as bigint;
      
      // Refund from owner account
      const refundTx = await bloclanceEscrow.write.refund([orderId]);
      await publicClient.waitForTransactionReceipt({ hash: refundTx });
      
      // Check buyer received full refund
      const finalBuyerBalance = await mockUSDC.read.balanceOf([buyer.account.address]) as bigint;
      expect(finalBuyerBalance - initialBuyerBalance).to.equal(orderAmount);
      
      // Check order state
      const orderResult = await bloclanceEscrow.read.getOrder([orderId]);
      const [,, , state,] = orderResult as OrderDetails;
      expect(state).to.equal(2); // state = REFUNDED
    });

    it("Should not allow buyer to refund", async function () {
      const { 
        bloclanceEscrow, 
        seller, 
        buyer, 
        owner
      } = await loadFixture(deployEscrowFixture);
      
      const orderId = 1n;
      const orderAmount = parseUnits("100", 6); // 100 USDC
      const nonce = 12345n;
      
      // Generate signature
      const orderHash = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId, orderAmount, seller.account.address, nonce]));
      const signature = await owner.signMessage({ message: { raw: orderHash } });
      
      // Place order
      const escrowForBuyer = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: buyer } }
      );
      
      await escrowForBuyer.write.placeOrder([
        orderId,
        orderAmount,
        seller.account.address,
        nonce,
        signature
      ]);
      
      // Try to refund from buyer account - should fail
      await expect(escrowForBuyer.write.refund([orderId]))
        .to.be.rejectedWith(/NotAuthorized/);
    });

    it("Should prevent using a nonce twice", async function () {
      const { 
        bloclanceEscrow, 
        seller, 
        buyer, 
        owner 
      } = await loadFixture(deployEscrowFixture);
      
      const orderId1 = 1n;
      const orderId2 = 2n;
      const orderAmount = parseUnits("100", 6); // 100 USDC
      const nonce = 12345n;
      
      // Generate signature for first order
      const orderHash1 = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId1, orderAmount, seller.account.address, nonce]));
      const signature1 = await owner.signMessage({ message: { raw: orderHash1 } });
      
      // Generate signature for second order
      const orderHash2 = keccak256(encodePacked(['uint256', 'uint256', 'address', 'uint256'], [orderId2, orderAmount, seller.account.address, nonce]));
      const signature2 = await owner.signMessage({ message: { raw: orderHash2 } });
      
      // Place first order
      const escrowForBuyer = await hre.viem.getContractAt(
        "BloclanceEscrow",
        bloclanceEscrow.address,
        { client: { wallet: buyer } }
      );
      
      await escrowForBuyer.write.placeOrder([
        orderId1,
        orderAmount,
        seller.account.address,
        nonce,
        signature1
      ]);
      
      // Try to place second order with same nonce
      await expect(escrowForBuyer.write.placeOrder([
        orderId2,
        orderAmount,
        seller.account.address,
        nonce,
        signature2
      ])).to.be.rejectedWith(/NonceAlreadyUsed/);
    });
  });
}); 