import { ethers } from "hardhat"
import { expect } from "chai"

import { simpleToExactAmount, BN } from "@utils/math"
import { FassetDetails, FassetMachine, StandardAccounts } from "@utils/machines"

import { DEAD_ADDRESS, MAX_UINT256, ONE_DAY, ONE_HOUR, ONE_WEEK, TEN_MINS, ZERO_ADDRESS } from "@utils/constants"
import {
    Fasset,
    MockPlatformIntegration,
    MaliciousAaveIntegration,
    MaliciousAaveIntegration__factory,
    MockERC20,
    MockPlatformIntegration__factory,
    ExposedFasset,
    MockNexus__factory,
} from "types/generated"
import { assertBNSlightlyGTPercent, assertBNClose } from "@utils/assertions"
import { keccak256, toUtf8Bytes } from "ethers/lib/utils"
import { BassetStatus } from "@utils/mstable-objects"
import { getTimestamp, increaseTime } from "@utils/time"

describe("Fasset Admin", () => {
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

    describe("using basic setters", async () => {
        const newSize = simpleToExactAmount(1, 16) // 1%
        let fAsset: Fasset
        before("set up", async () => {
            await runSetup(true)
            fAsset = await details.fAsset.connect(sa.governor.signer)
        })
        describe("should allow changing of the cache size to ", () => {
            it("zero", async () => {
                const tx = fAsset.setCacheSize(0)
                await expect(tx).to.emit(fAsset, "CacheSizeChanged").withArgs(0)
                const { cacheSize } = await fAsset.data()
                expect(cacheSize).eq(0)
            })
            it("1%", async () => {
                const { cacheSize: oldSize } = await fAsset.data()
                expect(oldSize).not.eq(newSize)
                const tx = fAsset.setCacheSize(newSize)
                await expect(tx).to.emit(fAsset, "CacheSizeChanged").withArgs(newSize)
                const { cacheSize } = await fAsset.data()
                expect(cacheSize).eq(newSize)
            })
            it("20% (cap limit)", async () => {
                const capLimit = simpleToExactAmount(20, 16) // 20%
                const tx = fAsset.setCacheSize(capLimit)
                await expect(tx).to.emit(fAsset, "CacheSizeChanged").withArgs(capLimit)
                const { cacheSize } = await fAsset.data()
                expect(cacheSize).eq(capLimit)
            })
        })
        describe("should fail changing the cache size if", () => {
            it("not governor", async () => {
                await expect(details.fAsset.connect(sa.default.signer).setCacheSize(newSize)).to.be.revertedWith(
                    "Only governor can execute",
                )
                await expect(details.fAsset.connect(sa.dummy1.signer).setCacheSize(newSize)).to.be.revertedWith("Only governor can execute")
            })
            it("just over cap", async () => {
                const feeExceedingCap = BN.from("200000000000000001")
                await expect(fAsset.setCacheSize(feeExceedingCap)).to.be.revertedWith("Must be <= 20%")
            })
            it("exceed cap by 1%", async () => {
                const feeExceedingCap = simpleToExactAmount(21, 16) // 21%
                await expect(fAsset.setCacheSize(feeExceedingCap)).to.be.revertedWith("Must be <= 20%")
            })
            it("exceeding cap with max number", async () => {
                await expect(fAsset.setCacheSize(MAX_UINT256)).to.be.revertedWith("Must be <= 20%")
            })
        })
        describe("should change swap and redemption fees to", () => {
            it("0.5% and 0.25%", async () => {
                const { swapFee: oldSwapFee, redemptionFee: oldRedemptionFee } = await fAsset.data()
                const newSwapFee = simpleToExactAmount(0.5, 16)
                const newRedemptionFee = simpleToExactAmount(0.25, 16)
                expect(oldSwapFee).not.eq(newSwapFee)
                expect(oldRedemptionFee).not.eq(newRedemptionFee)
                const tx = fAsset.setFees(newSwapFee, newRedemptionFee)
                await expect(tx).to.emit(fAsset, "FeesChanged").withArgs(newSwapFee, newRedemptionFee)
                const { swapFee, redemptionFee } = await fAsset.data()
                expect(swapFee).eq(newSwapFee)
                expect(redemptionFee).eq(newRedemptionFee)
            })
            it("1% (limit)", async () => {
                const newFee = simpleToExactAmount(1, 16)
                await fAsset.setFees(newFee, newFee)
                const tx = fAsset.setFees(newFee, newFee)
                await expect(tx).to.emit(fAsset, "FeesChanged").withArgs(newFee, newFee)
                const { swapFee, redemptionFee } = await fAsset.data()
                expect(swapFee).eq(newFee)
                expect(redemptionFee).eq(newFee)
            })
        })
        describe("should fail to change swap fee rate when", () => {
            it("not governor", async () => {
                const fee = simpleToExactAmount(1, 16)
                await expect(details.fAsset.setFees(fee, fee)).to.be.revertedWith("Only governor can execute")
            })
            it("Swap rate just exceeds 1% cap", async () => {
                await expect(fAsset.setFees("10000000000000001", "10000000000000000")).to.be.revertedWith("Swap rate oob")
            })
            it("Redemption rate just exceeds 1% cap", async () => {
                await expect(fAsset.setFees("10000000000000000", "10000000000000001")).to.be.revertedWith("Redemption rate oob")
            })
            it("3% rate exceeds 1% cap", async () => {
                const fee = simpleToExactAmount(3, 16) // 3%
                await expect(fAsset.setFees(fee, fee)).to.be.revertedWith("Swap rate oob")
            })
            it("max rate", async () => {
                const fee = MAX_UINT256
                await expect(fAsset.setFees(fee, fee)).to.be.revertedWith("Swap rate oob")
            })
        })
        it("should set max weight", async () => {
            const { weightLimits: beforeWeightLimits } = await fAsset.data()
            const newMinWeight = simpleToExactAmount(1, 16)
            const newMaxWeight = simpleToExactAmount(334, 15)
            const tx = fAsset.setWeightLimits(newMinWeight, newMaxWeight)
            await expect(tx, "WeightLimitsChanged event").to.emit(fAsset, "WeightLimitsChanged").withArgs(newMinWeight, newMaxWeight)
            await tx
            const { weightLimits: afterWeightLimits } = await fAsset.data()
            expect(afterWeightLimits.min, "before and after min weight not equal").not.to.eq(beforeWeightLimits.min)
            expect(afterWeightLimits.max, "before and after max weight not equal").not.to.eq(beforeWeightLimits.max)
            expect(afterWeightLimits.min, "min weight set").to.eq(newMinWeight)
            expect(afterWeightLimits.max, "max weight set").to.eq(newMaxWeight)
        })
        describe("failed set max weight", () => {
            const newMinWeight = simpleToExactAmount(1, 16)
            const newMaxWeight = simpleToExactAmount(620, 15)
            it("should fail setWeightLimits with default signer", async () => {
                await expect(fAsset.connect(sa.default.signer).setWeightLimits(newMinWeight, newMaxWeight)).to.revertedWith(
                    "Only governor can execute",
                )
            })
            it("should fail setWeightLimits with dummy signer", async () => {
                await expect(fAsset.connect(sa.dummy1.signer).setWeightLimits(newMinWeight, newMaxWeight)).to.revertedWith(
                    "Only governor can execute",
                )
            })
            it("should fail setWeightLimits with max weight too small", async () => {
                await expect(fAsset.setWeightLimits(newMinWeight, simpleToExactAmount(332, 15))).to.revertedWith("Max weight oob")
            })
            it("should fail setWeightLimits with min weight too large", async () => {
                await expect(fAsset.setWeightLimits(simpleToExactAmount(14, 16), newMaxWeight)).to.revertedWith("Min weight oob")
            })
        })
        describe("should set transfer fee flag", async () => {
            before(async () => {
                await runSetup(true, false, true)
            })
            it("when no integration balance", async () => {
                const { personal } = await details.fAsset.getBasset(details.bAssets[3].address)
                expect(personal.hasTxFee).to.equal(false)

                const tx = details.fAsset.connect(sa.governor.signer).setTransferFeesFlag(personal.addr, true)
                await expect(tx).to.emit(details.wrappedManagerLib, "TransferFeeEnabled").withArgs(personal.addr, true)
                const { personal: after } = await details.fAsset.getBasset(details.bAssets[3].address)
                expect(after.hasTxFee).to.equal(true)

                // restore the flag back to false
                const tx2 = details.fAsset.connect(sa.governor.signer).setTransferFeesFlag(personal.addr, false)
                await expect(tx2).to.emit(details.wrappedManagerLib, "TransferFeeEnabled").withArgs(personal.addr, false)
                await tx2
                const { personal: end } = await details.fAsset.getBasset(details.bAssets[3].address)
                expect(end.hasTxFee).to.equal(false)
            })
            it("when an integration balance", async () => {
                const { personal } = await details.fAsset.getBasset(details.bAssets[2].address)
                expect(personal.hasTxFee).to.equal(false)

                const tx = details.fAsset.connect(sa.governor.signer).setTransferFeesFlag(personal.addr, true)
                await expect(tx).to.emit(details.wrappedManagerLib, "TransferFeeEnabled").withArgs(personal.addr, true)

                const { personal: after } = await details.fAsset.getBasset(details.bAssets[2].address)
                expect(after.hasTxFee).to.equal(true)

                // restore the flag back to false
                const tx2 = details.fAsset.connect(sa.governor.signer).setTransferFeesFlag(personal.addr, false)
                await expect(tx2).to.emit(details.wrappedManagerLib, "TransferFeeEnabled").withArgs(personal.addr, false)

                const { personal: end } = await details.fAsset.getBasset(details.bAssets[2].address)
                expect(end.hasTxFee).to.equal(false)
            })
        })
    })
    context("getters without setters", () => {
        before("init basset", async () => {
            await runSetup()
        })
        it("get config", async () => {
            const { fAsset } = details
            const config = await fAsset.getConfig()
            expect(config.limits.min, "minWeight").to.eq(simpleToExactAmount(5, 16))
            expect(config.limits.max, "maxWeight").to.eq(simpleToExactAmount(65, 16))
            expect(config.a, "a value").to.eq(10000)
            expect(config.recolFee, "a value").to.eq(simpleToExactAmount(5, 13))
        })
        it("should get bAsset", async () => {
            const { fAsset, bAssets } = details
            const bAsset = await fAsset.getBasset(bAssets[0].address)
            expect(bAsset.personal.addr).to.eq(bAsset[0].addr)
            expect(bAsset.personal.hasTxFee).to.equal(false)
            expect(bAsset.personal.integrator).to.eq(bAsset[0].integrator)
            expect(bAsset.personal.status).to.eq(BassetStatus.Normal)
        })
        it("should fail to get bAsset with address 0x0", async () => {
            await expect(details.fAsset.getBasset(ZERO_ADDRESS)).to.revertedWith("Invalid asset")
        })
        it("should fail to get bAsset not in basket", async () => {
            await expect(details.fAsset.getBasset(sa.dummy1.address)).to.revertedWith("Invalid asset")
        })
    })
    context("collecting interest", async () => {
        const unbalancedWeights = [50, 50, 200, 300]
        beforeEach("init basset with vaults", async () => {
            await runSetup(true, false, true, unbalancedWeights)
            // 1.0 Simulate some activity on the lending markets
            // Fast forward a bit so platform interest can be collected
            await increaseTime(TEN_MINS.toNumber())
        })
        it("Collect interest before any fees have been generated", async () => {
            const { fAsset } = details

            // 1.0 Get all balances and data before
            const { surplus } = await fAsset.data()
            expect(surplus).to.eq(0)
            const totalSupplyBefore = await fAsset.totalSupply()

            // 2.0 Static call collectInterest to validate the return values
            const { mintAmount, newSupply } = await fAsset.connect(sa.mockSavingsManager.signer).callStatic.collectInterest()
            expect(mintAmount, "mintAmount").to.eq(0)
            expect(newSupply, "totalSupply").to.eq(totalSupplyBefore)

            // 3.0 Collect the interest
            const tx = fAsset.connect(sa.mockSavingsManager.signer).collectInterest()
            await expect(tx).to.not.emit(fAsset, "MintedMulti")

            // 4.0 Check outputs
            const { surplus: after } = await fAsset.data()
            expect(after).to.eq(0)
        })
        it("should collect interest after fees generated from swap", async () => {
            const { bAssets, fAsset } = details

            // 1.0 Do the necessary approvals before swap
            await fAssetMachine.approveFasset(bAssets[3], fAsset, 20)
            // Do a swap to generate some fees
            await fAsset.swap(bAssets[3].address, bAssets[2].address, simpleToExactAmount(20, 18), 0, sa.dummy1.address)

            // 2.0 Get all balances and data before
            const { surplus } = await fAsset.data()
            const fAssetBalBefore = await fAsset.balanceOf(sa.mockSavingsManager.address)
            const totalSupplyBefore = await fAsset.totalSupply()

            // 3.0 Check the SavingsManager in the mock Nexus contract
            const nexus = MockNexus__factory.connect(await fAsset.nexus(), sa.default.signer)
            const savingsManagerInNexus = await nexus.getModule(keccak256(toUtf8Bytes("SavingsManager")))
            expect(savingsManagerInNexus, "savingsManagerInNexus").to.eq(sa.mockSavingsManager.address)

            //  4.0 Static call collectInterest to validate the return values
            const { mintAmount, newSupply } = await fAsset.connect(sa.mockSavingsManager.signer).callStatic.collectInterest()
            expect(mintAmount, "mintAmount").to.eq(surplus.sub(1))
            expect(newSupply, "totalSupply").to.eq(totalSupplyBefore.add(surplus).sub(1))

            // 5.0 Collect the interest
            const tx = fAsset.connect(sa.mockSavingsManager.signer).collectInterest()

            // 6.0 Event emits correct unit
            await expect(tx, "MintedMulti event").to.emit(fAsset, "MintedMulti")
            // .withArgs(fAsset.address, sa.mockSavingsManager.address, surplus.sub(1), [], [])
            await tx

            // 7.0 Check outputs
            const { surplus: surplusEnd } = await fAsset.data()
            expect(surplusEnd, "after surplus").to.eq(1)
            expect(await fAsset.balanceOf(sa.mockSavingsManager.address), "after Saving Manager balance").eq(
                fAssetBalBefore.add(surplus).sub(1),
            )
            expect(await fAsset.totalSupply(), "after totalSupply").to.eq(totalSupplyBefore.add(surplus).sub(1))
        })
        it("should collect platform interest", async () => {
            // 1.0 Another Mint to generate platform interest to collect
            await fAssetMachine.seedWithWeightings(details, unbalancedWeights)

            // 2.0 Get all balances and data before
            const fAssetBalBefore = await details.fAsset.balanceOf(sa.mockSavingsManager.address)
            const bassetsBefore = await fAssetMachine.getBassetsInFasset(details)
            // const sumOfVaultsBefore = bassetsBefore.reduce((p, c) => p.add(applyRatio(c.vaultBalance, c.ratio)), BN.from(0))
            const totalSupplyBefore = await details.fAsset.totalSupply()

            // 3.0 Check the SavingsManager in the mock Nexus contract
            const nexus = MockNexus__factory.connect(await details.fAsset.nexus(), sa.default.signer)
            const savingsManagerInNexus = await nexus.getModule(keccak256(toUtf8Bytes("SavingsManager")))
            expect(savingsManagerInNexus, "savingsManagerInNexus").eq(sa.mockSavingsManager.address)

            // 4.0 Static call of collectPlatformInterest
            const fAsset = details.fAsset.connect(sa.mockSavingsManager.signer)
            const { mintAmount, newSupply } = await fAsset.callStatic.collectPlatformInterest()

            // 5.0 Collect platform interest
            const collectPlatformInterestTx = fAsset.collectPlatformInterest()

            // 6.0 Event emits correct unit
            await expect(collectPlatformInterestTx, "MintedMulti event on fAsset")
                .to.emit(fAsset, "MintedMulti")
                .withArgs(
                    fAsset.address,
                    sa.mockSavingsManager.address,
                    mintAmount,
                    [],
                    [0, 0, simpleToExactAmount(4, 9), simpleToExactAmount(6, 15)],
                )
            await expect(collectPlatformInterestTx, "Transfer event on fAsset")
                .to.emit(fAsset, "Transfer")
                .withArgs(ZERO_ADDRESS, sa.mockSavingsManager.address, mintAmount)

            // 7.0 Check outputs
            const fAssetBalAfter = await details.fAsset.balanceOf(sa.mockSavingsManager.address)
            const bassetsAfter = await fAssetMachine.getBassetsInFasset(details)
            bassetsAfter.forEach((b, i) => {
                if (i > 1) {
                    expect(b.vaultBalance, `balance of bAsset[${i}] not increased`).gt(bassetsBefore[i].vaultBalance)
                }
            })
            const totalSupplyAfter = await details.fAsset.totalSupply()
            expect(newSupply).to.eq(totalSupplyAfter)

            // 6.1 totalSupply should only increase by <= 0.0005%
            // assertBNSlightlyGTPercent(totalSupplyAfter, totalSupplyBefore, systemMachine.isGanacheFork ? "0.001" : "0.01", true)
            assertBNSlightlyGTPercent(totalSupplyAfter, totalSupplyBefore, "0.01", true)
            // 6.2 check that increase in vault balance is equivalent to total balance
            const increasedTotalSupply = totalSupplyAfter.sub(totalSupplyBefore)
            expect(mintAmount).to.eq(increasedTotalSupply)
            // 6.3 Ensure that the SavingsManager received the fAsset
            expect(fAssetBalAfter, "fAssetBalAfter").eq(fAssetBalBefore.add(increasedTotalSupply))
        })
        it("should fail to collect platform interest after no activity", async () => {
            const fAsset = details.fAsset.connect(sa.mockSavingsManager.signer)
            await expect(fAsset.callStatic.collectPlatformInterest()).to.revertedWith("Must collect something")
        })
        context("only allow the SavingsManager to collect interest", () => {
            it("should fail governor", async () => {
                const { signer } = sa.governor
                await expect(details.fAsset.connect(signer).collectInterest()).to.be.revertedWith("Must be savings manager")
                await expect(details.fAsset.connect(signer).collectPlatformInterest()).to.be.revertedWith("Must be savings manager")
            })
            it("should fail the default signer that deployed the contracts", async () => {
                const { signer } = sa.default
                await expect(details.fAsset.connect(signer).collectInterest()).to.be.revertedWith("Must be savings manager")
                await expect(details.fAsset.connect(signer).collectPlatformInterest()).to.be.revertedWith("Must be savings manager")
            })
        })
    })

    describe("migrating bAssets between platforms", () => {
        let newMigration: MockPlatformIntegration
        let maliciousIntegration: MaliciousAaveIntegration
        let transferringAsset: MockERC20
        beforeEach(async () => {
            await runSetup(false, false, true)
            ;[, , , transferringAsset] = details.bAssets
            newMigration = await (
                await new MockPlatformIntegration__factory(sa.default.signer)
            ).deploy(
                DEAD_ADDRESS,
                details.aavePlatformAddress,
                details.bAssets.map((b) => b.address),
                details.pTokens,
            )
            await newMigration.addWhitelist([details.fAsset.address])
            maliciousIntegration = await (
                await new MaliciousAaveIntegration__factory(sa.default.signer)
            ).deploy(
                DEAD_ADDRESS,
                details.aavePlatformAddress,
                details.bAssets.map((b) => b.address),
                details.pTokens,
            )
            await maliciousIntegration.addWhitelist([details.fAsset.address])
        })
        it("should fail if passed 0 bAssets", async () => {
            await expect(details.fAsset.connect(sa.governor.signer).migrateBassets([], newMigration.address)).to.be.revertedWith(
                "Must migrate some bAssets",
            )
        })
        it("should fail if bAsset does not exist", async () => {
            await expect(
                details.fAsset.connect(sa.governor.signer).migrateBassets([DEAD_ADDRESS], newMigration.address),
            ).to.be.revertedWith("Invalid asset")
        })
        it("should fail if integrator address is the same", async () => {
            await expect(
                details.fAsset.connect(sa.governor.signer).migrateBassets([transferringAsset.address], details.platform.address),
            ).to.be.revertedWith("Must transfer to new integrator")
        })
        it("should fail if new address is a dud", async () => {
            await expect(details.fAsset.connect(sa.governor.signer).migrateBassets([transferringAsset.address], DEAD_ADDRESS)).to.be
                .reverted
        })
        it("should fail if the full amount is not transferred and deposited", async () => {
            await transferringAsset.transfer(details.platform.address, 10000)
            await details.platform.addWhitelist([sa.governor.address])
            await details.platform.connect(sa.governor.signer).deposit(transferringAsset.address, 9000, false)
            await expect(
                details.fAsset.connect(sa.governor.signer).migrateBassets([transferringAsset.address], maliciousIntegration.address),
            ).to.be.revertedWith("Must transfer full amount")
        })
        it("should move all bAssets from a to b", async () => {
            await transferringAsset.transfer(details.platform.address, 10000)
            await details.platform.addWhitelist([sa.governor.address])
            await details.platform.connect(sa.governor.signer).deposit(transferringAsset.address, 9000, false)
            // get balances before
            const bal = await details.platform.callStatic.checkBalance(transferringAsset.address)
            expect(bal).eq(9000)
            const rawBal = await transferringAsset.balanceOf(details.platform.address)
            expect(rawBal).eq(1000)
            const integratorAddress = (await details.fAsset.getBasset(transferringAsset.address))[0][1]
            expect(integratorAddress).eq(details.platform.address)
            // call migrate
            const tx = details.fAsset.connect(sa.governor.signer).migrateBassets([transferringAsset.address], newMigration.address)
            // emits BassetsMigrated
            await expect(tx)
                .to.emit(details.wrappedManagerLib, "BassetsMigrated")
                .withArgs([transferringAsset.address], newMigration.address)
            // moves all bAssets from old to new
            const migratedBal = await newMigration.callStatic.checkBalance(transferringAsset.address)
            expect(migratedBal).eq(bal)
            const migratedRawBal = await transferringAsset.balanceOf(newMigration.address)
            expect(migratedRawBal).eq(rawBal)
            // old balances should be empty
            const newRawBal = await transferringAsset.balanceOf(details.platform.address)
            expect(newRawBal).eq(0)
            // updates the integrator address
            const [[, newIntegratorAddress]] = await details.fAsset.getBasset(transferringAsset.address)
            expect(newIntegratorAddress).eq(newMigration.address)
        })
        it("should pass if either rawBalance or balance are 0", async () => {
            await transferringAsset.transfer(details.platform.address, 10000)
            await details.platform.addWhitelist([sa.governor.address])
            await details.platform.connect(sa.governor.signer).deposit(transferringAsset.address, 10000, false)
            // get balances before
            const bal = await details.platform.callStatic.checkBalance(transferringAsset.address)
            expect(bal).eq(10000)
            const rawBal = await transferringAsset.balanceOf(details.platform.address)
            expect(rawBal).eq(0)
            const integratorAddress = (await details.fAsset.getBasset(transferringAsset.address))[0][1]
            expect(integratorAddress).eq(details.platform.address)
            // call migrate
            const tx = details.fAsset.connect(sa.governor.signer).migrateBassets([transferringAsset.address], newMigration.address)
            // emits BassetsMigrated
            await expect(tx)
                .to.emit(details.wrappedManagerLib, "BassetsMigrated")
                .withArgs([transferringAsset.address], newMigration.address)
            // moves all bAssets from old to new
            const migratedBal = await newMigration.callStatic.checkBalance(transferringAsset.address)
            expect(migratedBal).eq(bal)
            const migratedRawBal = await transferringAsset.balanceOf(newMigration.address)
            expect(migratedRawBal).eq(rawBal)
            // updates the integrator address
            const [[, newIntegratorAddress]] = await details.fAsset.getBasset(transferringAsset.address)
            expect(newIntegratorAddress).eq(newMigration.address)
        })
    })
    describe("when going from no platform to a platform", () => {
        let newMigration: MockPlatformIntegration
        let transferringAsset: MockERC20
        before(async () => {
            await runSetup(true, false, false)
            const lendingDetail = await fAssetMachine.loadATokens(details.bAssets)
            ;[, , , transferringAsset] = details.bAssets
            newMigration = await (
                await new MockPlatformIntegration__factory(sa.default.signer)
            ).deploy(
                DEAD_ADDRESS,
                lendingDetail.aavePlatformAddress,
                details.bAssets.map((b) => b.address),
                lendingDetail.aTokens.map((a) => a.aToken),
            )
            await newMigration.addWhitelist([details.fAsset.address])
        })
        it("should migrate everything correctly", async () => {
            // get balances before
            const rawBalBefore = await (await details.fAsset.getBasset(transferringAsset.address))[1][1]
            const integratorAddress = (await details.fAsset.getBasset(transferringAsset.address))[0][1]
            expect(integratorAddress).eq(ZERO_ADDRESS)
            // call migrate
            const tx = details.fAsset.connect(sa.governor.signer).migrateBassets([transferringAsset.address], newMigration.address)
            // emits BassetsMigrated
            await expect(tx)
                .to.emit(details.wrappedManagerLib, "BassetsMigrated")
                .withArgs([transferringAsset.address], newMigration.address)
            // moves all bAssets from old to new
            const migratedBal = await newMigration.callStatic.checkBalance(transferringAsset.address)
            expect(migratedBal).eq(0)
            const migratedRawBal = await transferringAsset.balanceOf(newMigration.address)
            expect(migratedRawBal).eq(rawBalBefore)
            // old balances should be empty
            const newRawBal = await transferringAsset.balanceOf(details.fAsset.address)
            expect(newRawBal).eq(0)
            // updates the integrator address
            const [[, newIntegratorAddress]] = await details.fAsset.getBasset(transferringAsset.address)
            expect(newIntegratorAddress).eq(newMigration.address)
        })
    })

    describe("negateIsolation()", async () => {
        before("init basset with vaults", async () => {
            await runSetup(true, false, true)
        })
        it("should skip when Normal (by governor)", async () => {
            const { bAssets, fAsset, wrappedManagerLib } = details
            const basketBefore = await fAsset.getBasket()
            expect(basketBefore[0]).to.equal(false)
            const tx = fAsset.connect(sa.governor.signer).negateIsolation(bAssets[0].address)
            await expect(tx).to.emit(wrappedManagerLib, "BassetStatusChanged").withArgs(bAssets[0].address, BassetStatus.Normal)
            const afterBefore = await fAsset.getBasket()
            expect(afterBefore[0]).to.equal(false)
        })
        it("should fail when called by default", async () => {
            const { bAssets, fAsset } = details
            await expect(fAsset.connect(sa.default.signer).negateIsolation(bAssets[0].address)).to.revertedWith("Only governor can execute")
        })
        it("should fail when not called by governor", async () => {
            const { bAssets, fAsset } = details
            await expect(fAsset.connect(sa.other.signer).negateIsolation(bAssets[0].address)).to.revertedWith("Only governor can execute")
        })
        it("should fail when wrong bAsset address passed", async () => {
            const { fAsset } = details
            await expect(fAsset.connect(sa.governor.signer).negateIsolation(sa.other.address)).to.be.revertedWith("Invalid asset")
        })
        it("should succeed when status is 'BrokenAbovePeg' (by governor)", async () => {
            const { bAssets, fAsset, wrappedManagerLib } = details
            const bAsset = bAssets[1]

            const basketBefore = await fAsset.getBasket()
            expect(basketBefore[0], "before undergoingRecol").to.equal(false)
            const bAssetStateBefore = await fAsset.getBasset(bAsset.address)
            expect(bAssetStateBefore.personal.status).to.eq(BassetStatus.Normal)

            await fAsset.connect(sa.governor.signer).handlePegLoss(bAsset.address, false)

            const basketAfterPegLoss = await fAsset.getBasket()
            expect(basketAfterPegLoss[0], "after handlePegLoss undergoingRecol").to.equal(true)
            const bAssetStateAfterPegLoss = await fAsset.getBasset(bAsset.address)
            expect(bAssetStateAfterPegLoss.personal.status, "after handlePegLoss personal.status").to.eq(BassetStatus.BrokenAbovePeg)

            const tx = fAsset.connect(sa.governor.signer).negateIsolation(bAsset.address)

            await expect(tx).to.emit(wrappedManagerLib, "BassetStatusChanged").withArgs(bAsset.address, BassetStatus.Normal)
            await tx
            const basketAfterNegateIsolation = await fAsset.getBasket()
            expect(basketAfterNegateIsolation[0], "after negateIsolation undergoingRecol").to.equal(false)
            const bAssetStateAfterNegateIsolation = await fAsset.getBasset(bAsset.address)
            expect(bAssetStateAfterNegateIsolation.personal.status, "after negateIsolation personal.status").to.eq(BassetStatus.Normal)
        })
        it("should succeed when two bAssets have BrokenBelowPeg", async () => {
            const { bAssets, fAsset, wrappedManagerLib } = details

            const basketBefore = await fAsset.getBasket()
            expect(basketBefore[0], "before undergoingRecol").to.equal(false)

            await fAsset.connect(sa.governor.signer).handlePegLoss(bAssets[2].address, true)
            await fAsset.connect(sa.governor.signer).handlePegLoss(bAssets[3].address, true)

            const basketAfterPegLoss = await fAsset.getBasket()
            expect(basketAfterPegLoss[0], "after handlePegLoss undergoingRecol").to.equal(true)
            const bAsset2StateAfterPegLoss = await fAsset.getBasset(bAssets[2].address)
            expect(bAsset2StateAfterPegLoss.personal.status, "after handlePegLoss personal.status 2").to.eq(BassetStatus.BrokenBelowPeg)
            const bAsset3StateAfterPegLoss = await fAsset.getBasset(bAssets[3].address)
            expect(bAsset3StateAfterPegLoss.personal.status, "after handlePegLoss personal.status 3").to.eq(BassetStatus.BrokenBelowPeg)

            const tx = fAsset.connect(sa.governor.signer).negateIsolation(bAssets[3].address)

            await expect(tx).to.emit(wrappedManagerLib, "BassetStatusChanged").withArgs(bAssets[3].address, BassetStatus.Normal)
            await tx
            const basketAfterNegateIsolation = await fAsset.getBasket()
            expect(basketAfterNegateIsolation[0], "after negateIsolation undergoingRecol").to.equal(true)
            const bAsset2AfterNegateIsolation = await fAsset.getBasset(bAssets[2].address)
            expect(bAsset2AfterNegateIsolation.personal.status, "after negateIsolation personal.status 2").to.eq(
                BassetStatus.BrokenBelowPeg,
            )
            const bAsset3AfterNegateIsolation = await fAsset.getBasset(bAssets[3].address)
            expect(bAsset3AfterNegateIsolation.personal.status, "after negateIsolation personal.status 3").to.eq(BassetStatus.Normal)
        })
    })
    describe("Amplification coefficient", () => {
        before(async () => {
            await runSetup()
        })
        it("should succeed in starting increase over 2 weeks", async () => {
            const fAsset = details.fAsset.connect(sa.governor.signer)
            const { ampData: ampDataBefore } = await fAsset.data()

            // default values
            expect(ampDataBefore.initialA, "before initialA").to.eq(10000)
            expect(ampDataBefore.targetA, "before targetA").to.eq(10000)
            expect(ampDataBefore.rampStartTime, "before rampStartTime").to.eq(0)
            expect(ampDataBefore.rampEndTime, "before rampEndTime").to.eq(0)

            const startTime = await getTimestamp()
            const endTime = startTime.add(ONE_WEEK.mul(2))
            const tx = fAsset.startRampA(120, endTime)
            await expect(tx).to.emit(details.wrappedManagerLib, "StartRampA").withArgs(10000, 12000, startTime.add(1), endTime)

            // after values
            const { ampData: ampDataAfter } = await fAsset.data()
            expect(ampDataAfter.initialA, "after initialA").to.eq(10000)
            expect(ampDataAfter.targetA, "after targetA").to.eq(12000)
            expect(ampDataAfter.rampStartTime, "after rampStartTime").to.eq(startTime.add(1))
            expect(ampDataAfter.rampEndTime, "after rampEndTime").to.eq(endTime)
        })
        context("increasing A by 20 over 10 day period", () => {
            let startTime: BN
            let endTime: BN
            let fAsset: ExposedFasset
            before(async () => {
                await runSetup()
                fAsset = details.fAsset.connect(sa.governor.signer)
                startTime = await getTimestamp()
                endTime = startTime.add(ONE_DAY.mul(10))
                await fAsset.startRampA(120, endTime)
            })
            it("should succeed getting A just after start", async () => {
                expect(await fAsset.getA()).to.eq(10000)
            })
            const testsData = [
                {
                    // 60 * 60 * 24 * 10 / 2000 = 432
                    desc: "just under before increment",
                    elapsedSeconds: 431,
                    expectedValue: 10000,
                },
                {
                    desc: "just under after increment",
                    elapsedSeconds: 434,
                    expectedValue: 10001,
                },
                {
                    desc: "after 1 day",
                    elapsedSeconds: ONE_DAY.add(1),
                    expectedValue: 10200,
                },
                {
                    desc: "after 9 days",
                    elapsedSeconds: ONE_DAY.mul(9).add(1),
                    expectedValue: 11800,
                },
                {
                    desc: "just under 10 days",
                    elapsedSeconds: ONE_DAY.mul(10).sub(2),
                    expectedValue: 11999,
                },
                {
                    desc: "after 10 days",
                    elapsedSeconds: ONE_DAY.mul(10),
                    expectedValue: 12000,
                },
                {
                    desc: "after 11 days",
                    elapsedSeconds: ONE_DAY.mul(11),
                    expectedValue: 12000,
                },
            ]
            testsData.forEach((testData) =>
                it(`should succeed getting A ${testData.desc}`, async () => {
                    const currentTime = await getTimestamp()
                    const incrementSeconds = startTime.add(testData.elapsedSeconds).sub(currentTime)
                    await increaseTime(incrementSeconds)
                    assertBNClose(await fAsset.getA(), BN.from(testData.expectedValue), 5)
                }),
            )
        })
        context("A target changes just in range", () => {
            let currentA: BN
            let startTime: BN
            let endTime: BN
            beforeEach(async () => {
                await runSetup()
                currentA = await details.fAsset.getA()
                startTime = await getTimestamp()
                endTime = startTime.add(ONE_DAY.mul(7))
            })
            it("should increase target A 10x", async () => {
                // target = current * 10 / 100
                // the 100 is the precision
                const targetA = currentA.div(10)
                await details.fAsset.connect(sa.governor.signer).startRampA(targetA, endTime)

                const { ampData: ampDataAfter } = await details.fAsset.data()
                expect(ampDataAfter.targetA, "after targetA").to.eq(targetA.mul(100))
            })
            it("should decrease target A 10x", async () => {
                // target = current / 100 / 10
                // the 100 is the precision
                const targetA = currentA.div(1000)
                await details.fAsset.connect(sa.governor.signer).startRampA(targetA, endTime)

                const { ampData: ampDataAfter } = await details.fAsset.data()
                expect(ampDataAfter.targetA, "after targetA").to.eq(targetA.mul(100))
            })
        })
        context("decreasing A by 50 over 5 days", () => {
            let startTime: BN
            let endTime: BN
            let fAsset: ExposedFasset
            before(async () => {
                await runSetup()
                fAsset = details.fAsset.connect(sa.governor.signer)
                startTime = await getTimestamp()
                endTime = startTime.add(ONE_DAY.mul(5))
                await fAsset.startRampA(50, endTime)
            })
            it("should succeed getting A just after start", async () => {
                expect(await fAsset.getA()).to.eq(10000)
            })
            const testsData = [
                {
                    // 60 * 60 * 24 * 5 / 5000 = 86
                    desc: "just under before increment",
                    elapsedSeconds: 84,
                    expectedValue: 10000,
                },
                {
                    desc: "just under after increment",
                    elapsedSeconds: 88,
                    expectedValue: 9999,
                },
                {
                    desc: "after 1 day",
                    elapsedSeconds: ONE_DAY.add(1),
                    expectedValue: 9000,
                },
                {
                    desc: "after 4 days",
                    elapsedSeconds: ONE_DAY.mul(4).add(1),
                    expectedValue: 6000,
                },
                {
                    desc: "just under 5 days",
                    elapsedSeconds: ONE_DAY.mul(5).sub(2),
                    expectedValue: 5001,
                },
                {
                    desc: "after 5 days",
                    elapsedSeconds: ONE_DAY.mul(5),
                    expectedValue: 5000,
                },
                {
                    desc: "after 6 days",
                    elapsedSeconds: ONE_DAY.mul(6),
                    expectedValue: 5000,
                },
            ]
            testsData.forEach((testData) =>
                it(`should succeed getting A ${testData.desc}`, async () => {
                    const currentTime = await getTimestamp()
                    const incrementSeconds = startTime.add(testData.elapsedSeconds).sub(currentTime)
                    await increaseTime(incrementSeconds)
                    expect(await fAsset.getA()).to.eq(testData.expectedValue)
                }),
            )
        })
        describe("should fail to start ramp A", () => {
            before(async () => {
                await runSetup()
            })
            it("when ramp up time only 1 hour", async () => {
                await expect(details.fAsset.connect(sa.governor.signer).startRampA(12000, ONE_HOUR)).to.revertedWith("Ramp time too short")
            })
            it("when ramp up time just less than 1 day", async () => {
                await expect(details.fAsset.connect(sa.governor.signer).startRampA(12000, ONE_DAY.sub(1))).to.revertedWith(
                    "Ramp time too short",
                )
            })
            it("when A target too big", async () => {
                const startTime = await getTimestamp()
                const endTime = startTime.add(ONE_DAY.mul(7))
                await expect(details.fAsset.connect(sa.governor.signer).startRampA(1000000, endTime)).to.revertedWith(
                    "A target out of bounds",
                )
            })
            it("when A target increase greater than 10x", async () => {
                const currentA = await details.fAsset.getA()
                // target = current * 10 / 100
                // the 100 is the precision
                const targetA = currentA.div(10).add(1)
                const startTime = await getTimestamp()
                const endTime = startTime.add(ONE_DAY.mul(7))
                await expect(details.fAsset.connect(sa.governor.signer).startRampA(targetA, endTime)).to.revertedWith(
                    "A target increase too big",
                )
            })
            it("when A target decrease greater than 10x", async () => {
                const currentA = await details.fAsset.getA()
                // target = current / 100 / 10
                // the 100 is the precision
                const targetA = currentA.div(1000).sub(1)
                const startTime = await getTimestamp()
                const endTime = startTime.add(ONE_DAY.mul(7))
                await expect(details.fAsset.connect(sa.governor.signer).startRampA(targetA, endTime)).to.revertedWith(
                    "A target decrease too big",
                )
            })
            it("when A target is zero", async () => {
                const startTime = await getTimestamp()
                const endTime = startTime.add(ONE_DAY.mul(7))
                await expect(details.fAsset.connect(sa.governor.signer).startRampA(0, endTime)).to.revertedWith("A target out of bounds")
            })
            it("when starting just less than a day after the last finished", async () => {
                const fAsset = details.fAsset.connect(sa.governor.signer)
                const startTime = await getTimestamp()
                const endTime = startTime.add(ONE_DAY.mul(2))
                await fAsset.startRampA(130, endTime)

                // increment 1 day
                await increaseTime(ONE_HOUR.mul(20))

                const secondStartTime = await getTimestamp()
                const secondEndTime = secondStartTime.add(ONE_DAY.mul(7))
                await expect(fAsset.startRampA(150, secondEndTime)).to.revertedWith("Sufficient period of previous ramp has not elapsed")
            })
        })
        context("stop ramp A", () => {
            let startTime: BN
            let endTime: BN
            let fAsset: ExposedFasset
            before(async () => {
                await runSetup()
                fAsset = details.fAsset.connect(sa.governor.signer)
                startTime = await getTimestamp()
                endTime = startTime.add(ONE_DAY.mul(5))
                await fAsset.startRampA(50, endTime)
            })
            it("should stop decreasing A after a day", async () => {
                // increment 1 day
                await increaseTime(ONE_DAY)

                const currentA = await fAsset.getA()
                const currentTime = await getTimestamp()
                const tx = fAsset.stopRampA()
                await expect(tx).to.emit(details.wrappedManagerLib, "StopRampA").withArgs(currentA, currentTime.add(1))
                expect(await fAsset.getA()).to.eq(currentA)

                const { ampData: ampDataAfter } = await fAsset.data()
                expect(ampDataAfter.initialA, "after initialA").to.eq(currentA)
                expect(ampDataAfter.targetA, "after targetA").to.eq(currentA)
                expect(ampDataAfter.rampStartTime.toNumber(), "after rampStartTime").to.within(
                    currentTime.toNumber(),
                    currentTime.add(2).toNumber(),
                )
                expect(ampDataAfter.rampEndTime.toNumber(), "after rampEndTime").to.within(
                    currentTime.toNumber(),
                    currentTime.add(2).toNumber(),
                )

                // increment another 2 days
                await increaseTime(ONE_DAY.mul(2))
                expect(await fAsset.getA()).to.eq(currentA)
            })
        })
        describe("should fail to stop ramp A", () => {
            before(async () => {
                await runSetup()
                const fAsset = details.fAsset.connect(sa.governor.signer)
                const startTime = await getTimestamp()
                const endTime = startTime.add(ONE_DAY.mul(2))
                await fAsset.startRampA(50, endTime)
            })
            it("After ramp has complete", async () => {
                // increment 2 days
                await increaseTime(ONE_DAY.mul(2).add(1))
                await expect(details.fAsset.connect(sa.governor.signer).stopRampA()).to.revertedWith("Amplification not changing")
            })
        })
    })
})
