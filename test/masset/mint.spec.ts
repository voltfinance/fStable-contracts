import { expect } from "chai"
import { Signer } from "ethers"
import { ethers } from "hardhat"

import { assertBasketIsHealthy, assertBNClosePercent, assertBNSlightlyGTPercent } from "@utils/assertions"
import { applyRatio, BN, simpleToExactAmount } from "@utils/math"
import { FassetDetails, FassetMachine, StandardAccounts } from "@utils/machines"
import { BassetStatus } from "@utils/mstable-objects"
import { ZERO_ADDRESS } from "@utils/constants"
import { Fasset, MockERC20 } from "types/generated"
import { Account } from "types"

interface MintOutput {
    fAssets: BN
    senderBassetBalBefore: BN
    senderBassetBalAfter: BN
    recipientBalBefore: BN
    recipientBalAfter: BN
}

describe("Fasset - Mint", () => {
    let sa: StandardAccounts
    let fAssetMachine: FassetMachine

    let details: FassetDetails

    const runSetup = async (seedBasket = true, useTransferFees = false, useLendingMarkets = false): Promise<void> => {
        details = await fAssetMachine.deployFasset(useLendingMarkets, useTransferFees)
        if (seedBasket) {
            await fAssetMachine.seedWithWeightings(details, [25, 25, 25, 25])
        }
    }

    before("Init contract", async () => {
        const accounts = await ethers.getSigners()
        fAssetMachine = await new FassetMachine().initAccounts(accounts)
        sa = fAssetMachine.sa

        await runSetup()
    })

    const assertFailedMint = async (
        expectedReason: string,
        fAssetContract: Fasset,
        bAsset: MockERC20,
        bAssetQuantity: BN | number | string,
        minFassetQuantity: BN | number | string = 0,
        approval = true,
        sender: Signer = sa.default.signer,
        recipient: string = sa.default.address,
        mintOutputRevertExpected = true,
        mintOutputExpected: BN | number | string = 0,
        quantitiesAreExact = false,
    ): Promise<void> => {
        const fAsset = fAssetContract.connect(sender)
        if (approval) {
            await fAssetMachine.approveFasset(bAsset, fAsset, bAssetQuantity, sender, quantitiesAreExact)
        }

        const bAssetDecimals = await bAsset.decimals()
        const bAssetQuantityExact = quantitiesAreExact ? BN.from(bAssetQuantity) : simpleToExactAmount(bAssetQuantity, bAssetDecimals)
        const minFassetQuantityExact = quantitiesAreExact ? BN.from(minFassetQuantity) : simpleToExactAmount(minFassetQuantity, 18)

        await expect(
            fAsset.mint(bAsset.address, bAssetQuantityExact, minFassetQuantityExact, recipient),
            `mint tx should revert with "${expectedReason}"`,
        ).to.be.revertedWith(expectedReason)

        if (mintOutputRevertExpected) {
            await expect(
                fAsset.getMintOutput(bAsset.address, bAssetQuantityExact),
                `getMintOutput call should revert with "${expectedReason}"`,
            ).to.be.revertedWith(expectedReason)
        } else {
            const mintOutputExpectedExact = quantitiesAreExact ? BN.from(mintOutputExpected) : simpleToExactAmount(mintOutputExpected, 18)
            const output = await fAsset.getMintOutput(bAsset.address, bAssetQuantityExact)
            expect(output, "getMintOutput call output").eq(mintOutputExpectedExact)
        }
    }

    const assertFailedMintMulti = async (
        expectedReason: string,
        fAssetContract: Fasset,
        bAssets: (MockERC20 | string)[],
        bAssetRedeemQuantities: (BN | number | string)[],
        minFassetQuantity: BN | number | string = 0,
        approval = true,
        sender: Signer = sa.default.signer,
        recipient: string = sa.default.address,
        mintMultiOutputRevertExpected = true,
        outputExpected: BN | number | string = 0,
        quantitiesAreExact = false,
    ): Promise<void> => {
        const fAsset = fAssetContract.connect(sender)
        if (approval) {
            const approvePromises = bAssets.map((b, i) =>
                typeof b === "string"
                    ? Promise.resolve(BN.from(0))
                    : fAssetMachine.approveFasset(b, fAsset, bAssetRedeemQuantities[i], sender, quantitiesAreExact),
            )
            await Promise.all(approvePromises)
        }

        const bAssetAddresses = bAssets.map((bAsset) => (typeof bAsset === "string" ? bAsset : bAsset.address))
        const bAssetsDecimals = await Promise.all(
            bAssets.map((bAsset) => (typeof bAsset === "string" ? Promise.resolve(18) : bAsset.decimals())),
        )

        // Convert to exact quantities
        const bAssetRedeemQuantitiesExact = quantitiesAreExact
            ? bAssetRedeemQuantities.map((q) => BN.from(q))
            : bAssetRedeemQuantities.map((q, i) => simpleToExactAmount(q, bAssetsDecimals[i]))
        const minFassetQuantityExact = quantitiesAreExact ? BN.from(minFassetQuantity) : simpleToExactAmount(minFassetQuantity, 18)

        await expect(
            fAsset.mintMulti(bAssetAddresses, bAssetRedeemQuantitiesExact, minFassetQuantityExact, recipient),
            `mintMulti tx should revert with "${expectedReason}"`,
        ).to.be.revertedWith(expectedReason)

        if (mintMultiOutputRevertExpected) {
            await expect(
                fAsset.getMintMultiOutput(bAssetAddresses, bAssetRedeemQuantitiesExact),
                `getMintMultiOutput call should revert with "${expectedReason}"`,
            ).to.be.revertedWith(expectedReason)
        } else {
            const outputExpectedExact = quantitiesAreExact ? BN.from(outputExpected) : simpleToExactAmount(outputExpected, 18)
            const output = await fAsset.getMintMultiOutput(bAssetAddresses, bAssetRedeemQuantitiesExact)
            expect(output, "getMintMultiOutput call output").eq(outputExpectedExact)
        }
    }

    // Helper to assert basic minting conditions, i.e. balance before and after
    const assertBasicMint = async (
        md: FassetDetails,
        bAsset: MockERC20,
        bAssetQuantity: BN | number | string,
        minFassetQuantity: BN | number | string = 0,
        recipient: string = sa.default.address,
        sender: Account = sa.default,
        ignoreHealthAssertions = true,
        quantitiesAreExact = false,
    ): Promise<MintOutput> => {
        const { platform } = md
        const fAsset = md.fAsset.connect(sender.signer)
        if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)

        // Get before balances
        const senderBassetBalBefore = await bAsset.balanceOf(sender.address)
        const recipientBalBefore = await fAsset.balanceOf(recipient)
        const bAssetBefore = await fAssetMachine.getBasset(details, bAsset.address)

        // Convert to exact quantities
        const bAssetQuantityExact = quantitiesAreExact
            ? BN.from(bAssetQuantity)
            : simpleToExactAmount(bAssetQuantity, await bAsset.decimals())
        const minFassetQuantityExact = quantitiesAreExact ? BN.from(minFassetQuantity) : simpleToExactAmount(minFassetQuantity, 18)
        const fAssetQuantityExact = applyRatio(bAssetQuantityExact, bAssetBefore.ratio)

        const platformInteraction = await FassetMachine.getPlatformInteraction(fAsset, "deposit", bAssetQuantityExact, bAssetBefore)
        const integratorBalBefore = await bAssetBefore.contract.balanceOf(
            bAssetBefore.integrator ? bAssetBefore.integratorAddr : fAsset.address,
        )

        await fAssetMachine.approveFasset(bAsset, fAsset, bAssetQuantityExact, sender.signer, quantitiesAreExact)

        const fAssetOutput = await fAsset.getMintOutput(bAsset.address, bAssetQuantityExact)
        assertBNClosePercent(fAssetOutput, fAssetQuantityExact, "0.02", "fAssetOutput")

        const tx = fAsset.mint(bAsset.address, bAssetQuantityExact, minFassetQuantityExact, recipient)

        // Minted event
        await expect(tx, "Minted event")
            .to.emit(fAsset, "Minted")
            .withArgs(sender.address, recipient, fAssetOutput, bAsset.address, bAssetQuantityExact)
        // const { events } = await (await tx).wait()
        // const mintedEvent = events.find((e) => e.event === "Minted")
        // expect(mintedEvent.args[0]).to.eq(sender.address)
        // expect(mintedEvent.args[1]).to.eq(recipient)
        // expect(mintedEvent.args[2]).to.eq(fAssetOutput)
        // expect(mintedEvent.args[3]).to.eq(bAsset.address)
        // expect(mintedEvent.args[4]).to.eq(bAssetQuantityExact)

        // Transfers to lending platform
        await expect(tx, "Transfer event")
            .to.emit(bAsset, "Transfer")
            .withArgs(sender.address, bAssetBefore.integrator ? bAssetBefore.integratorAddr : fAsset.address, bAssetQuantityExact)

        // Deposits into lending platform
        const integratorBalAfter = await bAssetBefore.contract.balanceOf(
            bAssetBefore.integrator ? bAssetBefore.integratorAddr : fAsset.address,
        )
        expect(integratorBalAfter, "integratorBalAfter").eq(integratorBalBefore.add(bAssetQuantityExact))
        if (platformInteraction.expectInteraction) {
            await expect(tx).to.emit(platform, "Deposit").withArgs(bAsset.address, bAssetBefore.pToken, platformInteraction.amount)
        }

        // Recipient should have fAsset quantity after
        const recipientBalAfter = await fAsset.balanceOf(recipient)
        expect(recipientBalAfter, "recipientBal after").eq(recipientBalBefore.add(fAssetOutput))
        // Sender should have less bAsset after
        const senderBassetBalAfter = await bAsset.balanceOf(sender.address)
        expect(senderBassetBalAfter, "senderBassetBal after").eq(senderBassetBalBefore.sub(bAssetQuantityExact))
        // VaultBalance should update for this bAsset
        const bAssetAfter = await fAsset.getBasset(bAsset.address)
        expect(BN.from(bAssetAfter.bData.vaultBalance), "vaultBalance after").eq(
            BN.from(bAssetBefore.vaultBalance).add(bAssetQuantityExact),
        )

        // Complete basket should remain in healthy state
        if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)
        return {
            fAssets: fAssetQuantityExact,
            senderBassetBalBefore,
            senderBassetBalAfter,
            recipientBalBefore,
            recipientBalAfter,
        }
    }

    describe("minting with a single bAsset", () => {
        context("when the weights are within the ForgeValidator limit", () => {
            context("using bAssets with no transfer fees", async () => {
                before("reset", async () => {
                    await runSetup()
                })
                it("should send fUSD when recipient is a contract", async () => {
                    const { bAssets, managerLib } = details
                    const recipient = managerLib.address
                    await assertBasicMint(details, bAssets[0], 1, 0, recipient)
                })
                it("should send fUSD when the recipient is an EOA", async () => {
                    const { bAssets } = details
                    const recipient = sa.dummy1.address
                    await assertBasicMint(details, bAssets[1], 1, 0, recipient)
                })
                it("should mint fAssets to 18 decimals from 1 base bAsset unit with 12 decimals", async () => {
                    const bAsset = details.bAssets[2]
                    const decimals = await bAsset.decimals()
                    expect(decimals).eq(12)

                    const result = await assertBasicMint(details, bAsset, 1, 0, sa.default.address, sa.default, false, true)
                    expect(result.fAssets).to.eq("1000000") // 18 - 12 = 6 decimals
                })
                it("should mint fAssets to 18 decimals from 2 base bAsset units with 6 decimals", async () => {
                    const bAsset = details.bAssets[1]
                    const decimals = await bAsset.decimals()
                    expect(decimals).eq(6)

                    const result = await assertBasicMint(details, bAsset, 2, 0, sa.default.address, sa.default, false, true)
                    expect(result.fAssets).to.eq("2000000000000") // 18 - 6 = 12 decimals
                })
            })
            context("using bAssets with transfer fees", async () => {
                before(async () => {
                    await runSetup(true, true, true)
                })
                it("should handle tokens with transfer fees", async () => {
                    const { bAssets, fAsset, platform } = details
                    await assertBasketIsHealthy(fAssetMachine, details)

                    // 1.0 Assert bAsset has fee
                    const bAsset = bAssets[3]
                    const basket = await fAssetMachine.getBasketComposition(details)
                    expect(basket.bAssets[3].isTransferFeeCharged).to.eq(true)

                    // 2.0 Get balances
                    const minterBassetBalBefore = await bAsset.balanceOf(sa.default.address)
                    const recipient = sa.dummy3
                    const recipientBalBefore = await fAsset.balanceOf(recipient.address)
                    expect(recipientBalBefore).eq(0)
                    const fAssetMintAmount = 10
                    const approval0: BN = await fAssetMachine.approveFasset(bAsset, fAsset, fAssetMintAmount)
                    // 3.0 Do the mint
                    const tx = fAsset.mint(bAsset.address, approval0, 0, recipient.address)

                    const fAssetQuantity = simpleToExactAmount(fAssetMintAmount, 18)
                    const bAssetQuantity = simpleToExactAmount(fAssetMintAmount, await bAsset.decimals())

                    // take 0.1% off for the transfer fee = amount * (1 - 0.001)
                    const bAssetAmountLessFee = bAssetQuantity.mul(999).div(1000)
                    // 3.1 Check Transfers to lending platform
                    await expect(tx).to.emit(bAsset, "Transfer").withArgs(sa.default.address, platform.address, bAssetAmountLessFee)
                    // 3.2 Check Deposits into lending platform
                    await expect(tx)
                        .to.emit(platform, "Deposit")
                        .withArgs(bAsset.address, await platform.bAssetToPToken(bAsset.address), bAssetAmountLessFee)
                    // 4.0 Recipient should have fAsset quantity after
                    const recipientBalAfter = await fAsset.balanceOf(recipient.address)
                    // Assert that we minted gt 99% of the bAsset
                    assertBNSlightlyGTPercent(recipientBalBefore.add(fAssetQuantity), recipientBalAfter, "0.3", true)
                    // Sender should have less bAsset after
                    const minterBassetBalAfter = await bAsset.balanceOf(sa.default.address)
                    expect(minterBassetBalAfter, "minterBassetBalAfter").eq(minterBassetBalBefore.sub(bAssetQuantity))
                })
                it("should fail if the token charges a fee but we don't know about it", async () => {
                    const { bAssets, fAsset } = details
                    await assertBasketIsHealthy(fAssetMachine, details)

                    // 1.0 Assert bAsset has fee
                    const bAsset = bAssets[3]
                    const basket = await fAssetMachine.getBasketComposition(details)
                    expect(basket.bAssets[3].isTransferFeeCharged).to.eq(true)
                    await fAsset.connect(sa.governor.signer).setTransferFeesFlag(bAsset.address, false)

                    // 2.0 Get balances
                    const fAssetMintAmount = 10
                    const approval0: BN = await fAssetMachine.approveFasset(bAsset, fAsset, fAssetMintAmount)
                    // 3.0 Do the mint
                    await expect(fAsset.mint(bAsset.address, approval0, 0, sa.default.address)).to.revertedWith(
                        "Asset not fully transferred",
                    )
                })
            })
            context("with an affected bAsset", async () => {
                it("should fail if bAsset is broken below peg", async () => {
                    const { bAssets, fAsset } = details
                    await assertBasketIsHealthy(fAssetMachine, details)

                    const bAsset = bAssets[0]
                    await fAsset.connect(sa.governor.signer).handlePegLoss(bAsset.address, true)
                    const newBasset = await fAsset.getBasset(bAsset.address)
                    expect(newBasset.personal.status).to.eq(BassetStatus.BrokenBelowPeg)
                    await assertFailedMint(
                        "Unhealthy",
                        fAsset,
                        bAsset,
                        "1000000000000000000",
                        0,
                        true,
                        sa.default.signer,
                        sa.default.address,
                        false,
                        "1000746841283429855",
                        true,
                    )
                })
            })
            context("passing invalid arguments", async () => {
                before(async () => {
                    await runSetup()
                })
                it("should fail if recipient is 0x0", async () => {
                    const { fAsset, bAssets } = details
                    await assertFailedMint(
                        "Invalid recipient",
                        fAsset,
                        bAssets[0],
                        "1000000000000000000",
                        0,
                        true,
                        sa.default.signer,
                        ZERO_ADDRESS,
                        false,
                        "999854806326923450",
                        true,
                    )
                })
                it("should revert when 0 quantities", async () => {
                    const { bAssets, fAsset } = details
                    await assertFailedMint("Qty==0", fAsset, bAssets[0], 0)
                })
                it("should fail if sender doesn't have balance", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    const sender = sa.dummy1
                    expect(await bAsset.balanceOf(sender.address)).eq(0)
                    await assertFailedMint(
                        "ERC20: transfer amount exceeds balance",
                        fAsset,
                        bAsset,
                        "100000000000000000000",
                        "99000000000000000000",
                        true,
                        sender.signer,
                        sender.address,
                        false,
                        "98939327585405193936",
                        true,
                    )
                })
                it("should fail if sender doesn't give approval", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    const sender = sa.dummy2
                    await bAsset.transfer(sender.address, 10000)
                    expect(await bAsset.allowance(sender.address, fAsset.address)).eq(0)
                    expect(await bAsset.balanceOf(sender.address)).eq(10000)
                    await assertFailedMint(
                        "ERC20: transfer amount exceeds allowance",
                        fAsset,
                        bAsset,
                        100,
                        99,
                        false,
                        sender.signer,
                        sender.address,
                        false,
                        100,
                        true,
                    )
                })
                it("should fail if the bAsset does not exist", async () => {
                    const { fAsset } = details
                    const newBasset = await fAssetMachine.loadBassetProxy("Mock", "MKK", 18, sa.default.address, 1000)
                    await assertFailedMint("Invalid asset", fAsset, newBasset, 1)
                })
            })
            context("should mint single bAsset", () => {
                const indexes = [0, 1, 2, 3]
                indexes.forEach((i) => {
                    it(`should mint single bAsset[${i}]`, async () => {
                        await assertBasicMint(details, details.bAssets[i], 1)
                    })
                })
            })
        })
    })
    describe("minting with multiple bAssets", () => {
        // Helper to assert basic minting conditions, i.e. balance before and after
        const assertMintMulti = async (
            md: FassetDetails,
            fAssetMintAmounts: Array<BN | number>,
            bAssets: Array<MockERC20>,
            recipient: string = sa.default.address,
            sender: Account = sa.default,
            ignoreHealthAssertions = false,
        ): Promise<void> => {
            const { fAsset } = md

            if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)

            const minterBassetBalBefore = await Promise.all(bAssets.map((b) => b.balanceOf(sender.address)))
            const recipientBalBefore = await fAsset.balanceOf(recipient)
            const bAssetDecimals = await Promise.all(bAssets.map((b) => b.decimals()))
            const bAssetBefore = await Promise.all(bAssets.map((b) => fAsset.getBasset(b.address)))
            const approvals: Array<BN> = await Promise.all(
                bAssets.map((b, i) => fAssetMachine.approveFasset(b, fAsset, fAssetMintAmounts[i])),
            )

            const fAssetOutput = await fAsset.getMintMultiOutput(
                bAssetBefore.map((b) => b.personal.addr),
                approvals,
            )
            const fAssetQuantity = simpleToExactAmount(
                fAssetMintAmounts.reduce((p, c) => BN.from(p).add(BN.from(c)), BN.from(0)),
                18,
            )
            assertBNClosePercent(fAssetOutput, fAssetQuantity, "0.25", "fAssetOutput")

            const tx = fAsset.connect(sender.signer).mintMulti(
                bAssetBefore.map((b) => b.personal.addr),
                approvals,
                0,
                recipient,
            )

            await expect(tx)
                .to.emit(fAsset, "MintedMulti")
                .withArgs(
                    sender.address,
                    recipient,
                    fAssetOutput,
                    bAssetBefore.map((b) => b.personal.addr),
                    approvals,
                )

            const bAssetQuantities = fAssetMintAmounts.map((m, i) => simpleToExactAmount(m, bAssetDecimals[i]))
            // Recipient should have fAsset quantity after
            const recipientBalAfter = await fAsset.balanceOf(recipient)
            expect(recipientBalAfter, "recipientBalAfter").eq(recipientBalBefore.add(fAssetOutput))
            // Sender should have less bAsset after
            const minterBassetBalAfter = await Promise.all(bAssets.map((b) => b.balanceOf(sender.address)))
            minterBassetBalAfter.map((b, i) => expect(b, `minter bAsset ${i} bal`).eq(minterBassetBalBefore[i].sub(bAssetQuantities[i])))
            // VaultBalance should updated for this bAsset
            const bAssetAfter = await Promise.all(bAssets.map((b) => fAsset.getBasset(b.address)))
            bAssetAfter.map((b, i) =>
                expect(b.bData.vaultBalance, `vault balance ${i}`).eq(BN.from(bAssetBefore[i].bData.vaultBalance).add(bAssetQuantities[i])),
            )

            // Complete basket should remain in healthy state
            if (!ignoreHealthAssertions) await assertBasketIsHealthy(fAssetMachine, md)
        }

        before(async () => {
            await runSetup()
        })
        context("when the weights are within the ForgeValidator limit", () => {
            context("and sending to a specific recipient", async () => {
                before(async () => {
                    await runSetup()
                })
                it("should mint selected bAssets only", async () => {
                    const compBefore = await fAssetMachine.getBasketComposition(details)
                    await assertMintMulti(details, [5, 10], [details.bAssets[2], details.bAssets[0]])
                    const compAfter = await fAssetMachine.getBasketComposition(details)
                    expect(compBefore.bAssets[1].vaultBalance).eq(compAfter.bAssets[1].vaultBalance)
                    expect(compBefore.bAssets[3].vaultBalance).eq(compAfter.bAssets[3].vaultBalance)
                })
                it("should send fUSD when recipient is a contract", async () => {
                    const { bAssets, managerLib } = details
                    const recipient = managerLib.address
                    await assertMintMulti(details, [1], [bAssets[0]], recipient)
                })
                it("should send fUSD when the recipient is an EOA", async () => {
                    const { bAssets } = details
                    const recipient = sa.dummy1
                    await assertMintMulti(details, [1], [bAssets[0]], recipient.address)
                })
            })
            context("and specifying one bAsset base unit", async () => {
                before(async () => {
                    await runSetup()
                })
                it("should mint a higher q of fAsset base units when using bAsset with 18", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    const decimals = await bAsset.decimals()
                    expect(decimals).eq(18)

                    await bAsset.approve(fAsset.address, 1)

                    const minterBassetBalBefore = await bAsset.balanceOf(sa.default.address)
                    const recipientBalBefore = await fAsset.balanceOf(sa.default.address)

                    const tx = fAsset.mintMulti([bAsset.address], [1], 0, sa.default.address)
                    const expectedFasset = BN.from(10).pow(BN.from(18).sub(decimals))
                    await expect(tx)
                        .to.emit(fAsset, "MintedMulti")
                        .withArgs(sa.default.address, sa.default.address, expectedFasset, [bAsset.address], [1])
                    // Recipient should have fAsset quantity after
                    const recipientBalAfter = await fAsset.balanceOf(sa.default.address)
                    expect(recipientBalAfter).eq(recipientBalBefore.add(expectedFasset))
                    // Sender should have less bAsset after
                    const minterBassetBalAfter = await bAsset.balanceOf(sa.default.address)
                    expect(minterBassetBalAfter).eq(minterBassetBalBefore.sub(1))
                    // Complete basket should remain in healthy state
                    await assertBasketIsHealthy(fAssetMachine, details)
                })
            })
            context("using bAssets with transfer fees", async () => {
                before(async () => {
                    await runSetup(true, true, true)
                })
                it("should handle tokens with transfer fees", async () => {
                    const { bAssets, fAsset, platform } = details
                    await assertBasketIsHealthy(fAssetMachine, details)

                    // 1.0 Assert bAsset has fee
                    const bAsset = bAssets[3]
                    const basket = await fAssetMachine.getBasketComposition(details)
                    expect(basket.bAssets[3].isTransferFeeCharged).to.eq(true)

                    // 2.0 Get balances
                    const minterBassetBalBefore = await bAsset.balanceOf(sa.default.address)
                    const recipient = sa.dummy3
                    const recipientBalBefore = await fAsset.balanceOf(recipient.address)
                    expect(recipientBalBefore).eq(0)
                    const fAssetMintAmount = 10
                    const approval0: BN = await fAssetMachine.approveFasset(bAsset, fAsset, fAssetMintAmount)
                    // 3.0 Do the mint
                    const tx = fAsset.mintMulti([bAsset.address], [approval0], 0, recipient.address)

                    const fAssetQuantity = simpleToExactAmount(fAssetMintAmount, 18)
                    const bAssetQuantity = simpleToExactAmount(fAssetMintAmount, await bAsset.decimals())
                    // take 0.1% off for the transfer fee = amount * (1 - 0.001)
                    const bAssetAmountLessFee = bAssetQuantity.mul(999).div(1000)
                    const platformToken = await platform.bAssetToPToken(bAsset.address)
                    const lendingPlatform = await platform.platformAddress()
                    // 3.1 Check Transfers from sender to platform integration
                    await expect(tx).to.emit(bAsset, "Transfer").withArgs(sa.default.address, platform.address, bAssetAmountLessFee)
                    // 3.2 Check Transfers from platform integration to lending platform
                    await expect(tx).to.emit(bAsset, "Transfer").withArgs(
                        platform.address,
                        lendingPlatform,
                        bAssetAmountLessFee.mul(999).div(1000), // Take another 0.1% off the transfer value
                    )
                    // 3.3 Check Deposits into lending platform
                    await expect(tx).to.emit(platform, "Deposit").withArgs(bAsset.address, platformToken, bAssetAmountLessFee)
                    // 4.0 Recipient should have fAsset quantity after
                    const recipientBalAfter = await fAsset.balanceOf(recipient.address)
                    // Assert that we minted gt 99% of the bAsset
                    assertBNSlightlyGTPercent(recipientBalBefore.add(fAssetQuantity), recipientBalAfter, "0.3")
                    // Sender should have less bAsset after
                    const minterBassetBalAfter = await bAsset.balanceOf(sa.default.address)
                    expect(minterBassetBalAfter, "minterBassetBalAfter").eq(minterBassetBalBefore.sub(bAssetQuantity))

                    // Complete basket should remain in healthy state
                    await assertBasketIsHealthy(fAssetMachine, details)
                })
                it("should fail if the token charges a fee but we don't know about it", async () => {
                    const { bAssets, fAsset } = details
                    await assertBasketIsHealthy(fAssetMachine, details)

                    // 1.0 Assert bAsset has fee
                    const bAsset = bAssets[3]
                    const basket = await fAssetMachine.getBasketComposition(details)
                    expect(basket.bAssets[3].isTransferFeeCharged).to.eq(true)
                    await fAsset.connect(sa.governor.signer).setTransferFeesFlag(bAsset.address, false)

                    // 2.0 Get balances
                    const fAssetMintAmount = 10
                    const approval0: BN = await fAssetMachine.approveFasset(bAsset, fAsset, fAssetMintAmount)
                    // 3.0 Do the mint
                    await expect(fAsset.mintMulti([bAsset.address], [approval0], 0, sa.default.address)).to.revertedWith(
                        "Asset not fully transferred",
                    )
                })
            })
            context("with an affected bAsset", async () => {
                it("should fail if bAsset is broken below peg", async () => {
                    const { bAssets, fAsset } = details
                    await assertBasketIsHealthy(fAssetMachine, details)

                    const bAsset = bAssets[0]
                    await fAsset.connect(sa.governor.signer).handlePegLoss(bAsset.address, true)
                    const newBasset = await fAsset.getBasset(bAsset.address)
                    expect(newBasset.personal.status).to.eq(BassetStatus.BrokenBelowPeg)
                    await fAssetMachine.approveFasset(bAsset, fAsset, 1)
                    await assertFailedMintMulti(
                        "Unhealthy",
                        fAsset,
                        [bAsset.address],
                        ["1000000000000000000"],
                        0,
                        true,
                        sa.default.signer,
                        sa.default.address,
                        false,
                        "1000746841283429855",
                        true,
                    )
                })
            })
            context("passing invalid arguments", async () => {
                before(async () => {
                    await runSetup()
                })
                it("should fail if recipient is 0x0", async () => {
                    const { fAsset, bAssets } = details
                    await assertFailedMintMulti(
                        "Invalid recipient",
                        fAsset,
                        [bAssets[0].address],
                        [1],
                        0,
                        true,
                        sa.default.signer,
                        ZERO_ADDRESS,
                        false,
                        1,
                        true,
                    )
                })
                context("with incorrect bAsset array", async () => {
                    it("should fail if both input arrays are empty", async () => {
                        const { fAsset } = details
                        await assertFailedMintMulti("Input array mismatch", fAsset, [], [])
                    })
                    it("should fail if the bAsset input array is empty", async () => {
                        const { fAsset } = details
                        await assertFailedMintMulti("Input array mismatch", fAsset, [], [1])
                    })
                    it("should fail if there is a length mismatch", async () => {
                        const { fAsset, bAssets } = details
                        await assertFailedMintMulti("Input array mismatch", fAsset, [bAssets[0].address], [1, 1])
                    })
                    it("should fail if there is a length mismatch", async () => {
                        const { fAsset, bAssets } = details
                        await assertFailedMintMulti("Input array mismatch", fAsset, [bAssets[0].address], [1, 1, 1, 1])
                    })
                    it("should fail if there are duplicate bAsset addresses", async () => {
                        const { fAsset, bAssets } = details
                        await assertFailedMintMulti("Duplicate asset", fAsset, [bAssets[0].address, bAssets[0].address], [1, 1])
                    })
                })
                describe("minting with some 0 quantities", async () => {
                    it("should allow minting with some 0 quantities", async () => {
                        const { bAssets } = details
                        const recipient = sa.dummy1
                        await assertMintMulti(details, [1, 0], [bAssets[0], bAssets[1]], recipient.address)
                    })
                    it("should fail if output fAsset quantity is 0", async () => {
                        const { fAsset, bAssets } = details
                        // Get all before balances
                        const bAssetBefore = await Promise.all(bAssets.map((b) => fAsset.getBasset(b.address)))
                        // Approve spending of the bAssets
                        await Promise.all(bAssets.map((b) => fAssetMachine.approveFasset(b, fAsset, 1)))
                        // Pass all 0's
                        await assertFailedMintMulti(
                            "Zero fAsset quantity",
                            fAsset,
                            bAssetBefore.map((b) => b.personal.addr),
                            [0, 0, 0, 0],
                            0,
                            true,
                            sa.default.signer,
                            sa.default.address,
                            false,
                            0,
                        )
                    })
                })
                it("should fail if slippage just too big", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    const sender = sa.default
                    await fAssetMachine.approveFasset(bAsset, fAsset, 101, sender.signer)
                    await assertFailedMintMulti(
                        "Mint quantity < min qty",
                        fAsset,
                        [bAsset.address],
                        ["100000000000000000000"], // 100
                        "100000000000000000001", // just over 100
                        true,
                        sender.signer,
                        sender.address,
                        false,
                        "98939327585405193936", // 0.989...
                        true,
                    )
                })
                it("should fail if sender doesn't have balance", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    const sender = sa.dummy2
                    expect(await bAsset.balanceOf(sender.address)).eq(0)
                    await assertFailedMintMulti(
                        "ERC20: transfer amount exceeds balance",
                        fAsset,
                        [bAsset.address],
                        ["100000000000000000000"],
                        0,
                        false,
                        sender.signer,
                        sender.address,
                        false,
                        "98939327585405193936",
                        true,
                    )
                })
                it("should fail if sender doesn't give approval", async () => {
                    const { bAssets, fAsset } = details
                    const bAsset = bAssets[0]
                    const sender = sa.dummy3
                    await bAsset.transfer(sender.address, 10000)
                    expect(await bAsset.allowance(sender.address, fAsset.address)).eq(0)
                    expect(await bAsset.balanceOf(sender.address)).eq(10000)
                    await assertFailedMintMulti(
                        "ERC20: transfer amount exceeds allowance",
                        fAsset,
                        [bAsset.address],
                        [100],
                        0,
                        false,
                        sender.signer,
                        sa.default.address,
                        false,
                        100,
                        true,
                    )
                })
                it("should fail if the bAsset does not exist", async () => {
                    const { fAsset } = details
                    await assertFailedMintMulti("Invalid asset", fAsset, [sa.dummy4.address], [100])
                })
            })
            describe("minting with various orders", async () => {
                before(async () => {
                    await runSetup()
                })

                it("should mint quantities relating to the order of the bAsset indexes", async () => {
                    const { bAssets, fAsset } = details
                    const compBefore = await fAssetMachine.getBasketComposition(details)
                    await fAssetMachine.approveFasset(bAssets[0], fAsset, 100)
                    await fAssetMachine.approveFasset(bAssets[1], fAsset, 100)

                    // Minting with 2 and 1.. they should correspond to lowest index first
                    await fAsset.mintMulti([bAssets[0].address, bAssets[1].address], [2, 1], 0, sa.default.address)
                    const compAfter = await fAssetMachine.getBasketComposition(details)
                    expect(compAfter.bAssets[0].vaultBalance).eq(BN.from(compBefore.bAssets[0].vaultBalance).add(BN.from(2)))
                    expect(compAfter.bAssets[1].vaultBalance).eq(BN.from(compBefore.bAssets[1].vaultBalance).add(BN.from(1)))
                })
                it("should mint using multiple bAssets", async () => {
                    const { bAssets, fAsset } = details
                    // It's only possible to mint a single base unit of fAsset, if the bAsset also has 18 decimals
                    // For those tokens with 12 decimals, they can at minimum mint 1*10**6 fAsset base units.
                    // Thus, these basic calculations should work in whole fAsset units, with specific tests for
                    // low decimal bAssets
                    const approvals = await fAssetMachine.approveFassetMulti(
                        [bAssets[0], bAssets[1], bAssets[2]],
                        fAsset,
                        1,
                        sa.default.signer,
                    )
                    await fAsset.mintMulti([bAssets[0].address, bAssets[1].address, bAssets[2].address], approvals, 0, sa.default.address)
                    const approvals2 = await fAssetMachine.approveFassetMulti(
                        [bAssets[0], bAssets[1], bAssets[2], bAssets[3]],
                        fAsset,
                        1,
                        sa.default.signer,
                    )
                    const fUsdBalBefore = await fAsset.balanceOf(sa.default.address)
                    await fAsset.mintMulti(
                        [bAssets[0].address, bAssets[1].address, bAssets[2].address, bAssets[3].address],
                        approvals2,
                        0,
                        sa.default.address,
                    )
                    const fUsdBalAfter = await fAsset.balanceOf(sa.default.address)
                    assertBNClosePercent(
                        fUsdBalAfter,
                        fUsdBalBefore.add(simpleToExactAmount(4, 18)),
                        "0.0001",
                        "Must mint 4 full units of fUSD",
                    )
                })
                it("should mint using 2 bAssets", async () => {
                    const { bAssets, fAsset } = details
                    const approvals = await fAssetMachine.approveFassetMulti([bAssets[0], bAssets[2]], fAsset, 1, sa.default.signer)
                    await fAsset.mintMulti([bAssets[0].address, bAssets[2].address], approvals, 0, sa.default.address)
                })
            })
        })
        context("when the fAsset is undergoing re-collateralisation", () => {
            before(async () => {
                await runSetup(true)
            })
            it("should revert any mints", async () => {
                const { bAssets, fAsset } = details
                await assertBasketIsHealthy(fAssetMachine, details)
                const bAsset0 = bAssets[0]
                await fAsset.connect(sa.governor.signer).handlePegLoss(bAsset0.address, true)

                await fAssetMachine.approveFasset(bAsset0, fAsset, 2)
                await expect(fAsset.mintMulti([bAsset0.address], [1], 0, sa.default.address)).to.revertedWith("Unhealthy")
            })
        })
    })
})
