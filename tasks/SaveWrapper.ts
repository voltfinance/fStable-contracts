import "ts-node/register"
import "tsconfig-paths/register"
import { task, types } from "hardhat/config"

import { SaveWrapper__factory } from "../types/generated"
import { getSigner } from "./utils/signerFactory"
import { deployContract, logTxDetails } from "./utils/deploy-utils"
import { getChain, resolveAddress, resolveToken } from "./utils/networkAddressFactory"
import { verifyEtherscan } from "./utils/etherscan"

task("SaveWrapper.deploy", "Deploy a new SaveWrapper")
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const chain = getChain(hre)
        const signer = await getSigner(hre, taskArgs.speed)

        const nexusAddress = resolveAddress("Nexus", chain)

        const constructorArguments = [nexusAddress]
        const wrapper = await deployContract(new SaveWrapper__factory(signer), "SaveWrapper", constructorArguments)

        await verifyEtherscan(hre, {
            address: wrapper.address,
            contract: "contracts/savings/peripheral/SaveWrapper.sol:SaveWrapper",
            constructorArguments,
        })
    })

task("SaveWrapper.approveFasset", "Sets approvals for a new fAsset")
    .addParam("fasset", "Token symbol of the fAsset. eg fUSD or mBTC", undefined, types.string, false)
    .addParam("bassets", "Comma separated symbols of the base assets. eg USDC,DAI,USDT,sUSD", undefined, types.string, false)
    .addParam("fdAssets", "Comma separated symbols of the Feeder Pool assets. eg GUSD,BUSD,alUSD,FEI,HBTC", undefined, types.string, false)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const chain = getChain(hre)
        const signer = await getSigner(hre, taskArgs.speed)

        const wrapperAddress = resolveAddress("SaveWrapper", chain)
        const wrapper = SaveWrapper__factory.connect(wrapperAddress, signer)

        const fAssetToken = resolveToken(taskArgs.fasset, chain)

        const bAssetSymbols = taskArgs.bassets.split(",")
        const bAssetAddresses = bAssetSymbols.map((symbol) => resolveAddress(symbol, chain))

        const fdAssetSymbols = taskArgs.fdAssets.split(",")
        const fdAssetAddresses = fdAssetSymbols.map((symbol) => resolveAddress(symbol, chain, "address"))
        const feederPoolAddresses = fdAssetSymbols.map((symbol) => resolveAddress(symbol, chain, "feederPool"))

        const tx = await wrapper["approve(address,address[],address[],address[],address,address)"](
            fAssetToken.address,
            bAssetAddresses,
            feederPoolAddresses,
            fdAssetAddresses,
            fAssetToken.savings,
            fAssetToken.vault,
        )
        await logTxDetails(
            tx,
            `SaveWrapper approve fAsset ${taskArgs.fasset}, bAssets ${taskArgs.bassets} and feeder pools ${taskArgs.fdAssets}`,
        )
    })

task("SaveWrapper.approveMulti", "Sets approvals for multiple tokens/a single spender")
    .addParam(
        "tokens",
        "Comma separated symbols of the tokens that is being approved. eg USDC,DAI,USDT,sUSD",
        undefined,
        types.string,
        false,
    )
    .addParam(
        "spender",
        "Token symbol of the fAsset or address type. eg fUSD, mBTC, feederPool, savings or vault",
        undefined,
        types.string,
        false,
    )
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const chain = getChain(hre)
        const signer = await getSigner(hre, taskArgs.speed)

        const wrapperAddress = resolveAddress("SaveWrapper", chain)
        const wrapper = SaveWrapper__factory.connect(wrapperAddress, signer)

        const tokenSymbols = taskArgs.tokens.split(",")
        const tokenAddresses = tokenSymbols.map((symbol) => resolveAddress(symbol, chain))

        const spenderAddress = ["feederPool", "savings", "vault"].includes(taskArgs.spender)
            ? resolveAddress(taskArgs.token, chain, taskArgs.spender) // token is fUSD or mBTC
            : resolveAddress(taskArgs.spender, chain) // spender is fUSD or mBTC

        const tx = await wrapper["approve(address[],address)"](tokenAddresses, spenderAddress)
        await logTxDetails(tx, "Approve multiple tokens/single spender")
    })

task("SaveWrapper.approve", "Sets approvals for a single token/spender")
    .addParam("token", "Symbol of the token that is being approved. eg USDC, WBTC, FEI, HBTC, fUSD, ifUSD", undefined, types.string, false)
    .addParam(
        "spender",
        "Token symbol of the fAsset or address type. eg fUSD, mBTC, feederPool, savings or vault",
        undefined,
        types.string,
        false,
    )
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        if (!taskArgs.spender) {
            throw Error(`spender must be a fAsset symbol, eg fUSD or mBTC, or an address type of a fAsset, eg feederPool, savings or vault`)
        }
        const chain = getChain(hre)
        const signer = await getSigner(hre, taskArgs.speed)

        const wrapperAddress = resolveAddress("SaveWrapper", chain)
        const wrapper = SaveWrapper__factory.connect(wrapperAddress, signer)

        const tokenAddress = resolveAddress(taskArgs.token, chain)
        const spenderAddress = ["feederPool", "savings", "vault"].includes(taskArgs.spender)
            ? resolveAddress(taskArgs.token, chain, taskArgs.spender) // token is fUSD or mBTC
            : resolveAddress(taskArgs.spender, chain) // spender is fUSD or mBTC

        const tx = await wrapper["approve(address,address)"](tokenAddress, spenderAddress)
        await logTxDetails(tx, "Approve single token/spender")
    })

export {}
