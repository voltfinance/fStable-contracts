/* eslint-disable no-await-in-loop */
import { Signer } from "@ethersproject/abstract-signer"
import { ContractTransaction } from "ethers"
import { BN, simpleToExactAmount } from "@utils/math"
import { RevenueSplitBuyBack, IERC20Metadata__factory, Fasset__factory } from "types/generated"
import { EncodedPaths, encodeUniswapPath, getWETHPath, bestQuoteSwap } from "@utils/peripheral/uniswap"

export interface FAssetSwap {
    address: string
    bAssetMinSlippage: number
    rewardMinSlippage: number
    fAssetMinBalance: number | BN
    swapFees: number[][] // Options of fees to quote
}

export interface MainParams {
    revenueSplitBuyBack: RevenueSplitBuyBack
    fAssets: FAssetSwap[]
    blockNumber: number | string
}
export interface BuyBackRewardsParams extends MainParams {
    minBassetsAmounts: BN[]
    minRewardsAmounts: BN[]
    uniswapPaths: EncodedPaths[]
}

/**
 * Calculate the minBassetsAmounts, minRewardsAmounts and uniswapPaths to execute on the buyback rewards.
 *
 * @param {Signer} signer
 * @param {MainParams} params
 *  - fAssets: Addresses of fAssets that are to be sold for rewards. eg fUSD and mBTC.
 *  - revenueSplitBuyBackAddress: The address of the revenue split buy back contract.;

 * @return {Promise<BuyBackRewardsParams>} 
 *  - minBassetsAmounts Minimum amount of bAsset tokens to receive for each redeem of fAssets.
 * The amount uses the decimal places of the bAsset.
 * Example 1: Redeeming 10,000 fUSD with a min 2% slippage to USDC which has 6 decimal places
 * minBassetsAmounts = 10,000 fAssets * slippage 0.98 * USDC decimals 1e6 =
 * 1e4 * 0.98 * 1e6 = 1e10 * 0.98 = 98e8
 *
 * Example 2: Redeeming 1 mBTC with a min 5% slippage to WBTC which has 8 decimal places
 * minBassetsAmounts = 1 fAsset * slippage 0.95 * WBTC decimals 1e8 =
 * 0.95 * 1e8 = 95e6
 *
 *  - minRewardsAmounts Minimum amount of reward tokens received from the sale of bAssets.
 * The amount uses the decimal places of the rewards token.
 * Example 1: Swapping 10,000 USDC with a min 1% slippage to MTA which has 18 decimal places
 * minRewardsAmounts = 10,000 USDC * slippage 0.99 * MTA decimals 1e18 * MTA/USD rate 1.2
 * = 1e4 * 0.99 * 1e18 * 1.2 = 1e22 * 0.99 = 99e20
 *
 * Example 1: Swapping 1 WBTC with a min 3% slippage to MTA which has 18 decimal places
 * minRewardsAmounts = 1 WBTC * slippage 0.97 * MTA decimals 1e18 * MTA/BTC rate 0.00001
 * = 1 * 0.97 * 1e18 * 0.00001 = 0.97 * 1e13 = 97e11
 *
 *  - uniswapPaths The Uniswap V3 bytes encoded paths.
 */
export const calculateBuyBackRewardsQuote = async (signer: Signer, params: MainParams): Promise<BuyBackRewardsParams> => {
    const { revenueSplitBuyBack, fAssets, blockNumber } = params
    const fAssetsToBuyBack: FAssetSwap[] = []
    const minBassetsAmounts: BN[] = []
    const minRewardsAmounts: BN[] = []
    const uniswapPaths: EncodedPaths[] = []

    const configScale: BN = await revenueSplitBuyBack.CONFIG_SCALE()
    const treasuryFee: BN = await revenueSplitBuyBack.treasuryFee()
    const rewardsToken = await revenueSplitBuyBack.REWARDS_TOKEN()

    const rewardsTokenContract = IERC20Metadata__factory.connect(rewardsToken, signer)
    const rTokenDecimals = await rewardsTokenContract.decimals()
    const rTokenSymbol = await rewardsTokenContract.symbol()

    for (let i = 0; i < fAssets.length; i += 1) {
        const fAsset = fAssets[i]
        const bAsset: string = await revenueSplitBuyBack.bassets(fAsset.address)
        const fAssetContract = Fasset__factory.connect(fAsset.address, signer)
        const bAssetContract = IERC20Metadata__factory.connect(bAsset, signer)

        const fAssetBalance: BN = await fAssetContract.balanceOf(revenueSplitBuyBack.address)
        const fAssetSymbol: string = await fAssetContract.symbol()

        const bAssetDecimals = await bAssetContract.decimals()
        const bAssetSymbol: string = await bAssetContract.symbol()
        // Validate if the fAsset balance is grater than the minimum balance to buy back, default is zero.
        if (fAssetBalance.gt(fAsset.fAssetMinBalance)) {
            // fAssetAmount =  10000e18 * (1e18 - 0.4e18  / 1e18) = 6000e18
            const fAssetAmount = fAssetBalance.mul(configScale.sub(treasuryFee)).div(configScale)

            // calculate minBassetsAmounts
            const bAssetSlippage = 100 - fAsset.bAssetMinSlippage
            // fAssetAmount =  6000e18 * (98/100)/1e18 * 1e6 = 5880e6 (USDC)
            const minBassetsAmount = fAssetAmount
                .mul(bAssetSlippage)
                .div(100)
                .div(simpleToExactAmount(1))
                .mul(simpleToExactAmount(1, bAssetDecimals))
            minBassetsAmounts.push(minBassetsAmount)
            fAssetsToBuyBack.push(fAsset)

            // Get the estimated redeem amount to price better the second swap, bAsset to reward.
            const bAssetRedeemAmount = await fAssetContract.getRedeemOutput(bAsset, fAssetAmount)
            // console for debugging purposes, do not delete

            console.table({
                fAssetSymbol,
                fAssetBalance: fAssetBalance.toString(),
                configScale: configScale.toString(),
                treasuryFee: treasuryFee.toString(),
                bAssetSlippage: bAssetSlippage.toString(),
                bAssetDecimals: bAssetDecimals.toString(),
                fAssetAmount: fAssetAmount.toString(),
                minBassetsAmount: minBassetsAmount.toString(),
                bAssetRedeemAmount: bAssetRedeemAmount.toString(),
                swapFees: fAsset.swapFees.toString(),
            })

            // 2 ============ minRewardsAmount ============//

            const fromToken = { address: bAsset, decimals: bAssetDecimals }
            const toToken = { address: rewardsToken, decimals: rTokenDecimals }

            // Get the best quote possible
            // eslint-disable-next-line no-await-in-loop
            const { outAmount, exchangeRate, fees } = await bestQuoteSwap(
                signer,
                fromToken,
                toToken,
                bAssetRedeemAmount,
                blockNumber,
                fAsset.swapFees,
            )
            const rewardSlippage = 100 - fAsset.rewardMinSlippage
            // minRewardsAmount =  5880e6 * (98/100) /1e6 * 1e18 = 5880e6 (USDC)
            // quote out amount  of reward tokens with its decimals.
            const minRewardsAmount = outAmount.mul(rewardSlippage).div(100)

            minRewardsAmounts.push(minRewardsAmount)

            // console for debugging purposes, do not delete
            console.table({
                bAssetSymbol,
                rTokenSymbol,
                rewardSlippage: rewardSlippage.toString(),
                fAssetAmount: fAssetAmount.toString(),
                minBassetsAmount: minBassetsAmount.toString(),
                minRewardsAmount: minRewardsAmount.toString(),
                outAmount: outAmount.toString(),
                exchangeRate: exchangeRate.toString(),
                bAssetDecimals: bAssetDecimals.toString(),
                rTokenDecimals: rTokenDecimals.toString(),
                bestFees: fees.toString(),
            })

            // 3 ============ Uniswap path ============//
            const uniswapPath = encodeUniswapPath(getWETHPath(bAsset, rewardsToken), fees)
            uniswapPaths.push(uniswapPath)
            console.log(`ts: swap ${bAssetSymbol} to ${rTokenSymbol}, encodeUniswapPath: ${uniswapPath.encoded.toString()}`)
        }
    }
    return { ...params, fAssets: fAssetsToBuyBack, minBassetsAmounts, minRewardsAmounts, uniswapPaths }
}
/**
 * Execute the buyback rewards of different fAssets.
 *
 * @param {Signer} signer
 * @param {MainParams} params
 * @return {*}  {Promise<ContractTransaction>}
 */
export const splitBuyBackRewards = async (signer: Signer, params: MainParams): Promise<ContractTransaction> => {
    const buyBackRewardsParams = await calculateBuyBackRewardsQuote(signer, params)
    const { fAssets, minBassetsAmounts, minRewardsAmounts, uniswapPaths, revenueSplitBuyBack } = buyBackRewardsParams
    const fAssetAddress = fAssets.map((m) => m.address)
    const uniswapPathsEncoded = uniswapPaths.map((u) => u.encoded)
    console.log(`ts: buyBackRewards 
        fAssetAddress       ${fAssetAddress}
        minBassetsAmounts   ${minBassetsAmounts.toString()}
        minRewardsAmounts   ${minRewardsAmounts.toString()}
        uniswapPathsEncoded ${uniswapPathsEncoded}
    `)
    return revenueSplitBuyBack.buyBackRewards(fAssetAddress, minBassetsAmounts, minRewardsAmounts, uniswapPathsEncoded)
}
