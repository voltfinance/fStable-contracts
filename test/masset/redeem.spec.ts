import { expect } from "chai"
import { ethers } from "hardhat"
import { Signer } from "ethers"

import { simpleToExactAmount, BN } from "@utils/math"
import { FassetDetails, FassetMachine, StandardAccounts } from "@utils/machines"
import { MockERC20, Fasset } from "types/generated"
import { fullScale, ZERO_ADDRESS } from "@utils/constants"
import { assertBasketIsHealthy, assertBNClosePercent, assertBNSlightlyGTPercent } from "@utils/assertions"
import { BassetStatus } from "@utils/mstable-objects"
import { Account } from "types"

describe("Fasset - Redeem", () => {
    let sa: StandardAccounts
    let fAssetMachine: FassetMachine
    let details: FassetDetails

    /**
     * @dev (Re)Sets the local variables for this test file
     * @param seedBasket mints 25 tokens for each bAsset
     * @param useTransferFees enables transfer fees on bAssets [2,3]
     */
    const runSetup = async (
        seedBasket = true,
        useTransferFees = false,
        useLendingMarkets = false,
        weights: number[] = [25, 25, 25, 25],
    ): Promise<void> => {
        details = await fAssetMachine.deployFasset(useLendingMarkets, useTransferFees)
        if (seedBasket) {
            await fAssetMachine.seedWithWeightings(details, weights)
        }
    }

    before("Init contract", async () => {
        const accounts = await ethers.getSigners()
        fAssetMachine = await new FassetMachine().initAccounts(accounts)
        sa = fAssetMachine.sa
        await runSetup()
    })

    const assertFailedBasicRedemption = async (
        expectedReason: string,
        fAssetContract: Fasset,
        bAsset: MockERC20 | string,
        fAssetRedeemQuantity: BN | number | string,
        minBassetOutput: BN | number | string = BN.from(0),
        sender: Signer = sa.default.signer,
        recipient: string = sa.default.address,
        quantitiesAreExact = false,
        redeemOutputRevertExpected = true,
        expectedBassetQuantity: BN | number | string = BN.from(0),
    ): Promise<void> => {
        const fAsset = fAssetContract.connect(sender)
        const bAssetAddress = typeof bAsset === "string" ? bAsset : bAsset.address
        const bAssetDecimals = typeof bAsset === "string" ? 18 : await bAsset.decimals()
        const fAssetRedeemQuantityExact = quantitiesAreExact ? BN.from(fAssetRedeemQuantity) : simpleToExactAmount(fAssetRedeemQuantity, 18)
        const minBassetOutputExact = quantitiesAreExact ? BN.from(minBassetOutput) : simpleToExactAmount(minBassetOutput, bAssetDecimals)
        const expectedBassetQuantityExact = quantitiesAreExact
            ? BN.from(expectedBassetQuantity)
            : simpleToExactAmount(expectedBassetQuantity, bAssetDecimals)
        await expect(
            fAsset.redeem(bAssetAddress, fAssetRedeemQuantityExact, minBassetOutputExact, recipient),
            `redeem tx should revert with "${expectedReason}"`,
        ).to.be.revertedWith(expectedReason)

        if (redeemOutputRevertExpected) {
            await expect(
                fAsset.getRedeemOutput(bAssetAddress, fAssetRedeemQuantityExact),
                `getRedeemOutput call should revert with "${expectedReason}"`,
            ).to.be.revertedWith(expectedReason)
        } else {
            const redeemedBassetQuantity = await fAsset.getRedeemOutput(bAssetAddress, fAssetRedeemQuantityExact)
            assertBNClosePercent(redeemedBassetQuantity, expectedBassetQuantityExact, "0.1", "getRedeemOutput call output")
        }
    }
    const assertFailedFassetRedemption = async (
        expectedReason: string,
        fAssetContract: Fasset,
        fAssetQuantity: BN | number | string,
        minBassetQuantitiesNet: (BN | number | string)[] = [0, 0, 0, 0],
        bAssets: MockERC20[],
        sender: Signer = sa.default.signer,
        recipient: string = sa.default.address,
        quantitiesAreExact = false,
    ): Promise<void> => {
        const fAsset = fAssetContract.connect(sender)
        const bAssetsDecimals = await Promise.all(bAssets.map((bAsset) => bAsset.decimals()))
        const fAssetQuantityExact = quantitiesAreExact ? BN.from(fAssetQuantity) : simpleToExactAmount(fAssetQuantity, 18)
        const minBassetQuantitiesExact = quantitiesAreExact
            ? minBassetQuantitiesNet.map((q) => BN.from(q))
            : minBassetQuantitiesNet.map((q, i) => simpleToExactAmount(q, bAssetsDecimals[i]))
        await expect(
            fAsset.redeemFasset(fAssetQuantityExact, minBassetQuantitiesExact, recipient),
            `redeem tx should revert with "${expectedReason}"`,
        ).to.be.revertedWith(expectedReason)
    }
    const assertFailedExactBassetsRedemption = async (
        expectedReason: string,
        fAssetContract: Fasset,
        bAssets: (MockERC20 | string)[],
        bAssetRedeemQuantities: (BN | number | string)[],
        maxFassetBurntQuantity: BN | number | string = 100,
        sender: Signer = sa.default.signer,
        recipient: string = sa.default.address,
        quantitiesAreExact = false,
        redeemOutputRevertExpected = true,
        expectedFassetQuantityExact: BN | number | string = BN.from(1),
    ): Promise<void> => {
        const fAsset = fAssetContract.connect(sender)
        const bAssetAddresses = bAssets.map((bAsset) => (typeof bAsset === "string" ? bAsset : bAsset.address))
        const bAssetsDecimals = await Promise.all(
            bAssets.map((bAsset) => (typeof bAsset === "string" ? Promise.resolve(18) : bAsset.decimals())),
        )
        // Convert to exact quantities
        const bAssetRedeemQuantitiesExact = quantitiesAreExact
            ? bAssetRedeemQuantities.map((q) => BN.from(q))
            : bAssetRedeemQuantities.map((q, i) => simpleToExactAmount(q, bAssetsDecimals[i]))
        const maxFassetBurntQuantityExact = quantitiesAreExact
            ? BN.from(maxFassetBurntQuantity)
            : simpleToExactAmount(maxFassetBurntQuantity, 18)

        await expect(
            fAsset.redeemExactBassets(bAssetAddresses, bAssetRedeemQuantitiesExact, maxFassetBurntQuantityExact, recipient),
            `redeem tx should revert with "${expectedReason}"`,
        ).to.be.revertedWith(expectedReason)

        if (redeemOutputRevertExpected) {
            await expect(
                fAsset.getRedeemExactBassetsOutput(bAssetAddresses, bAssetRedeemQuantitiesExact),
                `getRedeemExactBassetsOutput call should revert with "${expectedReason}"`,
            ).to.be.revertedWith(expectedReason)
        } else {
            const redeemedFassetQuantity = await fAsset.getRedeemExactBassetsOutput(bAssetAddresses, bAssetRedeemQuantitiesExact)
            assertBNClosePercent(
                redeemedFassetQuantity,
                BN.from(expectedFassetQuantityExact),
                "0.1",
                "getRedeemExactBassetsOutput call output",
            )
        }
    }

    // Helper to assert basic redemption conditions, e.g. balance before and after
    // redeem takes fAsset input and returns bAsset amount
    const assertBasicRedemption = async (
        md: FassetDetails,
        bAsset: MockERC20,
        fAssetBurnQuantity: BN | number | string,
        minBassetOutput: BN | number | string = 0,
        expectFee = true,
        recipient: string = sa.default.address,
        sender: Account = sa.default,
        ignoreHealthAssertions = false,
        quantitiesAreExact = false,
        hasTransferFee = false,
    ): Promise<BN> => {
        const { platform } = md
        const fAsset = md.fAsset.connect(sender.signer)
        if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)

        // Get balances before
        const senderFassetBalBefore = await fAsset.balanceOf(sender.address)
        const fAssetSupplyBefore = await fAsset.totalSupply()
        const recipientBassetBalBefore = await bAsset.balanceOf(recipient)
        const bAssetBefore = await fAssetMachine.getBasset(details, bAsset.address)
        const bAssetDecimals = await bAsset.decimals()
        const fAssetQuantityExact = quantitiesAreExact ? BN.from(fAssetBurnQuantity) : simpleToExactAmount(fAssetBurnQuantity, 18)
        const minBassetOutputExact = quantitiesAreExact ? BN.from(minBassetOutput) : simpleToExactAmount(minBassetOutput, bAssetDecimals)
        const { surplus: surplusBefore, swapFee: feeRate } = await fAsset.data()

        let scaledFee = BN.from(0)
        //    If there is a fee expected, then deduct it from output
        if (expectFee) {
            expect(feeRate, "fee rate > 0").gt(0)
            expect(feeRate, "fee rate < fullScale / 50").lt(fullScale.div(50))
            scaledFee = fAssetQuantityExact.mul(feeRate).div(fullScale)
        }

        const bAssetQuantityExact = await fAsset.getRedeemOutput(bAsset.address, fAssetQuantityExact)

        const platformInteraction = await FassetMachine.getPlatformInteraction(fAsset, "withdrawal", bAssetQuantityExact, bAssetBefore)

        // Execute the redemption
        const tx = fAsset.redeem(bAsset.address, fAssetQuantityExact, minBassetOutputExact, recipient)
        // const integratorBalBefore = await bAssetBefore.contract.balanceOf(
        //     bAssetBefore.integrator ? bAssetBefore.integratorAddr : fAsset.address,
        // )

        // Check the emitted events
        await expect(tx)
            .to.emit(fAsset, "Redeemed")
            .withArgs(sender.address, recipient, fAssetQuantityExact, bAsset.address, bAssetQuantityExact, scaledFee)
        // - Withdraws from lending platform or fAsset
        if (platformInteraction.expectInteraction) {
            await expect(tx, "PlatformWithdrawal event").to.emit(platform, "PlatformWithdrawal")
            // .withArgs(bAsset.address, bAssetBefore.pToken, platformInteraction.amount, bAssetQuantityExact)
        } else if (platformInteraction.hasLendingMarket) {
            await expect(tx, "Withdrawal event").to.emit(platform, "Withdrawal").withArgs(bAsset.address, bAssetQuantityExact)
        }
        // Transfer events
        await expect(tx, "Transfer event to burn the redeemed fAssets")
            .to.emit(fAsset, "Transfer")
            .withArgs(sender.address, ZERO_ADDRESS, fAssetQuantityExact)
        if (!hasTransferFee) {
            await expect(tx, "Transfer event for bAsset from platform integration or fAsset to recipient")
                .to.emit(bAsset, "Transfer")
                .withArgs(bAssetBefore.integrator ? bAssetBefore.integratorAddr : fAsset.address, recipient, bAssetQuantityExact)
        }
        await tx

        // VaultBalance should line up
        // const integratorBalAfter = await bAssetBefore.contract.balanceOf(
        //     bAssetBefore.integrator ? bAssetBefore.integratorAddr : fAsset.address,
        // )
        // Calculate after balance
        // expect(integratorBalAfter, "integratorBalAfter").eq(integratorBalBefore.sub(bAssetQuantityExact))
        // Sender should have less fAsset
        const senderFassetBalAfter = await fAsset.balanceOf(sender.address)
        expect(senderFassetBalAfter, "senderFassetBalAfter").eq(senderFassetBalBefore.sub(fAssetQuantityExact))
        // Total fAsset supply should be less
        const fAssetSupplyAfter = await fAsset.totalSupply()
        expect(fAssetSupplyAfter, "fAssetSupplyAfter").eq(fAssetSupplyBefore.sub(fAssetQuantityExact))
        // Recipient should have more bAsset, minus fee

        if (!hasTransferFee) {
            const recipientBassetBalAfter = await bAsset.balanceOf(recipient)
            expect(recipientBassetBalAfter, "recipientBassetBalAfter").eq(recipientBassetBalBefore.add(bAssetQuantityExact))
        }
        // VaultBalance should update for this bAsset, including fee
        const bAssetAfter = await fAssetMachine.getBasset(details, bAsset.address)
        expect(BN.from(bAssetAfter.vaultBalance), "bAssetAfter.vaultBalance").eq(
            BN.from(bAssetBefore.vaultBalance).sub(bAssetQuantityExact),
        )
        const { surplus: surplusAfter } = await fAsset.data()
        expect(surplusAfter, "surplusAfter").eq(surplusBefore.add(scaledFee))

        // Complete basket should remain in healthy state
        if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)

        return bAssetQuantityExact
    }

    const assertExactBassetsRedemption = async (
        md: FassetDetails,
        bAssets: MockERC20[],
        bAssetRedeemQuantities: (BN | number | string)[],
        maxFassetBurntQuantity: BN | number | string = 0,
        expectFee = true,
        recipient: string = sa.default.address,
        sender: Account = sa.default,
        ignoreHealthAssertions = false,
        quantitiesAreExact = false,
    ): Promise<BN> => {
        const { fAsset } = md
        if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)

        // Get bAsset details
        const bAssetsBefore = await fAssetMachine.getBassetsInFasset(details)
        const bAssetAddresses = bAssets.map((b) => b.address)
        const bAssetsDecimals = await Promise.all(bAssets.map((b) => b.decimals()))

        // Convert to exact quantities
        const bAssetRedeemQuantitiesExact = quantitiesAreExact
            ? bAssetRedeemQuantities.map((q) => BN.from(q))
            : bAssetRedeemQuantities.map((q, i) => simpleToExactAmount(q, bAssetsDecimals[i]))
        const maxFassetBurntQuantityExact = quantitiesAreExact
            ? BN.from(maxFassetBurntQuantity)
            : simpleToExactAmount(maxFassetBurntQuantity, 18)

        // Get balances before
        const senderFassetBalBefore = await fAsset.balanceOf(sender.address)
        const fAssetSupplyBefore = await fAsset.totalSupply()
        const recipientBassetBalsBefore: BN[] = await Promise.all(bAssets.map((b) => b.balanceOf(recipient)))
        const { surplus: surplusBefore } = await fAsset.data()

        const fAssetQuantityExact = await fAsset.getRedeemExactBassetsOutput(bAssetAddresses, bAssetRedeemQuantitiesExact)

        // Calculate redemption fee
        let scaledFee = BN.from(0)
        //    If there is a fee expected, then deduct it from output
        if (expectFee) {
            const { swapFee: feeRate } = await fAsset.data()
            expect(feeRate, "fee rate > 0").gt(BN.from(0))
            expect(feeRate, "fee rate < fullScale / 50").lt(fullScale.div(BN.from(50)))
            // fee = fAsset qty - (fAsset qty * feeRate / 1e18)
            scaledFee = fAssetQuantityExact.mul(feeRate).div(fullScale)
            expect(scaledFee, "scaled fee > 0").gt(BN.from(0))
        }

        // Execute the redemption
        const tx = fAsset.redeemExactBassets(bAssetAddresses, bAssetRedeemQuantitiesExact, maxFassetBurntQuantityExact, recipient)

        // Check the emitted events
        await expect(tx)
            .to.emit(fAsset, "RedeemedMulti")
            .withArgs(sender.address, recipient, fAssetQuantityExact, bAssetAddresses, bAssetRedeemQuantitiesExact, scaledFee)
        // Transfer events
        await expect(tx, "Transfer event to burn the redeemed fAssets")
            .to.emit(fAsset, "Transfer")
            .withArgs(sender.address, ZERO_ADDRESS, fAssetQuantityExact)
        // Check all the bAsset transfers
        await Promise.all(
            bAssets.map((bAsset, i) => {
                if (bAssetRedeemQuantitiesExact[i].gt(0)) {
                    return expect(tx, `Transfer event for bAsset[${i}] from platform integration or fAsset to recipient`)
                        .to.emit(bAsset, "Transfer")
                        .withArgs(
                            bAssetsBefore[i].integrator ? bAssetsBefore[i].integratorAddr : fAsset.address,
                            recipient,
                            bAssetRedeemQuantitiesExact[i],
                        )
                }
                return Promise.resolve()
            }),
        )
        await tx

        // Sender should have less fAsset
        const senderFassetBalAfter = await fAsset.balanceOf(sender.address)
        expect(senderFassetBalAfter, "senderFassetBalAfter").eq(senderFassetBalBefore.sub(fAssetQuantityExact))
        // Total fAsset supply should be less
        const fAssetSupplyAfter = await fAsset.totalSupply()
        expect(fAssetSupplyAfter, "fAssetSupplyAfter").eq(fAssetSupplyBefore.sub(fAssetQuantityExact))
        // Recipient should have more bAsset, minus fee
        const recipientBassetBalsAfter = await Promise.all(bAssets.map((b) => b.balanceOf(recipient)))
        recipientBassetBalsAfter.forEach((recipientBassetBalAfter, i) => {
            expect(recipientBassetBalAfter, `recipientBassetBalAfter[${i}]`).eq(
                recipientBassetBalsBefore[i].add(bAssetRedeemQuantitiesExact[i]),
            )
        })

        // VaultBalance should update for this bAsset, including fee
        const bAssetsAfter = await fAssetMachine.getBassetsInFasset(details)
        bAssetsAfter.forEach((bAssetAfter, i) => {
            expect(BN.from(bAssetAfter.vaultBalance), `bAssetAfter[${i}].vaultBalance`).eq(
                BN.from(bAssetsBefore[i].vaultBalance).sub(bAssetRedeemQuantitiesExact[i]),
            )
        })
        const { surplus: surplusAfter } = await fAsset.data()
        expect(surplusAfter, "surplusAfter").eq(surplusBefore.add(scaledFee))

        // Complete basket should remain in healthy state
        if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)

        return fAssetQuantityExact
    }

    const assertFassetRedemption = async (
        md: FassetDetails,
        fAssetQuantityGross: BN | number | string,
        minBassetQuantitiesNet: (BN | number | string)[] = [0, 0, 0, 0],
        expectFee = true,
        recipient: string = sa.default.address,
        sender: Account = sa.default,
        ignoreHealthAssertions = false,
        quantitiesAreExact = false,
    ): Promise<BN> => {
        const { fAsset, bAssets } = md
        if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)

        // Get bAsset details
        const bAssetsBefore = await fAssetMachine.getBassetsInFasset(details)
        const bAssetAddresses = bAssets.map((b) => b.address)
        const bAssetsDecimals = await Promise.all(bAssets.map((b) => b.decimals()))

        // Convert to exact quantities
        const fAssetQuantityExact = quantitiesAreExact ? BN.from(fAssetQuantityGross) : simpleToExactAmount(fAssetQuantityGross, 18)
        const minBassetQuantitiesExact = quantitiesAreExact
            ? minBassetQuantitiesNet.map((q) => BN.from(q))
            : minBassetQuantitiesNet.map((q, i) => simpleToExactAmount(q, bAssetsDecimals[i]))

        // Get balances before
        const senderFassetBalBefore = await fAsset.balanceOf(sender.address)
        const fAssetSupplyBefore = await fAsset.totalSupply()
        const recipientBassetBalsBefore: BN[] = await Promise.all(bAssets.map((b) => b.balanceOf(recipient)))
        const { surplus: surplusBefore, redemptionFee: feeRate } = await fAsset.data()

        // Calculate redemption fee
        let scaledFee = BN.from(0)
        //    If there is a fee expected, then deduct it from output
        if (expectFee) {
            expect(feeRate, "fee rate > 0").gt(BN.from(0))
            expect(feeRate, "fee rate < fullScale / 50").lt(fullScale.div(BN.from(50)))
            // fee = fAsset qty * fee rate
            scaledFee = fAssetQuantityExact.mul(feeRate).div(fullScale)
            expect(scaledFee, "scaled fee > 0").gt(BN.from(0))
        }

        // Execute the redemption
        const tx = fAsset.redeemFasset(fAssetQuantityExact, minBassetQuantitiesExact, recipient)

        // (fAsset qty / 4) * (1 - redemption fee)
        const fAssetRedemptionAmountNet = fAssetQuantityExact.sub(fAssetQuantityExact.mul(feeRate).div(fullScale))
        const bAssetRedeemQuantitiesExact = bAssets.map((b, i) => {
            // netBassetRedemptionAmount = bAsset vault balance * fAsset quantity to be burnt / (total fAsset fAsset + surplus)
            const netBassetRedemptionAmount = BN.from(bAssetsBefore[i].vaultBalance)
                .mul(fAssetRedemptionAmountNet)
                .div(fAssetSupplyBefore.add(surplusBefore))
            return netBassetRedemptionAmount.eq(0) ? netBassetRedemptionAmount : netBassetRedemptionAmount.sub(1)
        })
        // Check the emitted events
        await expect(tx)
            .to.emit(fAsset, "RedeemedMulti")
            .withArgs(sender.address, recipient, fAssetQuantityExact, bAssetAddresses, bAssetRedeemQuantitiesExact, scaledFee)
        // Transfer events
        await expect(tx, "Transfer event to burn the redeemed fAssets")
            .to.emit(fAsset, "Transfer")
            .withArgs(sender.address, ZERO_ADDRESS, fAssetQuantityExact)
        // Check all the bAsset transfers
        await Promise.all(
            bAssets.map((bAsset, i) => {
                if (bAssetRedeemQuantitiesExact[i].gt(0)) {
                    return expect(tx, `Transfer event for bAsset[${i}] from platform integration or fAsset to recipient`)
                        .to.emit(bAsset, "Transfer")
                        .withArgs(
                            bAssetsBefore[i].integrator ? bAssetsBefore[i].integratorAddr : fAsset.address,
                            recipient,
                            bAssetRedeemQuantitiesExact[i],
                        )
                }
                return Promise.resolve()
            }),
        )
        await tx

        // Sender should have less fAsset
        const senderFassetBalAfter = await fAsset.balanceOf(sender.address)
        expect(senderFassetBalAfter, "senderFassetBalAfter").eq(senderFassetBalBefore.sub(fAssetQuantityExact))
        // Total fAsset supply should be less
        const fAssetSupplyAfter = await fAsset.totalSupply()
        expect(fAssetSupplyAfter, "fAssetSupplyAfter").eq(fAssetSupplyBefore.sub(fAssetQuantityExact))
        // Recipient should have more bAsset, minus fee
        const recipientBassetBalsAfter = await Promise.all(bAssets.map((b) => b.balanceOf(recipient)))
        recipientBassetBalsAfter.forEach((recipientBassetBalAfter, i) => {
            expect(recipientBassetBalAfter, `recipientBassetBalAfter[${i}]`).eq(
                recipientBassetBalsBefore[i].add(bAssetRedeemQuantitiesExact[i]),
            )
        })

        // VaultBalance should update for this bAsset, including fee
        const bAssetsAfter = await fAssetMachine.getBassetsInFasset(details)
        bAssetsAfter.forEach((bAssetAfter, i) => {
            expect(BN.from(bAssetAfter.vaultBalance), `bAssetAfter[${i}].vaultBalance`).eq(
                BN.from(bAssetsBefore[i].vaultBalance).sub(bAssetRedeemQuantitiesExact[i]),
            )
        })
        const { surplus: surplusAfter } = await fAsset.data()
        expect(surplusAfter, "surplusAfter").eq(surplusBefore.add(scaledFee))

        // Complete basket should remain in healthy state
        if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)

        return fAssetQuantityExact
    }

    describe("redeeming with a single bAsset", () => {
        context("when the weights are within the validator limit", () => {
            context("and no lending market integration", async () => {
                before(async () => {
                    await runSetup(true, false, false)
                })
                it("should redeem 1 bAsset[0] to a contract", async () => {
                    const { bAssets } = details
                    const recipient = details.managerLib.address
                    await assertBasicRedemption(details, bAssets[0], 1, 0.9, true, recipient)
                })
                it("should redeem 1 bAsset[1]", async () => {
                    const { bAssets } = details
                    const recipient = sa.dummy1
                    await assertBasicRedemption(details, bAssets[1], 1, 0.9, true, recipient.address)
                })
                it("should redeem 12 bAsset[1]", async () => {
                    const { bAssets } = details
                    const recipient = sa.dummy1
                    await assertBasicRedemption(details, bAssets[1], 12, 9, true, recipient.address)
                })
                it("should redeem smallest number of bAsset[0] with 18 decimals", async () => {
                    const { bAssets } = details
                    expect(await bAssets[0].decimals()).eq(18)
                    await assertBasicRedemption(details, bAssets[0], 2, 1, true, undefined, undefined, undefined, true)
                })
                it("should redeem smallest number of bAsset[2] with 12 decimals", async () => {
                    const { bAssets } = details
                    expect(await bAssets[2].decimals()).eq(12)
                    await assertFailedBasicRedemption(
                        "Output == 0",
                        details.fAsset,
                        bAssets[2],
                        1,
                        0,
                        sa.default.signer,
                        sa.default.address,
                        true,
                        false,
                        0,
                    )
                })
            })
            context("and lending market integration", async () => {
                before(async () => {
                    await runSetup(true, false, true)
                })
                it("should redeem 1 bAsset[0] to a contract", async () => {
                    const { bAssets } = details
                    const recipient = details.managerLib.address
                    await assertBasicRedemption(details, bAssets[0], 1, 0.9, true, recipient)
                })
                it("should send 1 bAsset[1] to EOA", async () => {
                    const { bAssets } = details
                    const recipient = sa.dummy1
                    await assertBasicRedemption(details, bAssets[1], 1, 0.9, true, recipient.address)
                })
                it("should send 12 bAsset[1] to EOA", async () => {
                    const { bAssets } = details
                    const recipient = sa.dummy1
                    await assertBasicRedemption(details, bAssets[1], 12, 9, true, recipient.address)
                })
                it("should send 16 bAsset[0] to EOA", async () => {
                    const { bAssets } = details
                    const recipient = sa.dummy1
                    await assertBasicRedemption(details, bAssets[0], 16, 9, true, recipient.address)
                })
            })
            context("and the feeRate changes", async () => {
                before(async () => {
                    await runSetup()
                })
                it("should deduct the suitable fee", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    // Set a new fee recipient
                    const newSwapFee = simpleToExactAmount("8.1", 15)
                    const newRedemptionFee = simpleToExactAmount("5.234234", 15)
                    await fAsset.connect(sa.governor.signer).setFees(newSwapFee, newRedemptionFee)
                    // Calc fAsset burn amounts based on bAsset quantities
                    const fAssetQuantity = simpleToExactAmount(1)
                    const fee = fAssetQuantity.mul(newSwapFee).div(fullScale)
                    const fassetBalBefore = await fAsset.balanceOf(sa.default.address)
                    const { surplus: surplusBefore } = await fAsset.data()
                    // Run the redemption
                    await assertBasicRedemption(details, bAsset, BN.from(1), BN.from(0))
                    const fassetBalAfter = await fAsset.balanceOf(sa.default.address)
                    const { surplus: surplusAfter } = await fAsset.data()
                    // Assert balance increase
                    expect(fassetBalAfter).eq(fassetBalBefore.sub(fAssetQuantity))
                    expect(surplusAfter).eq(surplusBefore.add(fee))
                })
                it("should deduct nothing if the fee is 0", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    // Set a new fee recipient
                    const newFee = BN.from(0)
                    await fAsset.connect(sa.governor.signer).setFees(newFee, newFee)
                    // Calc fAsset burn amounts based on bAsset quantities
                    const fAssetQuantity = simpleToExactAmount(1)
                    const fassetBalBefore = await fAsset.balanceOf(sa.default.address)
                    const { surplus: surplusBefore } = await fAsset.data()
                    // Run the redemption
                    await assertBasicRedemption(details, bAsset, 1, 0, false)
                    const fassetBalAfter = await fAsset.balanceOf(sa.default.address)
                    const { surplus: surplusAfter } = await fAsset.data()
                    // Assert balance increase
                    expect(fassetBalAfter).eq(fassetBalBefore.sub(fAssetQuantity))
                    expect(surplusAfter).eq(surplusBefore)
                })
            })
            context("passing invalid arguments", async () => {
                before(async () => {
                    await runSetup()
                })
                it("should revert when bAsset is 0x0", async () => {
                    const { fAsset } = details
                    await assertFailedBasicRedemption("Invalid asset", fAsset, ZERO_ADDRESS, 1)
                })
                it("should fail if the bAsset does not exist", async () => {
                    const { fAsset } = details
                    const invalidBasset = await fAssetMachine.loadBassetProxy("Wrapped ETH", "WETH", 18)
                    await assertFailedBasicRedemption("Invalid asset", fAsset, invalidBasset, 1)
                })
                it("should revert when 0 quantity", async () => {
                    const { bAssets, fAsset } = details
                    await assertFailedBasicRedemption("Qty==0", fAsset, bAssets[0], 0)
                })
                it("should revert when quantity < min quantity", async () => {
                    const { bAssets, fAsset } = details
                    await assertFailedBasicRedemption(
                        "bAsset qty < min qty",
                        fAsset,
                        bAssets[0],
                        "10000000000000000000",
                        "9995000000000000000",
                        undefined,
                        undefined,
                        true,
                        false,
                        "9973332263398093325",
                    )
                })
                it("should fail if recipient is 0x0", async () => {
                    const { bAssets, fAsset } = details
                    await assertFailedBasicRedemption(
                        "Invalid recipient",
                        fAsset,
                        bAssets[0],
                        "10000000000000000000",
                        "9994000000000000000",
                        undefined,
                        ZERO_ADDRESS,
                        true,
                        false,
                        "9973332263398093325",
                    )
                })
                it("should fail if sender doesn't have fAsset balance", async () => {
                    const { bAssets, fAsset } = details
                    const sender = sa.dummy1
                    expect(await fAsset.balanceOf(sender.address)).eq(0)
                    await assertFailedBasicRedemption(
                        "VM Exception while processing transaction: revert",
                        fAsset,
                        bAssets[0],
                        simpleToExactAmount(1),
                        "9900000000000000000",
                        sender.signer,
                        undefined,
                        true,
                        false,
                        simpleToExactAmount(999, 15),
                    )
                })
            })
            context("with an affected bAsset", async () => {
                beforeEach(async () => {
                    await runSetup()
                })
                it("should fail if bAsset is broken above peg", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    await fAsset.connect(sa.governor.signer).handlePegLoss(bAsset.address, false)
                    const newBasset = await fAsset.getBasset(bAsset.address)
                    expect(newBasset.personal.status, "bAsset broken above peg").to.eq(BassetStatus.BrokenAbovePeg)
                    await assertFailedBasicRedemption(
                        "In recol",
                        fAsset,
                        bAsset,
                        "1000000000000000000",
                        0,
                        sa.default.signer,
                        sa.default.address,
                        true,
                        false,
                        "999248095248405016",
                    )
                })
                it("should fail if bAsset in basket is broken below peg", async () => {
                    const { bAssets, fAsset } = details
                    await assertBasketIsHealthy(fAssetMachine, details)
                    const bAsset = bAssets[1]
                    await fAsset.connect(sa.governor.signer).handlePegLoss(bAsset.address, true)
                    const newBasset = await fAsset.getBasset(bAsset.address)
                    expect(newBasset.personal.status, "bAsset broken below peg").to.eq(BassetStatus.BrokenBelowPeg)
                    await assertFailedBasicRedemption(
                        "In recol",
                        fAsset,
                        bAsset,
                        1,
                        0,
                        sa.default.signer,
                        sa.default.address,
                        false,
                        false,
                        0.999248,
                    )
                })
                it("should fail if other bAssets in basket have broken peg", async () => {
                    const { bAssets, fAsset } = details
                    await assertBasketIsHealthy(fAssetMachine, details)
                    await fAsset.connect(sa.governor.signer).handlePegLoss(bAssets[0].address, false)
                    const abovePegBasset = await fAsset.getBasset(bAssets[0].address)
                    await fAsset.connect(sa.governor.signer).handlePegLoss(bAssets[1].address, true)
                    const belowPegBasset = await fAsset.getBasset(bAssets[1].address)
                    expect(abovePegBasset.personal.status, "bAsset broken above peg").to.eq(BassetStatus.BrokenAbovePeg)
                    expect(belowPegBasset.personal.status, "bAsset broken below peg").to.eq(BassetStatus.BrokenBelowPeg)
                    await assertFailedBasicRedemption(
                        "In recol",
                        fAsset,
                        bAssets[2],
                        1,
                        0,
                        sa.default.signer,
                        sa.default.address,
                        false,
                        false,
                        0.9994,
                    )
                })
            })
            context("performing multiple redemptions in a row", async () => {
                before("reset", async () => {
                    await runSetup(true)
                })
                it("should redeem with single bAsset", async () => {
                    const { bAssets, fAsset } = details
                    const oneFasset = simpleToExactAmount(1, 18)
                    const fAssetSupplyBefore = await fAsset.totalSupply()
                    await Promise.all(
                        bAssets.map(async (b) => {
                            const bAssetDecimals = await b.decimals()
                            return fAsset.redeem(
                                b.address,
                                simpleToExactAmount(1, 18),
                                simpleToExactAmount("0.9", bAssetDecimals),
                                sa.default.address,
                            )
                        }),
                    )
                    const fAssetSupplyAfter = await fAsset.totalSupply()
                    expect(fAssetSupplyAfter).eq(fAssetSupplyBefore.sub(BN.from(bAssets.length).mul(oneFasset)))
                })
            })
            context("using bAssets with transfer fees", async () => {
                beforeEach(async () => {
                    await runSetup(true, true)
                })
                it("should handle tokens with transfer fees", async () => {
                    // // It should burn the full amount of fAsset, but the fees deducted mean the redeemer receives less
                    const { bAssets, fAsset } = details

                    const recipient = sa.dummy3
                    // 1.0 Assert bAsset has fee
                    const bAsset = bAssets[3]
                    const bAssetBefore = await fAsset.getBasset(bAsset.address)
                    expect(bAssetBefore.personal.hasTxFee).to.eq(true)

                    // 2.0 Get balances
                    const totalSupplyBefore = await fAsset.totalSupply()
                    const recipientBassetBalBefore = await bAsset.balanceOf(recipient.address)
                    expect(recipientBassetBalBefore).eq(0)

                    // 3.0 Do the redemption
                    const expectedBassetQuantity = await fAsset.getRedeemOutput(bAsset.address, simpleToExactAmount(1))
                    await assertBasicRedemption(details, bAsset, 1, BN.from(0), true, recipient.address, sa.default, false, false, true)

                    // 4.0 Total supply goes down, and recipient bAsset goes up slightly
                    const recipientBassetBalAfter = await bAsset.balanceOf(recipient.address)
                    // Assert that we redeemed gt 99% of the bAsset
                    assertBNSlightlyGTPercent(recipientBassetBalBefore.add(expectedBassetQuantity), recipientBassetBalAfter, "0.4", true)
                    // Total supply goes down full amount
                    const totalSupplyAfter = await fAsset.totalSupply()
                    expect(totalSupplyAfter, "after total supply").eq(totalSupplyBefore.sub(simpleToExactAmount(1)))

                    // VaultBalance should update for this bAsset
                    const bAssetAfter = await fAsset.getBasset(bAsset.address)
                    expect(BN.from(bAssetAfter.bData.vaultBalance), "before != after + fee").eq(
                        BN.from(bAssetBefore.bData.vaultBalance).sub(expectedBassetQuantity),
                    )
                })
                it("should send less output to user if fee unexpected", async () => {
                    // It should burn the full amount of fAsset, but the fees deducted mean the redeemer receives less
                    const { bAssets, fAsset } = details
                    await assertBasketIsHealthy(fAssetMachine, details)
                    const recipient = sa.dummy3
                    // 1.0 Assert bAsset has fee
                    const bAsset = bAssets[3]
                    const basket = await fAssetMachine.getBasketComposition(details)
                    const bAssetDecimals = await bAsset.decimals()
                    const oneBasset = simpleToExactAmount(1, bAssetDecimals)
                    const { swapFee } = await fAsset.data()
                    const bAssetFee = oneBasset.mul(swapFee).div(fullScale)
                    expect(basket.bAssets[3].isTransferFeeCharged).to.eq(true)
                    await fAsset.connect(sa.governor.signer).setTransferFeesFlag(bAsset.address, false)
                    const recipientBassetBalBefore = await bAsset.balanceOf(recipient.address)
                    await fAsset.redeem(bAsset.address, oneBasset, 0, recipient.address)
                    // 4.0 Total supply goes down, and recipient bAsset goes up slightly
                    const recipientBassetBalAfter = await bAsset.balanceOf(recipient.address)
                    // Assert that we redeemed gt 99% of the bAsset
                    assertBNSlightlyGTPercent(recipientBassetBalBefore.add(oneBasset.sub(bAssetFee)), recipientBassetBalAfter, "0.4", true)
                })
            })
        })
    })
    describe("redeeming multiple exact bAssets", () => {
        context("when the weights are within the validator limit", () => {
            before(async () => {
                await runSetup()
            })
            it("should redeem with all different bAsset quantities", async () => {
                const { bAssets } = details
                const recipient = details.managerLib.address
                await assertExactBassetsRedemption(details, bAssets, [1, 2, 3, 4], 11, true, recipient)
            })
            it("should redeem with only one bAsset quantity", async () => {
                const { bAssets } = details
                const recipient = details.managerLib.address
                await assertExactBassetsRedemption(details, bAssets, [0, 0, 0, 10], 11, true, recipient)
            })
        })
        context("passing invalid arguments", async () => {
            before(async () => {
                await runSetup()
            })
            context("when invalid bAssets", () => {
                let invalidBassets: (MockERC20 | string)[]
                before(() => {
                    invalidBassets = [...details.bAssets]
                })
                it("should fail when empty bAsset and quantities arrays", async () => {
                    const { fAsset } = details
                    await assertFailedExactBassetsRedemption("Invalid array input", fAsset, [], [], 1)
                })
                it("should fail when empty bAsset and some quantities array input", async () => {
                    const { fAsset } = details
                    await assertFailedExactBassetsRedemption("Invalid array input", fAsset, [], [1, 2], 4)
                })
                it("should fail when some bAssets and empty quantities arrays", async () => {
                    const { fAsset } = details
                    await assertFailedExactBassetsRedemption("Invalid array input", fAsset, details.bAssets, [], 4)
                })
                it("should fail when bAssets to quantities array len do not match", async () => {
                    const { fAsset } = details
                    await assertFailedExactBassetsRedemption("Invalid array input", fAsset, details.bAssets, [1, 2], 4)
                })
                it("should fail when first bAsset is 0x0", async () => {
                    const { fAsset } = details
                    invalidBassets[0] = ZERO_ADDRESS
                    await assertFailedExactBassetsRedemption("Invalid asset", fAsset, invalidBassets, [1, 2, 3, 4], 11)
                })
                it("should fail when last bAsset is 0x0", async () => {
                    const { fAsset } = details
                    invalidBassets[3] = ZERO_ADDRESS
                    await assertFailedExactBassetsRedemption("Invalid asset", fAsset, invalidBassets, [1, 2, 3, 4], 11)
                })
                it("should fail if first bAsset does not exist", async () => {
                    const { fAsset } = details
                    const invalidBasset = await fAssetMachine.loadBassetProxy("Wrapped ETH", "WETH", 18)
                    invalidBassets[0] = invalidBasset
                    await assertFailedExactBassetsRedemption("Invalid asset", fAsset, invalidBassets, [1, 2, 3, 4], 11)
                })
                it("should fail if last bAsset does not exist", async () => {
                    const { fAsset } = details
                    const invalidBasset = await fAssetMachine.loadBassetProxy("Wrapped ETH", "WETH", 18)
                    invalidBassets[3] = invalidBasset
                    await assertFailedExactBassetsRedemption("Invalid asset", fAsset, invalidBassets, [1, 2, 3, 4], 11)
                })
            })
            it("should fail when all quantities are 0", async () => {
                const { bAssets, fAsset } = details
                await assertFailedExactBassetsRedemption(
                    "Must redeem > 1e6 units",
                    fAsset,
                    bAssets,
                    [0, 0, 0, 0],
                    11,
                    undefined,
                    undefined,
                    false,
                    true,
                )
            })
            it("should fail when max quantity is 0", async () => {
                const { bAssets, fAsset } = details
                await assertFailedExactBassetsRedemption(
                    "Qty==0",
                    fAsset,
                    bAssets,
                    ["1000000000000000000", "2000000", "3000000000000", "4000000000000000000"],
                    0,
                    sa.default.signer,
                    sa.default.address,
                    true,
                    false,
                    "10006003602161296779",
                )
            })
            it("should revert when redeemed fAsset quantity > max fAsset quantity", async () => {
                const { bAssets, fAsset } = details
                await assertFailedExactBassetsRedemption(
                    "Redeem fAsset qty > max quantity",
                    fAsset,
                    bAssets,
                    ["1000000000000000000", "2000000", "3000000000000", "4000000000000000000"],
                    "10000000000000000000",
                    sa.default.signer,
                    sa.default.address,
                    true,
                    false,
                    "10006003602161296779",
                )
            })
            context("when redeemed fAsset quantity just greater than max fAsset quantity", () => {
                it("should revert with high rounded number", async () => {
                    const { bAssets, fAsset } = details
                    await assertFailedExactBassetsRedemption(
                        "Redeem fAsset qty > max quantity",
                        fAsset,
                        bAssets,
                        ["1000000000000000000", "2000000", "3000000000000", "4000000000000000000"],
                        // fAsset = 10 / (1 - 0.06 / 100) = 10.00600360216129677807
                        // 1 - 0.06 / 100 = 0.9994
                        // but solidity calculate its to be 10.006003602161296777
                        // and then 1 is added to give 10.006003602161296778
                        "10006003602161296778",
                        sa.default.signer,
                        sa.default.address,
                        true,
                        false,
                        "10006003602161296779",
                    )
                })
                it("should revert when low rounded number", async () => {
                    const { bAssets, fAsset } = details
                    await assertFailedExactBassetsRedemption(
                        "Redeem fAsset qty > max quantity",
                        fAsset,
                        bAssets,
                        ["1000000000000000000", "2000000", "3000000000000", "7000000000000000000"],
                        // 13 * (1 - 0.06 / 100) = 13.00780468280968581149
                        simpleToExactAmount(13),
                        undefined,
                        undefined,
                        true,
                        false,
                        simpleToExactAmount(13),
                    )
                })
            })
            it("should fail if recipient is 0x0", async () => {
                const { bAssets, fAsset } = details
                await assertFailedExactBassetsRedemption(
                    "Invalid recipient",
                    fAsset,
                    bAssets,
                    [1, 2, 3, 4],
                    10,
                    undefined,
                    ZERO_ADDRESS,
                    false,
                    false,
                    "10006003602161296779",
                )
            })
            it("should fail if sender doesn't have fAsset balance", async () => {
                const { bAssets, fAsset } = details
                const sender = sa.dummy1
                expect(await fAsset.balanceOf(sender.address)).eq(0)
                await assertFailedExactBassetsRedemption(
                    "ERC20: burn amount exceeds balance",
                    fAsset,
                    bAssets,
                    [1, 2, 3, 4],
                    11,
                    sender.signer,
                    undefined,
                    false,
                    false,
                    "10006003602161296779",
                )
            })
        })
    })
    describe("redeeming fAssets for multiple proportional bAssets", () => {
        context("even bAsset weights", () => {
            before(async () => {
                await runSetup()
            })
            it("should redeem with all different bAsset quantities", async () => {
                const recipient = details.managerLib.address
                await assertFassetRedemption(details, 10, [2, 2, 2, 2], true, recipient)
            })
            it("should redeem with bAsset minimums exactly equal", async () => {
                const recipient = details.managerLib.address
                await assertFassetRedemption(
                    details,
                    "10000000000000000000",
                    ["2499249999999999999", "2499249", "2499249999999", "2499249999999999999"],
                    true,
                    recipient,
                    undefined,
                    false,
                    true,
                )
            })
        })
        context("uneven bAsset weights", () => {
            before(async () => {
                await runSetup(true, false, false, [3, 4, 30, 15])
            })
            it("should redeem", async () => {
                const recipient = details.managerLib.address
                await assertFassetRedemption(details, 10, [0, 0, 5, 2], true, recipient)
            })
        })
        context("when most of basket in second bAsset", () => {
            beforeEach(async () => {
                await runSetup(true, false, false, [25, 125, 25, 25])
            })
            it("should redeem some of the bAssets", async () => {
                const recipient = details.managerLib.address
                // 10 * (1 - 0.03 / 100) - 0.000001 = 9996999
                await assertFassetRedemption(
                    details,
                    simpleToExactAmount(8, 18),
                    [simpleToExactAmount(9, 17), "4800000", simpleToExactAmount(9, 11), simpleToExactAmount(9, 17)],
                    true,
                    recipient,
                    undefined,
                    false,
                    true,
                )
            })
        })
        describe("passing invalid arguments", async () => {
            before(async () => {
                await runSetup()
            })
            it("should revert when fAsset quantity is zero", async () => {
                const { bAssets, fAsset } = details
                await assertFailedFassetRedemption("Qty==0", fAsset, 0, [2, 2, 2, 2], bAssets)
            })
            it("should fail if recipient is 0x0", async () => {
                const { bAssets, fAsset } = details
                await assertFailedFassetRedemption("Invalid recipient", fAsset, 0, [2, 2, 2, 2], bAssets, undefined, ZERO_ADDRESS)
            })
        })
        describe("failures other than invalid arguments", () => {
            before(async () => {
                await runSetup()
            })
            context("when a bAsset minimum is not reached", () => {
                const testData = [
                    {
                        desc: "first bAsset < min",
                        minBassetQuantities: [3, 2, 2, 2],
                    },
                    {
                        desc: "last bAsset < min",
                        minBassetQuantities: [2, 2, 2, 3],
                    },
                    {
                        desc: "all bAsset < min",
                        minBassetQuantities: [3, 3, 3, 3],
                    },
                    {
                        desc: "all zero except last bAsset < min",
                        minBassetQuantities: [0, 0, 0, 3],
                    },
                    {
                        desc: "first bAsset just below min",
                        minBassetQuantities: ["2499250000000000000", "2499249", "2499249999999", "2499249999999999999"],
                        fAssetQuantity: "10000000000000000000",
                        quantitiesAreExact: true,
                    },
                    {
                        desc: "second bAsset just below min",
                        minBassetQuantities: ["2499249999999999999", "2499250", "2499249999999", "2499249999999999999"],
                        fAssetQuantity: "10000000000000000000",
                        quantitiesAreExact: true,
                    },
                ]
                testData.forEach((data) => {
                    it(`should revert when ${data.desc}`, async () => {
                        const { bAssets, fAsset } = details
                        await assertFailedFassetRedemption(
                            "bAsset qty < min qty",
                            fAsset,
                            data.fAssetQuantity || 10,
                            data.minBassetQuantities,
                            bAssets,
                            undefined,
                            undefined,
                            data.quantitiesAreExact,
                        )
                    })
                })
            })
            it("should fail if sender doesn't have fAsset balance", async () => {
                const { bAssets, fAsset } = details
                const sender = sa.dummy1
                expect(await fAsset.balanceOf(sender.address)).eq(0)
                await assertFailedFassetRedemption("ERC20: burn amount exceeds balance", fAsset, 10, [2, 2, 2, 2], bAssets, sender.signer)
            })
            context("when a bAsset has broken its peg", () => {
                it("should fail if broken below peg", async () => {
                    const { bAssets, fAsset } = details
                    await assertBasketIsHealthy(fAssetMachine, details)
                    const bAsset = bAssets[1]
                    await fAsset.connect(sa.governor.signer).handlePegLoss(bAsset.address, true)
                    const newBasset = await fAsset.getBasset(bAsset.address)
                    expect(newBasset.personal.status, "bAsset broken below peg").to.eq(BassetStatus.BrokenBelowPeg)
                    await assertFailedFassetRedemption("In recol", fAsset, 10, [2, 2, 2, 2], bAssets)
                })
                it("should fail if broken above peg", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    await fAsset.connect(sa.governor.signer).handlePegLoss(bAsset.address, false)
                    const newBasset = await fAsset.getBasset(bAsset.address)
                    expect(newBasset.personal.status, "bAsset broken above peg").to.eq(BassetStatus.BrokenAbovePeg)
                    await assertFailedFassetRedemption("In recol", fAsset, 10, [2, 2, 2, 2], bAssets)
                })
            })
        })
    })
})
