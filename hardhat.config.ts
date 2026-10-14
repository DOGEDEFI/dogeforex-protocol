import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@nomicfoundation/hardhat-network-helpers";
import "hardhat-deploy";
import "hardhat-abi-exporter";
import "hardhat-contract-sizer";

import dotenv from "dotenv";
dotenv.config();

// Never commit keys. Copy .env.example to .env and fill in locally.
const CHIKYU_RPC_URL = process.env.RPC_URL_CHIKYU ?? "https://rpc.testnet.dogeos.com";
const CHIKYU_DEPLOYER_PK = process.env.CHIKYU_DEPLOYER_PK;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      evmVersion: "shanghai",
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        "*": {
          "*": ["storageLayout"],
        },
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    chikyu: {
      url: CHIKYU_RPC_URL,
      chainId: 6281971,
      gasPrice: "auto",
      accounts: CHIKYU_DEPLOYER_PK ? [CHIKYU_DEPLOYER_PK] : [],
      timeout: 900000,
    },
  },
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
  etherscan: {
    // Blockscout (DogeOS) exposes an Etherscan-compatible API and ignores the key; placeholder only.
    apiKey: {
      chikyu: "blockscout",
    },
    customChains: [
      {
        network: "chikyu",
        chainId: 6281971,
        urls: {
          apiURL: "https://blockscout.testnet.dogeos.com/api",
          browserURL: "https://blockscout.testnet.dogeos.com",
        },
      },
    ],
  },
  sourcify: {
    enabled: true,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
    deploy: "./scripts/deployment/deploy",
    deployments: "./scripts/deployment/deployments",
  },
  contractSizer: {
    alphaSort: false,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  gasReporter: {
    enabled: true,
    currency: "USD",
  },
  abiExporter: {
    path: "./abi",
    clear: true,
    runOnCompile: true,
    flat: true,
    spacing: 4,
    pretty: false,
  },
  mocha: {
    timeout: 120000,
  },
  typechain: {
    outDir: "typechain",
    target: "ethers-v6",
  },
};

export default config;
