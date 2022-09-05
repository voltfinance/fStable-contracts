import { ethers } from "hardhat"
import { expect } from "chai"

import { simpleToExactAmount } from "@utils/math"
import { FassetMachine, StandardAccounts } from "@utils/machines"

import {
    MockERC20,
    MockNexus__factory,
    MockNexus,
    RevenueSplitBuyBack__factory,
    RevenueSplitBuyBack,
    MockUniswapV3,
    MockUniswapV3__factory,
    EmissionsController,
    MockStakingContract,
    MockStakingContract__factory,
    MockFasset__factory,
    MockFasset,
    EmissionsController__factory,
} from "types/generated"
import { EncodedPaths, encodeUniswapPath } from "@utils/peripheral/uniswap"
import { DEAD_ADDRESS, ZERO_ADDRESS } from "@utils/constants"
import { BigNumber, Signer, Wallet } from "ethers"
import { MCCP24_CONFIG } from "tasks/utils/emissions-utils"

describe("RevenueSplitBuyBack", () => {
    let sa: StandardAccounts
    let fAssetMachine: FassetMachine
    let nexus: MockNexus
    let revenueBuyBack: RevenueSplitBuyBack
    let fUSD: MockFasset
    let mBTC: MockFasset
    let bAsset1: MockERC20
    let bAsset2: MockERC20
    let rewardsToken: MockERC20
    let staking1: MockStakingContract
    let staking2: MockStakingContract
    let emissionController: EmissionsController
    let uniswap: MockUniswapV3
    let uniswapFusdBasset1Paths: EncodedPaths
    let uniswapMbtcBasset2Paths: EncodedPaths

    const treasuryFee = simpleToExactAmount(0.4)
    const treasury: Signer = ethers.Wallet.createRandom()

    /*
        Test Data
        fAssets: fUSD and mBTC with 18 decimals
     */
    const setupRevenueBuyBack = async (_treasuryFee: BigNumber): Promise<void> => {
        fUSD = await new MockFasset__factory(sa.default.signer).deploy(
            "meta USD",
            "fUSD",
            18,
            sa.default.address,
            simpleToExactAmount(1000000),
        )
        bAsset1 = await fAssetMachine.loadBassetProxy("USD bAsset", "bUSD", 18)

        mBTC = await new MockFasset__factory(sa.default.signer).deploy("meta BTC", "mBTC", 18, sa.default.address, simpleToExactAmount(100))
        bAsset2 = await fAssetMachine.loadBassetProxy("USD bAsset", "bUSD", 6)

        rewardsToken = await fAssetMachine.loadBassetProxy("Rewards Token", "RWD", 18)

        // staking contracts
        staking1 = await new MockStakingContract__factory(sa.default.signer).deploy()
        staking2 = await new MockStakingContract__factory(sa.default.signer).deploy()
        await staking1.setTotalSupply(simpleToExactAmount(3000000))
        await staking2.setTotalSupply(simpleToExactAmount(1000000))

        // Deploy mock Nexus
        nexus = await new MockNexus__factory(sa.default.signer).deploy(
            sa.governor.address,
            sa.mockSavingsManager.address,
            sa.mockInterestValidator.address,
        )
        await nexus.setKeeper(sa.keeper.address)

        // Mocked Uniswap V3
        uniswap = await new MockUniswapV3__factory(sa.default.signer).deploy()
        // Add rewards to Uniswap
        await rewardsToken.transfer(uniswap.address, simpleToExactAmount(500000))
        // Add bAsset to rewards exchange rates
        await uniswap.setRate(bAsset1.address, rewardsToken.address, simpleToExactAmount(80, 16)) // 0.8 MTA/USD
        await uniswap.setRate(bAsset2.address, rewardsToken.address, simpleToExactAmount(50, 33)) // 50,000 MTA/BTC
        // Uniswap paths
        uniswapFusdBasset1Paths = encodeUniswapPath([bAsset1.address, DEAD_ADDRESS, rewardsToken.address], [3000, 3000])
        uniswapMbtcBasset2Paths = encodeUniswapPath([bAsset2.address, DEAD_ADDRESS, rewardsToken.address], [3000, 3000])

        // Deploy Emissions Controller
        emissionController = await new EmissionsController__factory(sa.default.signer).deploy(
            nexus.address,
            rewardsToken.address,
            MCCP24_CONFIG,
        )
        await emissionController.initialize(
            [staking1.address, staking2.address],
            [10, 10],
            [true, true],
            [staking1.address, staking2.address],
        )
        await rewardsToken.transfer(emissionController.address, simpleToExactAmount(10000))

        // Deploy and initialize test RevenueSplitBuyBack
        revenueBuyBack = await new RevenueSplitBuyBack__factory(sa.default.signer).deploy(
            nexus.address,
            rewardsToken.address,
            uniswap.address,
            emissionController.address,
        )
        // reverse the order to make sure dial id != staking contract id for testing purposes
        await revenueBuyBack.initialize([1, 0], await treasury.getAddress(), _treasuryFee)

        // Add config to buy rewards from fAssets
        await revenueBuyBack.connect(sa.governor.signer).mapBasset(fUSD.address, bAsset1.address)
        await revenueBuyBack.connect(sa.governor.signer).mapBasset(mBTC.address, bAsset2.address)
    }

    before(async () => {
        const accounts = await ethers.getSigners()
        fAssetMachine = await new FassetMachine().initAccounts(accounts)
        sa = fAssetMachine.sa
    })

    describe("creating new instance", () => {
        before(async () => {
            await setupRevenueBuyBack(treasuryFee)
        })
        it("should have immutable variables set", async () => {
            expect(await revenueBuyBack.nexus(), "Nexus").eq(nexus.address)
            expect(await revenueBuyBack.REWARDS_TOKEN(), "Rewards Token").eq(rewardsToken.address)
            expect(await revenueBuyBack.UNISWAP_ROUTER(), "Uniswap Router").eq(uniswap.address)
            expect(await revenueBuyBack.EMISSIONS_CONTROLLER(), "Emissions Controller").eq(emissionController.address)
        })
        it("should have storage variables set", async () => {
            expect(await revenueBuyBack.treasuryFee(), "Treasury Fee").eq(treasuryFee)
            expect(await revenueBuyBack.stakingDialIds(0), "Staking Contract 1 dial id").eq(1)
            expect(await revenueBuyBack.stakingDialIds(1), "Staking Contract 2 dial id").eq(0)
            expect((await emissionController.dials(0)).recipient, "first dial is first staking contract").to.eq(staking1.address)
            expect((await emissionController.dials(1)).recipient, "second dial is second staking contract").to.eq(staking2.address)

            expect(await revenueBuyBack.treasuryFee(), "Rreasury Fee").eq(treasuryFee)
        })
        describe("when setting new treasury fee", async () => {
            it("should update treasury fee", async () => {
                expect(await revenueBuyBack.treasuryFee(), "Treasury Fee").eq(treasuryFee)
                const newTreasuryFee = simpleToExactAmount(0.6)
                const tx = revenueBuyBack.connect(sa.governor.signer).setTreasuryFee(newTreasuryFee)
                await expect(tx).to.emit(revenueBuyBack, "TreasuryFeeChanged").withArgs(newTreasuryFee)
                expect(await revenueBuyBack.treasuryFee(), "Treasury Fee").eq(newTreasuryFee)
            })
            it("should not update if not governor", async () => {
                const newTreasuryFee = simpleToExactAmount(0.6)
                const tx = revenueBuyBack.connect(sa.default.signer).setTreasuryFee(newTreasuryFee)
                await expect(tx).to.be.revertedWith("Only governor can execute")
            })
            it("should not update if invalid treasury fee", async () => {
                const newTreasuryFee = simpleToExactAmount(1.6)
                const tx = revenueBuyBack.connect(sa.governor.signer).setTreasuryFee(newTreasuryFee)
                await expect(tx).to.be.revertedWith("Invalid treasury fee")
            })
        })
        describe("should fail deploy if invalid", () => {
            it("nexus", async () => {
                const tx = new RevenueSplitBuyBack__factory(sa.default.signer).deploy(
                    ZERO_ADDRESS,
                    rewardsToken.address,
                    uniswap.address,
                    emissionController.address,
                )
                await expect(tx).to.revertedWith("Nexus address is zero")
            })
            it("rewards token", async () => {
                const tx = new RevenueSplitBuyBack__factory(sa.default.signer).deploy(
                    nexus.address,
                    ZERO_ADDRESS,
                    uniswap.address,
                    emissionController.address,
                )
                await expect(tx).to.revertedWith("Rewards token is zero")
            })
            it("Uniswap router", async () => {
                const tx = new RevenueSplitBuyBack__factory(sa.default.signer).deploy(
                    nexus.address,
                    rewardsToken.address,
                    ZERO_ADDRESS,
                    emissionController.address,
                )
                await expect(tx).to.revertedWith("Uniswap Router is zero")
            })
            it("Emissions controller", async () => {
                const tx = new RevenueSplitBuyBack__factory(sa.default.signer).deploy(
                    nexus.address,
                    rewardsToken.address,
                    uniswap.address,
                    ZERO_ADDRESS,
                )
                await expect(tx).to.revertedWith("Emissions controller is zero")
            })
        })
        describe("should fail initialize if", () => {
            before(async () => {
                revenueBuyBack = await new RevenueSplitBuyBack__factory(sa.default.signer).deploy(
                    nexus.address,
                    rewardsToken.address,
                    uniswap.address,
                    emissionController.address,
                )
            })
            it("zero treasury address", async () => {
                const tx = revenueBuyBack.initialize([1, 0], ZERO_ADDRESS, treasuryFee)
                await expect(tx).to.revertedWith("Treasury is zero")
            })
            it("treasury fee too big", async () => {
                const tx = revenueBuyBack.initialize([1, 0], await treasury.getAddress(), simpleToExactAmount(11, 17))
                await expect(tx).to.revertedWith("Invalid treasury fee")
            })
            it("initialize called again", async () => {
                await revenueBuyBack.initialize([1, 0], await treasury.getAddress(), treasuryFee)
                const tx = revenueBuyBack.initialize([1, 0], await treasury.getAddress(), treasuryFee)
                await expect(tx).to.revertedWith("Initializable: contract is already initialized")
            })
        })
    })
    describe("notification of revenue", () => {
        before(async () => {
            await setupRevenueBuyBack(treasuryFee)
        })
        it("should simply transfer from the sender", async () => {
            const senderBalBefore = await fUSD.balanceOf(sa.default.address)
            const revenueBuyBackBalBefore = await fUSD.balanceOf(revenueBuyBack.address)
            const notificationAmount = simpleToExactAmount(100, 18)
            expect(senderBalBefore.gte(notificationAmount), "sender rewards bal before").to.eq(true)

            // approve
            await fUSD.approve(revenueBuyBack.address, notificationAmount)
            // call
            const tx = revenueBuyBack.notifyRedistributionAmount(fUSD.address, notificationAmount)
            await expect(tx).to.emit(revenueBuyBack, "RevenueReceived").withArgs(fUSD.address, notificationAmount)

            // check output balances: fAsset sender/recipient
            expect(await fUSD.balanceOf(sa.default.address), "fUSD sender bal after").eq(senderBalBefore.sub(notificationAmount))
            expect(await fUSD.balanceOf(revenueBuyBack.address), "fUSD RevenueBuyBack bal after").eq(
                revenueBuyBackBalBefore.add(notificationAmount),
            )
        })
        describe("it should fail if", () => {
            it("not configured fAsset", async () => {
                await expect(revenueBuyBack.notifyRedistributionAmount(sa.dummy1.address, simpleToExactAmount(1, 18))).to.be.revertedWith(
                    "Invalid fAsset",
                )
            })
            it("approval is not given from sender", async () => {
                await expect(revenueBuyBack.notifyRedistributionAmount(fUSD.address, simpleToExactAmount(100, 18))).to.be.revertedWith(
                    "ERC20: transfer amount exceeds allowance",
                )
            })
            it("sender has insufficient balance", async () => {
                await fUSD.transfer(sa.dummy1.address, simpleToExactAmount(1, 18))
                await fUSD.connect(sa.dummy1.signer).approve(revenueBuyBack.address, simpleToExactAmount(100))
                await expect(
                    revenueBuyBack.connect(sa.dummy1.signer).notifyRedistributionAmount(fUSD.address, simpleToExactAmount(2, 18)),
                ).to.be.revertedWith("ERC20: transfer amount exceeds balance")
            })
        })
    })
    describe("buy back MTA rewards", () => {
        const fusdRevenue = simpleToExactAmount(20000)
        const mbtcRevenue = simpleToExactAmount(2)
        let bAsset1Amount: BigNumber
        let bAsset2Amount: BigNumber
        let fusdRewardsAmount: BigNumber
        let mbtcRewardsAmount: BigNumber
        beforeEach(async () => {
            await setupRevenueBuyBack(treasuryFee)

            // Put some bAssets to the fAssets
            await bAsset1.transfer(fUSD.address, fusdRevenue)
            await bAsset2.transfer(mBTC.address, mbtcRevenue.div(1e12))

            // Distribute revenue to RevenueBuyBack
            await fUSD.approve(revenueBuyBack.address, fusdRevenue)
            await mBTC.approve(revenueBuyBack.address, mbtcRevenue)
            await revenueBuyBack.notifyRedistributionAmount(fUSD.address, fusdRevenue)
            await revenueBuyBack.notifyRedistributionAmount(mBTC.address, mbtcRevenue)

            // bAssets bought = ((1e18 - treasury fee) / 1e18) * (98 / 100)
            bAsset1Amount = fusdRevenue.mul(simpleToExactAmount(1).sub(treasuryFee)).div(simpleToExactAmount(1)).mul(98).div(100)
            // Exchange rate = 0.80 MTA/USD = 8 / 18
            // Swap fee is 0.3% = 997 / 1000
            fusdRewardsAmount = bAsset1Amount.mul(8).div(10).mul(997).div(1000)
            // bAssets bought = ((1e18 - treasury fee) / 1e18 ) * (98 / 100) / 1e12
            bAsset2Amount = mbtcRevenue.mul(simpleToExactAmount(1).sub(treasuryFee)).div(simpleToExactAmount(1)).mul(98).div(100).div(1e12)
            // Exchange rate = 50,000 MTA/BTC
            // Swap fee is 0.3% = 997 / 1000
            mbtcRewardsAmount = bAsset2Amount.mul(50000).mul(997).div(1000).mul(1e12)
        })
        it("should sell fUSD for MTA and send treasury fee to treasury", async () => {
            expect(await fUSD.balanceOf(revenueBuyBack.address), "revenueBuyBack's fUSD Bal before").to.eq(fusdRevenue)
            expect(await bAsset1.balanceOf(fUSD.address), "fAsset's bAsset Bal before").to.eq(fusdRevenue)
            expect(await fUSD.balanceOf(await treasury.getAddress()), "treasury's fUSD Bal before").to.eq(0)
            expect(await rewardsToken.balanceOf(revenueBuyBack.address), "revenueBuyBack's rewards Bal before").to.eq(0)

            const tx = revenueBuyBack
                .connect(sa.keeper.signer)
                .buyBackRewards([fUSD.address], [bAsset1Amount], [fusdRewardsAmount], [uniswapFusdBasset1Paths.encoded])
            const treasuryBal = fusdRevenue.mul(treasuryFee).div(simpleToExactAmount(1))
            const fusdSold = fusdRevenue.sub(treasuryBal)
            await expect(tx).to.emit(revenueBuyBack, "BuyBackRewards").withArgs(fUSD.address, treasuryBal, fusdSold, fusdRewardsAmount)

            expect(await fUSD.balanceOf(revenueBuyBack.address), "revenueBuyBack's fUSD Bal after").to.eq(0)
            expect(await fUSD.balanceOf(await treasury.getAddress()), "treasury's fUSD Bal after").to.gt(0)
            expect(await rewardsToken.balanceOf(revenueBuyBack.address), "revenueBuyBack's rewards Bal after").to.gt(0)
        })
        it("should sell mBTC for MTA and send treasury fee to treasury", async () => {
            expect(await mBTC.balanceOf(revenueBuyBack.address), "revenueBuyBack's mBTC Bal before").to.eq(mbtcRevenue)
            expect(await bAsset2.balanceOf(mBTC.address), "fAsset's bAsset Bal before").to.eq(mbtcRevenue.div(1e12))
            expect(await fUSD.balanceOf(await treasury.getAddress()), "treasury's fUSD Bal before").to.eq(0)

            const tx = revenueBuyBack
                .connect(sa.keeper.signer)
                .buyBackRewards([mBTC.address], [bAsset2Amount], [mbtcRewardsAmount], [uniswapMbtcBasset2Paths.encoded])

            const treasuryBal = mbtcRevenue.mul(treasuryFee).div(simpleToExactAmount(1))
            const mbtcSold = mbtcRevenue.sub(treasuryBal)
            await expect(tx).to.emit(revenueBuyBack, "BuyBackRewards").withArgs(mBTC.address, treasuryBal, mbtcSold, mbtcRewardsAmount)

            expect(await mBTC.balanceOf(revenueBuyBack.address), "revenueBuyBack's mBTC Bal after").to.eq(0)
            expect(await mBTC.balanceOf(await treasury.getAddress()), "treasury's fUSD Bal after").to.gt(0)
        })
        it("should sell fUSD and mBTC for MTA and send treasury fee to treasury", async () => {
            const tx = revenueBuyBack
                .connect(sa.keeper.signer)
                .buyBackRewards(
                    [fUSD.address, mBTC.address],
                    [bAsset1Amount, bAsset2Amount],
                    [fusdRewardsAmount, mbtcRewardsAmount],
                    [uniswapFusdBasset1Paths.encoded, uniswapMbtcBasset2Paths.encoded],
                )

            const fusdTreasuryBal = fusdRevenue.mul(treasuryFee).div(simpleToExactAmount(1))
            const fusdSold = fusdRevenue.sub(fusdTreasuryBal)
            await expect(tx).to.emit(revenueBuyBack, "BuyBackRewards").withArgs(fUSD.address, fusdTreasuryBal, fusdSold, fusdRewardsAmount)

            const mbtcTreasuryBal = mbtcRevenue.mul(treasuryFee).div(simpleToExactAmount(1))
            const mbtcSold = mbtcRevenue.sub(mbtcTreasuryBal)
            await expect(tx).to.emit(revenueBuyBack, "BuyBackRewards").withArgs(mBTC.address, mbtcTreasuryBal, mbtcSold, mbtcRewardsAmount)

            expect(await fUSD.balanceOf(revenueBuyBack.address), "revenueBuyBack's fUSD Bal after").to.eq(0)
            expect(await mBTC.balanceOf(revenueBuyBack.address), "revenueBuyBack's fUSD Bal after").to.eq(0)
            expect(await fUSD.balanceOf(await treasury.getAddress()), "treasury's fUSD Bal after").to.gt(0)
            expect(await mBTC.balanceOf(await treasury.getAddress()), "treasury's mBTC Bal after").to.gt(0)
        })
        it("should sell all fUSD for MTA with nothing to treasury", async () => {
            // Change config so no revenue is sent to treasury
            await revenueBuyBack.connect(sa.governor.signer).setTreasuryFee(0)

            expect(await fUSD.balanceOf(revenueBuyBack.address), "revenueBuyBack's fUSD Bal before").to.eq(fusdRevenue)
            expect(await bAsset1.balanceOf(fUSD.address), "fAsset's bAsset Bal before").to.eq(fusdRevenue)
            expect(await fUSD.balanceOf(await treasury.getAddress()), "treasury's fUSD Bal before").to.eq(0)

            const fullBasset1Amount = fusdRevenue.mul(98).div(100)
            const fullFusdRewardsAmount = fullBasset1Amount.mul(8).div(10).mul(997).div(1000)

            const tx = revenueBuyBack
                .connect(sa.keeper.signer)
                .buyBackRewards([fUSD.address], [fullBasset1Amount], [fullFusdRewardsAmount], [uniswapFusdBasset1Paths.encoded])
            await expect(tx).to.emit(revenueBuyBack, "BuyBackRewards").withArgs(fUSD.address, 0, fusdRevenue, fullFusdRewardsAmount)

            expect(await fUSD.balanceOf(revenueBuyBack.address), "revenueBuyBack's fUSD Bal after").to.eq(0)
            expect(await fUSD.balanceOf(await treasury.getAddress()), "treasury's fUSD Bal after").to.eq(0)
        })
        it("should send all revenue to treasury with no buy back", async () => {
            // Change config so no revenue is sent to treasury
            await revenueBuyBack.connect(sa.governor.signer).setTreasuryFee(simpleToExactAmount(1))

            expect(await fUSD.balanceOf(revenueBuyBack.address), "revenueBuyBack's fUSD Bal before").to.eq(fusdRevenue)
            expect(await bAsset1.balanceOf(fUSD.address), "fAsset's bAsset Bal before").to.eq(fusdRevenue)
            expect(await fUSD.balanceOf(await treasury.getAddress()), "treasury's fUSD Bal before").to.eq(0)

            const tx = revenueBuyBack.connect(sa.keeper.signer).buyBackRewards([fUSD.address], [0], [0], [uniswapFusdBasset1Paths.encoded])
            await expect(tx).to.emit(revenueBuyBack, "BuyBackRewards").withArgs(fUSD.address, fusdRevenue, 0, 0)

            expect(await fUSD.balanceOf(revenueBuyBack.address), "revenueBuyBack's fUSD Bal after").to.eq(0)
            expect(await fUSD.balanceOf(await treasury.getAddress()), "treasury's fUSD Bal after").to.eq(fusdRevenue)
        })
        describe("should fail when", () => {
            it("Not keeper or governor", async () => {
                const tx = revenueBuyBack.buyBackRewards(
                    [fUSD.address],
                    [bAsset1Amount],
                    [fusdRewardsAmount],
                    [uniswapFusdBasset1Paths.encoded],
                )
                await expect(tx).to.revertedWith("Only keeper or governor")
            })
            it("No fAssets", async () => {
                const tx = revenueBuyBack.connect(sa.keeper.signer).buyBackRewards([], [], [], [])
                await expect(tx).to.revertedWith("Invalid fAssets")
            })
            it("Not a fAsset", async () => {
                const tx = revenueBuyBack
                    .connect(sa.keeper.signer)
                    .buyBackRewards([rewardsToken.address], [bAsset1Amount], [fusdRewardsAmount], [uniswapFusdBasset1Paths.encoded])
                await expect(tx).to.revertedWith("Invalid fAsset")
            })
            it("No minBassetsAmounts", async () => {
                const tx = revenueBuyBack
                    .connect(sa.keeper.signer)
                    .buyBackRewards([fUSD.address], [], [fusdRewardsAmount], [uniswapFusdBasset1Paths.encoded])
                await expect(tx).to.revertedWith("Invalid minBassetsAmounts")
            })
            it("as minBassetsAmounts is too high", async () => {
                const tx = revenueBuyBack
                    .connect(sa.keeper.signer)
                    .buyBackRewards([fUSD.address], [bAsset1Amount.add(1)], [fusdRewardsAmount], [uniswapFusdBasset1Paths.encoded])
                await expect(tx).to.revertedWith("bAsset qty < min qty")
                expect(await rewardsToken.balanceOf(revenueBuyBack.address), "RevenueBuyBack MTA bal after").to.eq(0)
            })
            it("No minRewardsAmounts", async () => {
                const tx = revenueBuyBack
                    .connect(sa.keeper.signer)
                    .buyBackRewards([fUSD.address], [bAsset1Amount], [], [uniswapFusdBasset1Paths.encoded])
                await expect(tx).to.revertedWith("Invalid minRewardsAmounts")
            })
            it("as minRewardsAmounts is too high", async () => {
                const tx = revenueBuyBack
                    .connect(sa.keeper.signer)
                    .buyBackRewards([fUSD.address], [bAsset1Amount], [fusdRewardsAmount.add(1)], [uniswapFusdBasset1Paths.encoded])
                await expect(tx).to.revertedWith("Too little received")
                expect(await rewardsToken.balanceOf(revenueBuyBack.address), "RevenueBuyBack MTA bal after").to.eq(0)
            })
            it("No uniswapPaths", async () => {
                const tx = revenueBuyBack.connect(sa.keeper.signer).buyBackRewards([fUSD.address], [bAsset1Amount], [fusdRewardsAmount], [])
                await expect(tx).to.revertedWith("Invalid uniswapPaths")
                expect(await rewardsToken.balanceOf(revenueBuyBack.address), "RevenueBuyBack MTA bal after").to.eq(0)
            })
            describe("uniswap path", () => {
                it("zero", async () => {
                    const tx = revenueBuyBack
                        .connect(sa.keeper.signer)
                        .buyBackRewards([fUSD.address], [bAsset1Amount], [fusdRewardsAmount], ["0x"])
                    await expect(tx).to.revertedWith("Uniswap path too short")
                })
                it("from fAsset to rewards", async () => {
                    const uniswapNewPaths = encodeUniswapPath([fUSD.address, DEAD_ADDRESS, rewardsToken.address], [3000, 3000])

                    const tx = revenueBuyBack
                        .connect(sa.keeper.signer)
                        .buyBackRewards([fUSD.address], [bAsset1Amount], [fusdRewardsAmount], [uniswapNewPaths.encoded])
                    await expect(tx).to.revertedWith("Invalid uniswap path")
                })
                it("from bAsset to fAsset", async () => {
                    const uniswapNewPaths = encodeUniswapPath([bAsset1.address, DEAD_ADDRESS, fUSD.address], [3000, 3000])
                    const tx = revenueBuyBack
                        .connect(sa.keeper.signer)
                        .buyBackRewards([fUSD.address], [bAsset1Amount], [fusdRewardsAmount], [uniswapNewPaths.encoded])
                    await expect(tx).to.revertedWith("Invalid uniswap path")
                })
                it("is too short", async () => {
                    const uniswapNewPaths = encodeUniswapPath([bAsset1.address, rewardsToken.address], [3000])
                    const tx = revenueBuyBack
                        .connect(sa.keeper.signer)
                        .buyBackRewards([fUSD.address], [bAsset1Amount], [fusdRewardsAmount], [uniswapNewPaths.encoded.slice(0, 42)])
                    await expect(tx).to.revertedWith("Uniswap path too short")
                })
            })
        })
    })
    describe("donate rewards to Emissions Controller", () => {
        const totalRewards = simpleToExactAmount(40000)
        beforeEach(async () => {
            await setupRevenueBuyBack(treasuryFee)
        })
        it("should donate rewards", async () => {
            // Put some reward tokens in the RevenueBuyBack contract for donation to the Emissions Controller
            await rewardsToken.transfer(revenueBuyBack.address, totalRewards)
            expect(await rewardsToken.balanceOf(revenueBuyBack.address), "revenue buy back rewards before").to.eq(totalRewards)
            const rewardsECbefore = await rewardsToken.balanceOf(emissionController.address)

            const tx = revenueBuyBack.connect(sa.keeper.signer).donateRewards()

            await expect(tx).to.emit(revenueBuyBack, "DonatedRewards").withArgs(totalRewards)
            await expect(tx).to.emit(emissionController, "DonatedRewards").withArgs(1, totalRewards.div(4))
            await expect(tx).to.emit(emissionController, "DonatedRewards").withArgs(0, totalRewards.mul(3).div(4))

            expect(await rewardsToken.balanceOf(revenueBuyBack.address), "revenue buy back rewards after").to.eq(0)
            expect(await rewardsToken.balanceOf(emissionController.address), "emission controller rewards after").to.eq(
                rewardsECbefore.add(totalRewards),
            )
        })
        describe("should fail when", () => {
            it("no voting power", async () => {
                await staking1.setTotalSupply(0)
                await staking2.setTotalSupply(0)

                const tx = revenueBuyBack.connect(sa.keeper.signer).donateRewards()
                await expect(tx).to.revertedWith("No voting power")
            })
            it("no rewards to donate", async () => {
                expect(await rewardsToken.balanceOf(revenueBuyBack.address), "revenue buy back rewards before").to.eq(0)

                const tx = revenueBuyBack.connect(sa.keeper.signer).donateRewards()
                await expect(tx).to.revertedWith("No rewards to donate")
            })
        })
    })
    describe("mapBasset", () => {
        let newFasset: MockFasset
        let newBasset: MockERC20
        before(async () => {
            newFasset = await new MockFasset__factory(sa.default.signer).deploy(
                "EURO",
                "mEUR",
                18,
                sa.default.address,
                simpleToExactAmount(2000000),
            )
            newBasset = await fAssetMachine.loadBassetProxy("EUR bAsset", "bEUR", 18)
        })
        it("should map bAsset", async () => {
            const tx = await revenueBuyBack.connect(sa.governor.signer).mapBasset(newFasset.address, newBasset.address)

            await expect(tx).to.emit(revenueBuyBack, "MappedBasset").withArgs(newFasset.address, newBasset.address)

            const bAsset = await revenueBuyBack.bassets(newFasset.address)
            expect(bAsset, "bAsset").to.eq(newBasset.address)
        })
        context("should fail when", () => {
            before(async () => {
                await setupRevenueBuyBack(treasuryFee)
            })
            it("not governor", async () => {
                const tx = revenueBuyBack.mapBasset(newFasset.address, newBasset.address)

                await expect(tx).to.revertedWith("Only governor can execute")
            })
            it("fAsset is zero", async () => {
                const tx = revenueBuyBack.connect(sa.governor.signer).mapBasset(ZERO_ADDRESS, newBasset.address)
                await expect(tx).to.revertedWith("fAsset token is zero")
            })
            it("bAsset is zero", async () => {
                const tx = revenueBuyBack.connect(sa.governor.signer).mapBasset(newFasset.address, ZERO_ADDRESS)
                await expect(tx).to.revertedWith("bAsset token is zero")
            })
        })
    })
    describe("set treasury fee", () => {
        const newTreasuryFee = simpleToExactAmount(2, 17)
        it("should set treasury fee", async () => {
            const tx = await revenueBuyBack.connect(sa.governor.signer).setTreasuryFee(newTreasuryFee)

            await expect(tx).to.emit(revenueBuyBack, "TreasuryFeeChanged").withArgs(newTreasuryFee)

            expect(await revenueBuyBack.treasuryFee(), "treasury fee").to.eq(newTreasuryFee)
        })
        context("should fail when", () => {
            before(async () => {
                await setupRevenueBuyBack(treasuryFee)
            })
            it("not governor", async () => {
                const tx = revenueBuyBack.setTreasuryFee(newTreasuryFee)

                await expect(tx).to.revertedWith("Only governor can execute")
            })
            it("treasury fee too big", async () => {
                const tx = revenueBuyBack.connect(sa.governor.signer).setTreasuryFee(simpleToExactAmount(101, 16))
                await expect(tx).to.revertedWith("Invalid treasury fee")
            })
        })
    })
    describe("set treasury", () => {
        let newTreasury: Wallet
        before(async () => {
            newTreasury = ethers.Wallet.createRandom()
        })
        it("should set treasury", async () => {
            const tx = await revenueBuyBack.connect(sa.governor.signer).setTreasury(newTreasury.address)

            await expect(tx).to.emit(revenueBuyBack, "TreasuryChanged").withArgs(newTreasury.address)

            expect(await revenueBuyBack.treasury(), "bAsset").to.eq(newTreasury.address)
        })
        context("should fail when", () => {
            before(async () => {
                await setupRevenueBuyBack(treasuryFee)
            })
            it("not governor", async () => {
                const tx = revenueBuyBack.setTreasury(newTreasury.address)

                await expect(tx).to.revertedWith("Only governor can execute")
            })
            it("treasury address is zero", async () => {
                const tx = revenueBuyBack.connect(sa.governor.signer).setTreasury(ZERO_ADDRESS)
                await expect(tx).to.revertedWith("Treasury is zero")
            })
        })
    })
    describe("addStakingContract", () => {
        before(async () => {
            await setupRevenueBuyBack(treasuryFee)
        })
        context("should fail when", () => {
            it("duplicate", async () => {
                const tx = revenueBuyBack.connect(sa.governor.signer).addStakingContract(0)

                await expect(tx).to.revertedWith("Staking dial id already exists")
            })
            it("invalid dial id", async () => {
                const tx = revenueBuyBack.connect(sa.governor.signer).addStakingContract(3)

                await expect(tx).to.revertedWith("reverted with panic code 0x32 (Array accessed at an out-of-bounds or negative index)")
            })
            it("not governor", async () => {
                const tx = revenueBuyBack.addStakingContract(4)

                await expect(tx).to.revertedWith("Only governor can execute")
            })
        })
        it("should add staking contract", async () => {
            const newStakingContract = await new MockStakingContract__factory(sa.default.signer).deploy()
            await emissionController.connect(sa.governor.signer).addDial(newStakingContract.address, 10, true)
            const newDialId = 2
            expect(await emissionController.getDialRecipient(newDialId), "new dial added").to.eq(newStakingContract.address)

            const tx = await revenueBuyBack.connect(sa.governor.signer).addStakingContract(newDialId)

            await expect(tx).to.emit(revenueBuyBack, "AddedStakingContract").withArgs(newDialId)
        })
    })
})
