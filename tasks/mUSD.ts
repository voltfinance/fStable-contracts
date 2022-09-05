/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
import "ts-node/register"
import "tsconfig-paths/register"
import { task, types } from "hardhat/config"
import { Signer } from "ethers"

import { Fasset, FassetManager__factory, Fasset__factory, SavingsManager__factory } from "types/generated"
import { BN } from "@utils/math"
import { FusdEth__factory } from "types/generated/factories/FusdEth__factory"
import { FusdLegacy__factory } from "types/generated/factories/FusdLegacy__factory"
import { FusdLegacy } from "types/generated/FusdLegacy"
import { FusdEth } from "types/generated/FusdEth"
import { dumpBassetStorage, dumpConfigStorage, dumpTokenStorage } from "./utils/storage-utils"
import {
    getMultiRedemptions,
    getBlock,
    getBlockRange,
    getBasket,
    snapConfig,
    getMints,
    getMultiMints,
    getSwaps,
    getRedemptions,
    outputFees,
    getBalances,
    snapSave,
    getCollectedInterest,
} from "./utils/snap-utils"
import { Token, sUSD, USDC, DAI, USDT, PUSDT, PUSDC, PDAI, fUSD, PfUSD, MfUSD, RfUSD, Chain } from "./utils/tokens"
import { usdFormatter } from "./utils/quantity-formatters"
import { getSwapRates } from "./utils/rates-utils"
import { getSigner } from "./utils"
import { getChain, getChainAddress } from "./utils/networkAddressFactory"

const fUsdBassets: Token[] = [sUSD, USDC, DAI, USDT]
const fUsdPolygonBassets: Token[] = [PUSDC, PDAI, PUSDT]

// major fUSD upgrade to FusdV3 that changes the ABI
export const fusdUpgradeBlock = 12094376

const getFasset = (signer: Signer, networkName: string, block: number): Fasset | FusdEth | FusdLegacy => {
    if (networkName === "polygon_mainnet") {
        return Fasset__factory.connect(PfUSD.address, signer)
    }
    if (networkName === "polygon_testnet") {
        return Fasset__factory.connect(MfUSD.address, signer)
    }
    if (networkName === "ropsten") {
        return FusdEth__factory.connect(RfUSD.address, signer)
    }
    // The block fUSD was upgraded to the latest Fasset with contract name (Fusdv3)
    if (block < fusdUpgradeBlock) {
        return FusdLegacy__factory.connect(fUSD.address, signer)
    }
    return FusdEth__factory.connect(fUSD.address, signer)
}

task("fUSD-storage", "Dumps fUSD's storage data")
    .addOptionalParam("block", "Block number to get storage from. (default: current block)", 0, types.int)
    .addOptionalParam("type", "Type of storage to report. token, basset, config or all.", "all", types.string)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre)

        const blockNumber = taskArgs.block ? taskArgs.block : await hre.ethers.provider.getBlockNumber()
        console.log(`Block number ${blockNumber}`)

        const fAsset = getFasset(signer, hre.network.name, blockNumber)

        if (["token", "all"].includes(taskArgs.type)) await dumpTokenStorage(fAsset, blockNumber)
        if (["basset", "all"].includes(taskArgs.type)) await dumpBassetStorage(fAsset, blockNumber)
        if (["config", "all"].includes(taskArgs.type)) await dumpConfigStorage(fAsset, blockNumber)
    })

task("fUSD-snap", "Snaps fUSD")
    .addOptionalParam("from", "Block to query transaction events from. (default: deployment block)", 12094461, types.int)
    .addOptionalParam("to", "Block to query transaction events to. (default: current block)", 0, types.int)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre)
        const chain = getChain(hre)
        const { network, ethers } = hre

        let exposedValidator
        if (!["mainnet", "polygon_mainnet"].includes(network.name)) {
            console.log("Not a mainnet chain")

            const LogicFactory = await ethers.getContractFactory("FassetLogic")
            const logicLib = await LogicFactory.deploy()
            const linkedAddress = {
                libraries: {
                    FassetLogic: logicLib.address,
                },
            }
            const fassetFactory = await ethers.getContractFactory("ExposedFassetLogic", linkedAddress)
            exposedValidator = await fassetFactory.deploy()
        }

        const { fromBlock, toBlock } = await getBlockRange(hre.ethers, taskArgs.from, taskArgs.to)

        const fAsset = getFasset(signer, network.name, toBlock.blockNumber)
        const savingsManagerAddress = getChainAddress("SavingsManager", chain)
        const savingsManager = SavingsManager__factory.connect(savingsManagerAddress, signer)

        const bAssets = network.name.includes("polygon") ? fUsdPolygonBassets : fUsdBassets

        let accounts = []
        if (chain === Chain.mainnet) {
            accounts = [
                {
                    name: "ifUSD",
                    address: fUSD.savings,
                },
                {
                    name: "Iron Bank",
                    address: "0xbe86e8918dfc7d3cb10d295fc220f941a1470c5c",
                },
                {
                    name: "Curve fUSD",
                    address: "0x8474ddbe98f5aa3179b3b3f5942d724afcdec9f6",
                },
                {
                    name: "mStable DAO",
                    address: "0x3dd46846eed8D147841AE162C8425c08BD8E1b41",
                },
                {
                    name: "Balancer ETH/fUSD 50/50 #2",
                    address: "0xe036cce08cf4e23d33bc6b18e53caf532afa8513",
                },
            ]
        } else if (chain === Chain.polygon) {
            accounts = [
                {
                    name: "ifUSD",
                    address: PfUSD.savings,
                },
            ]
        }

        const mintSummary = await getMints(bAssets, fAsset, fromBlock.blockNumber, toBlock.blockNumber, usdFormatter)
        const mintMultiSummary = await getMultiMints(bAssets, fAsset, fromBlock.blockNumber, toBlock.blockNumber, usdFormatter)
        const swapSummary = await getSwaps(bAssets, fAsset, fromBlock.blockNumber, toBlock.blockNumber, usdFormatter)
        const redeemSummary = await getRedemptions(bAssets, fAsset, fromBlock.blockNumber, toBlock.blockNumber, usdFormatter)
        const redeemMultiSummary = await getMultiRedemptions(bAssets, fAsset, fromBlock.blockNumber, toBlock.blockNumber, usdFormatter)

        await snapConfig(fAsset, toBlock.blockNumber)

        await getBasket(
            fAsset,
            bAssets.map((b) => b.symbol),
            "fUSD",
            usdFormatter,
            toBlock.blockNumber,
            undefined,
            exposedValidator,
        )

        const balances = await getBalances(fAsset, accounts, usdFormatter, toBlock.blockNumber)

        await getCollectedInterest(bAssets, fAsset, savingsManager, fromBlock, toBlock, usdFormatter, balances.save)

        await snapSave("fUSD", signer, chain, toBlock.blockNumber)

        outputFees(
            mintSummary,
            mintMultiSummary,
            swapSummary,
            redeemSummary,
            redeemMultiSummary,
            balances,
            fromBlock.blockTime,
            toBlock.blockTime,
            usdFormatter,
        )
    })

task("fUSD-rates", "fUSD rate comparison to Curve")
    .addOptionalParam("block", "Block number to compare rates at. (default: current block)", 0, types.int)
    .addOptionalParam("swapSize", "Swap size to compare rates with Curve", 10000, types.float)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre)
        const chain = getChain(hre)

        const block = await getBlock(hre.ethers, taskArgs.block)
        const fAsset = await getFasset(signer, hre.network.name, block.blockNumber)

        console.log(`\nGetting rates for fUSD at block ${block.blockNumber}, ${block.blockTime}`)

        const bAssets = chain === Chain.polygon ? fUsdPolygonBassets : fUsdBassets

        console.log("      Qty Input     Output      Qty Out    Rate             Output    Rate   Diff      Arb$")
        await getSwapRates(bAssets, bAssets, fAsset, block.blockNumber, usdFormatter, BN.from(taskArgs.swapSize), chain)
        await snapConfig(fAsset, block.blockNumber)
    })

task("fUSD-BassetAdded", "Lists the BassetAdded events from a fAsset")
    .addOptionalParam("fasset", "Token symbol of fAsset. eg fUSD or mBTC", "fUSD", types.string)
    .addOptionalParam("from", "Block to query transaction events from. (default: deployment block)", 10148031, types.int)
    .addOptionalParam("to", "Block to query transaction events to. (default: current block)", 0, types.int)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre)
        const chain = await getChain(hre)

        const { fromBlock, toBlock } = await getBlockRange(hre.ethers, taskArgs.from, taskArgs.to)

        const fAsset = await getFasset(signer, hre.network.name, toBlock.blockNumber)
        const fassetManagerAddress = getChainAddress("FassetManager", chain)
        const manager = FassetManager__factory.connect(fassetManagerAddress, signer)

        const filter = await manager.filters.BassetAdded()
        filter.address = fAsset.address
        const logs = await fAsset.queryFilter(filter, fromBlock.blockNumber, toBlock.blockNumber)

        console.log(`${await fAsset.symbol()} ${fAsset.address}`)
        if (logs.length === 0)
            console.error(`Failed to find any BassetAdded events between blocks ${fromBlock.blockNumber} and ${toBlock.blockNumber}`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logs.forEach((log: any) => {
            console.log(`Basset added at block ${log.blockNumber} in tx ${log.blockHash}`)
        })
    })

module.exports = {}
