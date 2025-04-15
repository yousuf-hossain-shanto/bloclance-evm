# Bloclance Escrow

Smart contract for handling escrow payments in the Bloclance freelance platform.

## Overview

The BloclanceEscrow contract is a secure escrow system that:
- Holds funds during order execution
- Verifies signatures to prevent fraud
- Collects platform fees on successful order completion
- Allows funds to be released to sellers or refunded to buyers

## Technology Stack

- Solidity 0.8.28
- Hardhat development framework
- Viem for client interactions
- OpenZeppelin contracts for security
- Hardhat Ignition for deployment

## Smart Contract Functions

- `placeOrder`: Create a new escrow with funds locked
- `releaseFunds`: Release funds to seller (by seller or admin)
- `refund`: Refund to buyer (by seller or admin)
- `updateFee`: Change platform fee percentage (admin only)
- `updateFeeCollector`: Change fee collector address (admin only)

## Development and Testing

### Prerequisites

- Node.js v16+
- pnpm (recommended) or npm
- Ethereum wallet with testnet ETH

### Setup

1. Install dependencies:
```
pnpm install
```

2. Compile contracts:
```
pnpm hardhat compile
```

3. Run tests:
```
pnpm hardhat test
```

## Deployment using Hardhat Ignition

Hardhat Ignition is used for reproducible, declarative deployments. The project includes pre-configured deployment modules.

### Deployment Steps

1. Set up environment variables (create a `.env` file):

```
PRIVATE_KEY=your_private_key
ETHERSCAN_API_KEY=your_etherscan_api_key
SEPOLIA_RPC_URL=your_sepolia_rpc_url
MAINNET_RPC_URL=your_mainnet_rpc_url

# BloclanceEscrow parameters
PLATFORM_FEE_PERCENTAGE=500
FEE_COLLECTOR=0xYourFeeCollectorAddress
USDC_ADDRESS=0xYourUSDCAddress
```

2. Deploy to Sepolia testnet:

```bash
pnpm hardhat ignition deploy ignition/modules/BloclanceEscrow.ts --network sepolia
```

3. Deploy to Ethereum mainnet:

```bash
pnpm hardhat ignition deploy ignition/modules/BloclanceEscrow.ts --network mainnet
```

### Deployment Parameters

The BloclanceEscrow deployment requires three parameters that can be provided:

1. As environment variables (recommended for production)
2. As command-line parameters
3. Default values in the deployment script

#### Parameter Options:

- `platformFeePercentage`: Fee percentage in basis points (500 = 5%)
- `feeCollector`: Address to receive fee payments
- `usdc`: USDC token address on the target network

#### Example with CLI parameters:

```bash
pnpm hardhat ignition deploy ignition/modules/BloclanceEscrow.ts --network sepolia --parameters '{ "feeCollector": "0x123...", "usdc": "0x456..." }'
```

## License

MIT
