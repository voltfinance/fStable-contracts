import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@tenderly/hardhat-tenderly"
import "@typechain/hardhat"
import "hardhat-gas-reporter"
import "solidity-coverage"
import "hardhat-abi-exporter"
import "@nomiclabs/hardhat-etherscan"
import "hardhat-deploy"

import "ts-node/register"
import "tsconfig-paths/register"

// chainId?: number
// from?: string;
// gas: "auto" | number;
// gasPrice: "auto" | number;
// gasMultiplier: number;
// url: string;
// timeout: number;
// httpHeaders: { [name: string]: string };
// accounts: HttpNetworkAccountsConfig;

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const compilerConfig = (version: string) => ({
    version,
    settings: {
        optimizer: {
            enabled: true,
            runs: 200,
        },
        outputSelection: {
            "*": {
                "*": [
                    "metadata", 
                    "evm.bytecode",
                    "evm.bytecode.sourceMap"
                ]
            }
        },
    },
})

export const hardhatConfig = {
    networks: {
        hardhat: {
            allowUnlimitedContractSize: false,
            initialBaseFeePerGas: 0,
        },
        local: { url: "http://localhost:8545" },
        // export the NODE_URL environment variable to use remote nodes like Alchemy or Infura. ge
        // export NODE_URL=https://eth-mainnet.alchemyapi.io/v2/yourApiKey
        ropsten: {
            url: process.env.NODE_URL || "",
        },
        polygon_testnet: {
            url: process.env.NODE_URL || "https://rpc-mumbai.maticvigil.com",
        },
        polygon_mainnet: {
            url: process.env.NODE_URL || "https://rpc-mainnet.matic.quiknode.pro",
        },
        mainnet: {
            url: process.env.NODE_URL || "https://main-light.eth.linkpool.io",
        },
        fuse: {
            url: process.env.NODE_URL || "https://rpc.fuse.io"
        }
    },
    solidity: {
        compilers: [{ ...compilerConfig("0.8.6") }, { ...compilerConfig("0.8.2") }, { ...compilerConfig("0.5.16") }],
    },
    paths: { artifacts: "./build" },
    abiExporter: {
        path: "./abis",
        clear: true,
        flat: true,
    },
    gasReporter: {
        currency: "USD",
        gasPrice: 30,
    },
    mocha: {
        timeout: 240000, // 4 min timeout
    },
    typechain: {
        outDir: "types/generated",
        target: "ethers-v5",
    },
    tenderly: {
        username: "alsco77",
        project: "mStable",
    },
    etherscan: {
        apiKey: process.env.ETHERSCAN_KEY,
    },
}

export default hardhatConfig
