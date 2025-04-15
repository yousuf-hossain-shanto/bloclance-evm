import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("BloclanceEscrow", (m) => {
  // Get deployment parameters from environment variables or use defaults
  const platformFeePercentage = process.env.PLATFORM_FEE_PERCENTAGE 
    ? BigInt(process.env.PLATFORM_FEE_PERCENTAGE) 
    : 500n; // Default: 5% (in basis points)
    
  const feeCollector = process.env.FEE_COLLECTOR || m.getParameter("feeCollector");
  const usdc = process.env.USDC_ADDRESS || m.getParameter("usdc");

  // Deploy the BloclanceEscrow contract
  const escrow = m.contract("BloclanceEscrow", [
    platformFeePercentage,
    feeCollector,
    usdc
  ]);

  return { escrow };
});