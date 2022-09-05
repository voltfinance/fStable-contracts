/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
import { FeederPool, Fasset, MV1, MV2 } from "types/generated"
import { BasketManager__factory } from "types/generated/factories/BasketManager__factory"
import { FusdEth } from "types/generated/FusdEth"
import { FusdLegacy } from "types/generated/FusdLegacy"
import { getChainAddress } from "./networkAddressFactory"
import { isFeederPool, isFusdEth, isFusdLegacy } from "./snap-utils"
import { Chain } from "./tokens"

// Get fAsset token storage variables
export const dumpTokenStorage = async (token: Fasset | FusdEth | FusdLegacy | FeederPool, toBlock: number): Promise<void> => {
    const override = {
        blockTag: toBlock,
    }
    console.log("\nSymbol  : ", (await token.symbol(override)).toString())
    console.log("Name    : ", (await token.name(override)).toString())
    console.log("Decimals: ", (await token.decimals(override)).toString())
    console.log("Supply  : ", (await token.totalSupply(override)).toString())
}

// Get bAsset storage variables
export const dumpBassetStorage = async (
    fAsset: Fasset | FusdEth | FusdLegacy | MV1 | MV2,
    block: number,
    chain = Chain.mainnet,
): Promise<void> => {
    const override = {
        blockTag: block,
    }

    console.log("\nbAssets")
    // After the fUSD upgrade to FusdV3
    if (!isFusdLegacy(fAsset)) {
        const bAssets = await fAsset.getBassets(override)
        bAssets.personal.forEach(async (personal, i) => {
            console.log(`bAsset with index ${i}`)
            console.log(` Address    :`, personal.addr.toString())
            console.log(` Integration:`, personal.integrator.toString())
            console.log(` Tx fee     :`, personal.hasTxFee.toString())
            console.log(` Status     :`, personal.status.toString())
            console.log(` Ratio      :`, bAssets[1][i].ratio.toString())
            console.log(` Vault bal  :`, bAssets[1][i].vaultBalance.toString())
            console.log("\n")
        })
    } else {
        // Before the fUSD upgrade to FusdV3 where the bAssets were in a separate Basket Manager contract
        const basketManagerAddress = getChainAddress("BasketManager", chain)
        const basketManager = BasketManager__factory.connect(basketManagerAddress, fAsset.signer)
        const basket = await basketManager.getBassets(override)
        let i = 0
        for (const bAsset of basket.bAssets) {
            console.log(`bAsset with index ${i}`)
            console.log(` Address    :`, bAsset.addr.toString())
            const integrationAddress = await basketManager.integrations(i, override)
            console.log(` Integration:`, integrationAddress)
            console.log(` Tx fee     :`, bAsset.isTransferFeeCharged.toString())
            console.log(` Status     :`, bAsset.status.toString())
            console.log(` Ratio      :`, bAsset.ratio.toString())
            console.log(` Vault bal  :`, bAsset.vaultBalance.toString())
            console.log(` Max weight :`, bAsset.maxWeight.toString())
            console.log("\n")
            i += 1
        }
    }
}

// Get fdAsset storage variables
export const dumpFassetStorage = async (pool: FeederPool, bock: number): Promise<void> => {
    const override = {
        blockTag: bock,
    }

    console.log("\nbAssets")
    const fdAssets = await pool.getBassets(override)
    fdAssets.forEach(async (_, i) => {
        console.log(`bAsset with index ${i}`)
        console.log(` Address    :`, fdAssets[0][i].addr.toString())
        console.log(` Integration:`, fdAssets[0][i].integrator.toString())
        console.log(` Tx fee     :`, fdAssets[0][i].hasTxFee.toString())
        console.log(` Status     :`, fdAssets[0][i].status.toString())
        console.log(` Ratio      :`, fdAssets[1][i].ratio.toString())
        console.log(` Vault      :`, fdAssets[1][i].vaultBalance.toString())
        console.log("\n")
    })
}

// Get Fasset storage variables
export const dumpConfigStorage = async (fAsset: Fasset | FusdEth | FusdLegacy | FeederPool, block: number): Promise<void> => {
    const override = {
        blockTag: block,
    }

    if (!isFusdLegacy(fAsset)) {
        const invariantConfig = await fAsset.getConfig(override)
        console.log("A              : ", invariantConfig.a.toString())
        console.log("Min            : ", invariantConfig.limits.min.toString())
        console.log("Max            : ", invariantConfig.limits.max.toString())
    }

    if (!isFusdEth(fAsset) && !isFusdLegacy(fAsset)) {
        // Fasset and FeederPool
        const data = await (fAsset as FeederPool).data(override)

        console.log("\nCacheSize      : ", data.cacheSize.toString())
        console.log("\nSwapFee        : ", data.swapFee.toString())
        console.log("RedemptionFee  : ", data.redemptionFee.toString())

        if (isFeederPool(fAsset)) {
            // Only FeederPools
            console.log("GovFee         : ", data.govFee.toString())
            console.log("pendingFees    : ", data.pendingFees.toString())
        }
    } else {
        // fUSD or mBTC
        console.log(
            "\nSwapFee        : ",
            (
                await fAsset.swapFee({
                    blockTag: block,
                })
            ).toString(),
        )
        console.log(
            "RedemptionFee  : ",
            (
                await fAsset.redemptionFee({
                    blockTag: block,
                })
            ).toString(),
        )
        console.log(
            "Surplus        : ",
            (
                await fAsset.surplus({
                    blockTag: block,
                })
            ).toString(),
        )
    }
}
