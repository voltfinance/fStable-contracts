import "ts-node/register"
import "tsconfig-paths/register"
import { task, types } from "hardhat/config"
import { Signer } from "ethers"

import {
    ERC20__factory,
    FeederPool,
    FeederPool__factory,
    FeederWrapper__factory,
    IERC20__factory,
    InterestValidator__factory,
    Fasset,
    SavingsManager__factory,
} from "types/generated"
import { BN, simpleToExactAmount } from "@utils/math"
import { formatUnits } from "ethers/lib/utils"
import { dumpConfigStorage, dumpFassetStorage, dumpTokenStorage } from "./utils/storage-utils"
import {
    getMultiRedemptions,
    Balances,
    getBlock,
    getBlockRange,
    getBasket,
    snapConfig,
    getMints,
    getMultiMints,
    getSwaps,
    getRedemptions,
    outputFees,
    getCollectedInterest,
} from "./utils/snap-utils"
import { Chain, PFRAX, PfUSD, Token, tokens } from "./utils/tokens"
import { btcFormatter, QuantityFormatter, usdFormatter } from "./utils/quantity-formatters"
import { getSwapRates } from "./utils/rates-utils"
import { getSigner } from "./utils/signerFactory"
import { logTxDetails } from "./utils"
import { getChain, getChainAddress, resolveAddress, resolveToken } from "./utils/networkAddressFactory"
import { params } from "./utils/params"

const getBalances = async (
    feederPool: Fasset | FeederPool,
    block: number,
    asset: Token,
    quantityFormatter: QuantityFormatter,
): Promise<Balances> => {
    const feederPoolBalance = await feederPool.totalSupply({
        blockTag: block,
    })
    const vaultBalance = await feederPool.balanceOf(asset.vault, {
        blockTag: block,
    })
    const otherBalances = feederPoolBalance.sub(vaultBalance)

    console.log("\nHolders")
    console.log(`Vault                      ${quantityFormatter(vaultBalance)} ${vaultBalance.mul(100).div(feederPoolBalance)}%`)
    console.log(`Others                     ${quantityFormatter(otherBalances)} ${otherBalances.mul(100).div(feederPoolBalance)}%`)
    console.log(`Total                      ${quantityFormatter(feederPoolBalance)}`)

    return {
        total: feederPoolBalance,
        save: vaultBalance,
        earn: BN.from(0),
    }
}

const getFeederPool = (signer: Signer, contractAddress: string, chain = Chain.mainnet): FeederPool => {
    const linkedAddress = {
        "contracts/feeders/FeederLogic.sol:FeederLogic": getChainAddress("FeederLogic", chain),
        "contracts/feeders/FeederManager.sol:FeederManager": getChainAddress("FeederManager", chain),
    }
    const feederPoolFactory = new FeederPool__factory(linkedAddress, signer)
    return feederPoolFactory.attach(contractAddress)
}

const getQuantities = (fdAsset: Token, _swapSize?: number): { quantityFormatter: QuantityFormatter; swapSize: number } => {
    let quantityFormatter: QuantityFormatter
    let swapSize: number
    if (fdAsset.quantityFormatter === "USD") {
        quantityFormatter = usdFormatter
        swapSize = _swapSize || 10000
    } else if (fdAsset.quantityFormatter === "BTC") {
        quantityFormatter = btcFormatter
        swapSize = _swapSize || 1
    }
    return {
        quantityFormatter,
        swapSize,
    }
}

task("feeder-storage", "Dumps feeder contract storage data")
    .addOptionalParam("block", "Block number to get storage from. (default: current block)", 0, types.int)
    .addParam("fdAsset", "Token symbol of the feeder pool asset.  eg HBTC, TBTC, GUSD or BUSD", undefined, types.string, false)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)

        const fdAsset = tokens.find((t) => t.symbol === taskArgs.fdAsset)
        if (!fdAsset) {
            console.error(`Failed to find feeder pool asset with token symbol ${taskArgs.fdAsset}`)
            process.exit(1)
        }

        const { blockNumber } = await getBlock(hre.ethers, taskArgs.block)

        const pool = getFeederPool(signer, fdAsset.feederPool, chain)

        await dumpTokenStorage(pool, blockNumber)
        await dumpFassetStorage(pool, blockNumber)
        await dumpConfigStorage(pool, blockNumber)
    })

task("feeder-snap", "Gets feeder transactions over a period of time")
    .addOptionalParam("from", "Block to query transaction events from. (default: deployment block)", 12146627, types.int)
    .addOptionalParam("to", "Block to query transaction events to. (default: current block)", 0, types.int)
    .addParam("fdAsset", "Token symbol of the feeder pool asset. eg HBTC, TBTC, GUSD or BUSD", undefined, types.string, false)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)
        const { fromBlock, toBlock } = await getBlockRange(hre.ethers, taskArgs.from, taskArgs.to)

        const fdAsset = tokens.find((t) => t.symbol === taskArgs.fdAsset)
        if (!fdAsset) {
            console.error(`Failed to find feeder pool asset with token symbol ${taskArgs.fdAsset}`)
            process.exit(1)
        }
        console.log(`\nGetting snap for feeder pool ${fdAsset.symbol} from block ${fromBlock.blockNumber}, to ${toBlock.blockNumber}`)
        const fAsset = tokens.find((t) => t.symbol === fdAsset.parent)
        const fpAssets = [fAsset, fdAsset]

        const feederPool = getFeederPool(signer, fdAsset.feederPool)
        const savingsManagerAddress = getChainAddress("SavingsManager", chain)
        const savingsManager = SavingsManager__factory.connect(savingsManagerAddress, signer)

        const { quantityFormatter } = getQuantities(fdAsset, taskArgs.swapSize)

        const mintSummary = await getMints(tokens, feederPool, fromBlock.blockNumber, toBlock.blockNumber, quantityFormatter)
        const mintMultiSummary = await getMultiMints(tokens, feederPool, fromBlock.blockNumber, toBlock.blockNumber, quantityFormatter)
        const swapSummary = await getSwaps(tokens, feederPool, fromBlock.blockNumber, toBlock.blockNumber, quantityFormatter)
        const redeemSummary = await getRedemptions(tokens, feederPool, fromBlock.blockNumber, toBlock.blockNumber, quantityFormatter)
        const redeemMultiSummary = await getMultiRedemptions(
            tokens,
            feederPool,
            fromBlock.blockNumber,
            toBlock.blockNumber,
            quantityFormatter,
        )

        await snapConfig(feederPool, toBlock.blockNumber)
        await getBasket(
            feederPool,
            fpAssets.map((b) => b.symbol),
            fAsset.symbol,
            usdFormatter,
            toBlock.blockNumber,
        )

        const balances = await getBalances(feederPool, toBlock.blockNumber, fdAsset, quantityFormatter)

        await getCollectedInterest(fpAssets, feederPool, savingsManager, fromBlock, toBlock, quantityFormatter, balances.save)

        const data = await feederPool.data()
        console.log(`\nPending gov fees ${quantityFormatter(data.pendingFees)}`)

        outputFees(
            mintSummary,
            mintMultiSummary,
            swapSummary,
            redeemSummary,
            redeemMultiSummary,
            balances,
            fromBlock.blockTime,
            toBlock.blockTime,
            quantityFormatter,
        )
    })

task("feeder-rates", "Feeder rate comparison to Curve")
    .addOptionalParam("block", "Block number to compare rates at. (default: current block)", 0, types.int)
    .addOptionalParam("swapSize", "Swap size to compare rates with Curve", undefined, types.float)
    .addParam("fdAsset", "Token symbol of the feeder pool asset. eg HBTC, TBTC, GUSD or BUSD", undefined, types.string, false)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre)
        const chain = getChain(hre)

        const block = await getBlock(hre.ethers, taskArgs.block)

        const fdAsset = tokens.find((t) => t.symbol === taskArgs.fdAsset)
        if (!fdAsset) {
            console.error(`Failed to find feeder pool asset with token symbol ${taskArgs.fdAsset}`)
            process.exit(1)
        }
        console.log(`\nGetting rates for feeder pool ${fdAsset.symbol} at block ${block.blockNumber}, ${block.blockTime}`)
        const feederPool = getFeederPool(signer, fdAsset.feederPool)

        const fAsset = tokens.find((t) => t.symbol === fdAsset.parent)
        const fpAssets = [fAsset, fdAsset]

        // Get the bAssets for the main pool. eg bAssets in fUSD or mBTC
        // These are the assets that are not feeder pools and parent matches the fdAsset's parent
        const mpAssets = tokens.filter((t) => t.parent === fdAsset.parent && !t.feederPool)

        const { quantityFormatter, swapSize } = getQuantities(fdAsset, taskArgs.swapSize)

        console.log("      Qty Input     Output      Qty Out    Rate             Output    Rate   Diff      Arb$")
        await getSwapRates(fpAssets, fpAssets, feederPool, block.blockNumber, quantityFormatter, swapSize, chain)
        await getSwapRates([fdAsset], mpAssets, feederPool, block.blockNumber, quantityFormatter, swapSize, chain)
        await getSwapRates(mpAssets, [fdAsset], feederPool, block.blockNumber, quantityFormatter, swapSize, chain)
        await snapConfig(feederPool, block.blockNumber)
    })

task("frax-post-deploy", "Mint FRAX Feeder Pool")
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs)

        const frax = ERC20__factory.connect(PFRAX.address, signer)
        const fraxFp = FeederPool__factory.connect(PFRAX.feederPool, signer)
        const fusd = await IERC20__factory.connect(PfUSD.address, signer)

        const approveAmount = simpleToExactAmount(100)
        const bAssetAmount = simpleToExactAmount(10)
        const minAmount = simpleToExactAmount(9)

        let tx = await frax.approve(PFRAX.feederPool, approveAmount)
        await logTxDetails(tx, "approve FRAX")

        tx = await fusd.approve(PFRAX.feederPool, approveAmount)
        await logTxDetails(tx, "approve fUSD")

        tx = await fraxFp.mintMulti([PFRAX.address, PfUSD.address], [bAssetAmount, bAssetAmount], minAmount, await signer.getAddress())
        await logTxDetails(tx, "mint FRAX FP")
    })

task("FeederWrapper-approveAll", "Sets approvals for a Feeder Pool")
    // TODO replace these params with Token symbol
    .addParam("feeder", "Feeder Pool address", undefined, params.address, false)
    .addParam("vault", "BoostedVault contract address", undefined, params.address, false)
    .addParam("assets", "Asset addresses", undefined, params.addressArray, false)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const deployer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)

        const feederWrapperAddress = getChainAddress("FeederWrapper", chain)
        const feederWrapper = FeederWrapper__factory.connect(feederWrapperAddress, deployer)

        const tx = await feederWrapper["approve(address,address,address[])"](taskArgs.feeder, taskArgs.vault, taskArgs.assets)
        await logTxDetails(tx, "Approve Feeder/Vault and other assets")
    })

task("FeederWrapper-approveMulti", "Sets approvals for multiple tokens/a single spender")
    .addParam("tokens", "Token addresses", undefined, params.address, false)
    .addParam("spender", "Spender address", undefined, params.address, false)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const deployer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)

        const feederWrapperAddress = getChainAddress("FeederWrapper", chain)
        const feederWrapper = FeederWrapper__factory.connect(feederWrapperAddress, deployer)

        const tx = await feederWrapper["approve(address[],address)"](taskArgs.tokens, taskArgs.spender)
        await logTxDetails(tx, "Approve muliple tokens/single spender")
    })

task("FeederWrapper-approve", "Sets approvals for a single token/spender")
    .addParam("feederWrapper", "FeederWrapper address", undefined, params.address, false)
    .addParam("token", "Token address", undefined, params.address, false)
    .addParam("spender", "Spender address", undefined, params.address, false)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const deployer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)

        const feederWrapperAddress = getChainAddress("FeederWrapper", chain)

        const feederWrapper = FeederWrapper__factory.connect(feederWrapperAddress, deployer)

        const tx = await feederWrapper["approve(address,address)"](taskArgs.tokens, taskArgs.spender)
        await logTxDetails(tx, "Approve single token/spender")
    })

task("feeder-mint", "Mint some Feeder Pool tokens")
    .addOptionalParam("amount", "Amount of the fAsset and fdAsset to deposit", undefined, types.float)
    .addParam("fdAsset", "Token symbol of the feeder pool asset. eg HBTC, GUSD, PFRAX or alUSD", undefined, types.string)
    .addOptionalParam("single", "Only mint using fdAsset. If false, does a multi mint using fdAsset and fasset", false, types.boolean)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)
        const signerAddress = await signer.getAddress()

        const fdAssetSymbol = taskArgs.fdAsset
        const feederPoolToken = tokens.find((t) => t.symbol === fdAssetSymbol && t.chain === chain)
        if (!feederPoolToken) throw Error(`Could not find feeder pool asset token with symbol ${fdAssetSymbol}`)
        if (!feederPoolToken.feederPool) throw Error(`No feeder pool configured for token ${fdAssetSymbol}`)

        const fAssetSymbol = feederPoolToken.parent
        if (!fAssetSymbol) throw Error(`No parent fAsset configured for feeder pool asset ${fAssetSymbol}`)
        const fAssetToken = tokens.find((t) => t.symbol === fAssetSymbol && t.chain === chain)
        if (!fAssetToken) throw Error(`Could not find fAsset token with symbol ${fAssetToken}`)

        const fp = FeederPool__factory.connect(feederPoolToken.feederPool, signer)
        const fpSymbol = await fp.symbol()

        const mintAmount = simpleToExactAmount(taskArgs.amount)

        if (taskArgs.single) {
            // mint Feeder Pool tokens
            const tx = await fp.mint(feederPoolToken.address, mintAmount, 0, signerAddress)
            await logTxDetails(tx, `Mint ${fpSymbol} from ${formatUnits(mintAmount)} ${fdAssetSymbol}`)
        } else {
            // multi mint Feeder Pool tokens
            const tx = await fp.mintMulti([fAssetToken.address, feederPoolToken.address], [mintAmount, mintAmount], 0, signerAddress)
            await logTxDetails(
                tx,
                `Multi mint ${fpSymbol} from ${formatUnits(mintAmount)} ${fAssetSymbol} and ${formatUnits(mintAmount)} ${fdAssetSymbol}`,
            )
        }
    })

task("feeder-redeem", "Redeem some Feeder Pool tokens")
    .addParam("fdAsset", "Token symbol of the feeder pool asset. eg HBTC, GUSD, PFRAX or alUSD", undefined, types.string)
    .addParam("amount", "Amount of the feeder pool liquidity tokens to proportionately redeem", undefined, types.float)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)
        const signerAddress = await signer.getAddress()

        const fdAssetSymbol = taskArgs.fdAsset
        const feederPoolToken = tokens.find((t) => t.symbol === fdAssetSymbol && t.chain === chain)
        if (!feederPoolToken) throw Error(`Could not find feeder pool asset token with symbol ${fdAssetSymbol}`)
        if (!feederPoolToken.feederPool) throw Error(`No feeder pool configured for token ${fdAssetSymbol}`)

        const fp = FeederPool__factory.connect(feederPoolToken.feederPool, signer)
        const fpSymbol = await fp.symbol()

        const fpAmount = simpleToExactAmount(taskArgs.amount)
        const minBassetAmount = fpAmount.mul(40).div(100) // min 40% for each bAsset

        // redeem Feeder Pool tokens
        const tx = await fp.redeemProportionately(fpAmount, [minBassetAmount, minBassetAmount], signerAddress)
        await logTxDetails(tx, `Redeem ${fpSymbol} from ${formatUnits(fpAmount)}`)
    })

task("feeder-swap", "Swap some Feeder Pool tokens")
    .addParam("input", "Token symbol of the input token to the swap. eg fUSD, mBTC, HBTC, GUSD, FRAX or alUSD", undefined, types.string)
    .addParam("output", "Token symbol of the output token from the swap. eg fUSD, mBTC, HBTC, GUSD, FRAX or alUSD", undefined, types.string)
    .addParam("amount", "Amount of input tokens to swap", undefined, types.float)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)
        const signerAddress = await signer.getAddress()

        const inputSymbol = taskArgs.input
        const inputToken = tokens.find((t) => t.symbol === inputSymbol && t.chain === chain)
        if (!inputToken) throw Error(`Could not find input asset token with symbol ${inputSymbol}`)

        const outputSymbol = taskArgs.output
        const outputToken = tokens.find((t) => t.symbol === outputSymbol && t.chain === chain)
        if (!outputToken) throw Error(`Could not find output asset token with symbol ${outputSymbol}`)

        let fp: FeederPool
        if (inputToken.feederPool && !outputToken.feederPool) {
            fp = FeederPool__factory.connect(inputToken.feederPool, signer)
        } else if (!inputToken.feederPool && outputToken.feederPool) {
            fp = FeederPool__factory.connect(outputToken.feederPool, signer)
        } else {
            throw Error(`Could not find Feeder Pool for input ${inputSymbol} and output ${outputSymbol}`)
        }

        const fpSymbol = await fp.symbol()

        const inputAmount = simpleToExactAmount(taskArgs.amount)
        const minOutputAmount = inputAmount.mul(90).div(100) // min 90% of the input

        const tx = await fp.swap(inputToken.address, outputToken.address, inputAmount, minOutputAmount, signerAddress)
        await logTxDetails(tx, `swap ${formatUnits(inputAmount)} ${inputSymbol} for ${outputSymbol} using ${fpSymbol} Feeder Pool`)
    })

task("feeder-collect-interest", "Collects interest from feeder pools")
    .addOptionalParam("fdAsset", "Token symbol of feeder pool. eg HBTC, alUSD or PFRAX", undefined, types.string)
    .addOptionalParam(
        "fdAssets",
        "Comma separated token symbols of feeder pools . eg HBTC,alUSD or PFRAX",
        "GUSD,BUSD,alUSD,RAI,FEI",
        types.string,
    )
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "average", types.string)
    .setAction(async (taskArgs, hre) => {
        const chain = getChain(hre)
        const signer = await getSigner(hre, taskArgs.speed)

        let fdAssetAddresses: string[]
        if (taskArgs.fdAsset) {
            fdAssetAddresses = [resolveAddress(taskArgs.fdAsset, chain, "feederPool")]
        } else if (taskArgs.fdAssets) {
            const fdAssetSymbols = taskArgs.fdAssets.split(",")
            fdAssetAddresses = fdAssetSymbols.map((symbol) => resolveAddress(symbol, chain, "feederPool"))
        } else throw Error(`Missing fdAsset or fdAssets command line option`)

        const interestValidatorAddress = resolveAddress("FeederInterestValidator", chain)
        const validator = InterestValidator__factory.connect(interestValidatorAddress, signer)

        const lastBatchCollected = await validator.lastBatchCollected(fdAssetAddresses[0])
        const lastBatchDate = new Date(lastBatchCollected.mul(1000).toNumber())
        console.log(`The last interest collection was ${lastBatchDate}, epoch ${lastBatchCollected} seconds`)

        const currentEpoch = new Date().getTime() / 1000
        if (currentEpoch - lastBatchCollected.toNumber() < 60 * 60 * 12) {
            console.error(`Can not run again as the last run was less then 12 hours ago`)
            process.exit(3)
        }

        const tx = await validator.collectAndValidateInterest(fdAssetAddresses)
        await logTxDetails(tx, `collect interest from ${fdAssetAddresses} Feeder Pools`)
    })

task("feeder-collect-fees", "Collects governance fees from feeder pools")
    .addParam("fdAsset", "Token symbol of feeder pool. eg HBTC, alUSD or PFRAX", undefined, types.string, false)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "average", types.string)
    .setAction(async (taskArgs, hre) => {
        const chain = getChain(hre)
        const signer = await getSigner(hre, taskArgs.speed)

        const fpAddress = resolveAddress(taskArgs.fdAsset, chain, "feederPool")

        const interestValidatorAddress = resolveAddress("FeederInterestValidator", chain)
        const validator = InterestValidator__factory.connect(interestValidatorAddress, signer)

        const tx = await validator.collectGovFees([fpAddress])
        await logTxDetails(tx, `collect gov fees from ${taskArgs.fdAsset} FP`)
    })

task("feeder-migrate-bassets", "Migrates bAssets in a Feeder Pool to its integration contract")
    .addParam("fdAsset", "Token symbol of feeder pool. eg HBTC, alUSD, FRAX or RAI", undefined, types.string, false)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "average", types.string)
    .setAction(async (taskArgs, hre) => {
        const chain = getChain(hre)
        const signer = await getSigner(hre, taskArgs.speed)

        const fpToken = resolveToken(taskArgs.fdAsset, chain, "feederPool")
        const feederPool = FeederPool__factory.connect(fpToken.feederPool, signer)

        const tx = await feederPool.migrateBassets([fpToken.address], fpToken.integrator)

        await logTxDetails(tx, `migrate ${taskArgs.fdAsset} feeder pool bAssets`)
    })

module.exports = {}
