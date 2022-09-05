import { ethers } from "hardhat"
import { expect } from "chai"

import { assertBNClosePercent } from "@utils/assertions"
import { simpleToExactAmount } from "@utils/math"
import { FassetDetails, FassetMachine, StandardAccounts } from "@utils/machines"

import { DEAD_ADDRESS, ZERO_ADDRESS } from "@utils/constants"
import { AssetProxy__factory, ExposedFasset, FassetLogic, FassetManager } from "types/generated"
import { BasketComposition } from "types"

describe("Fasset - basic fns", () => {
    let sa: StandardAccounts
    let fAssetMachine: FassetMachine
    let details: FassetDetails

    const runSetup = async (): Promise<void> => {
        const renBtc = await fAssetMachine.loadBassetProxy("Ren BTC", "renBTC", 18)
        const sbtc = await fAssetMachine.loadBassetProxy("Synthetix BTC", "sBTC", 18)
        const wbtc = await fAssetMachine.loadBassetProxy("Wrapped BTC", "wBTC", 12)
        const bAssets = [renBtc, sbtc, wbtc]

        const LogicFactory = await ethers.getContractFactory("FassetLogic")
        const logicLib = (await LogicFactory.deploy()) as FassetLogic

        const ManagerFactory = await ethers.getContractFactory("FassetManager")
        const managerLib = (await ManagerFactory.deploy()) as FassetManager

        const libs = {
            libraries: {
                FassetLogic: logicLib.address,
                FassetManager: managerLib.address,
            },
        }
        const factory = await ethers.getContractFactory("ExposedFasset", libs)
        const impl = await factory.deploy(DEAD_ADDRESS, simpleToExactAmount(5, 13))
        const data = impl.interface.encodeFunctionData("initialize", [
            "mStable BTC",
            "mBTC",
            bAssets.map((b) => ({
                addr: b.address,
                integrator: ZERO_ADDRESS,
                hasTxFee: false,
                status: 0,
            })),
            {
                a: simpleToExactAmount(1, 2),
                limits: {
                    min: simpleToExactAmount(5, 16),
                    max: simpleToExactAmount(55, 16),
                },
            },
        ])
        const fAsset = await new AssetProxy__factory(sa.default.signer).deploy(impl.address, DEAD_ADDRESS, data)
        details = {
            fAsset: factory.attach(fAsset.address) as ExposedFasset,
            bAssets,
        }
    }

    before("Init contract", async () => {
        const accounts = await ethers.getSigners()
        fAssetMachine = await new FassetMachine().initAccounts(accounts)
        sa = fAssetMachine.sa

        await runSetup()
    })

    describe("testing some mints", () => {
        before("reset", async () => {
            await runSetup()
        })
        it("should mint some bAssets", async () => {
            const { bAssets, fAsset } = details
            const approvals = await Promise.all(details.bAssets.map((b) => fAssetMachine.approveFasset(b, fAsset, 100)))
            await fAsset.mintMulti(
                bAssets.map((b) => b.address),
                approvals,
                99,
                sa.default.address,
            )
            const dataEnd = await fAssetMachine.getBasketComposition(details)

            expect(dataEnd.totalSupply).to.eq(simpleToExactAmount(300, 18))
        })
        it("should mint less when going into penalty zone", async () => {
            // soft max is 50%, currently all are at 33% with 300 tvl
            // adding 50 units pushes tvl to 350 and weight to 42.8%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 50)
            await expect(fAsset.mint(bAssets[0].address, approval, simpleToExactAmount(51), sa.default.address)).to.be.revertedWith(
                "Mint quantity < min qty",
            )
            await fAsset.mint(bAssets[0].address, approval, simpleToExactAmount(49), sa.default.address)

            const dataEnd = await fAssetMachine.getBasketComposition(details)
            const minted = dataEnd.totalSupply.sub(dataBefore.totalSupply)

            expect(minted).to.lt(simpleToExactAmount(50, 18))
            expect(minted).to.gt(simpleToExactAmount("49.7", 18))
        })
        it("should apply close to 5% penalty near hard max", async () => {
            // hard max is 55%, currently at 42.86% with 350 tvl
            // adding 80 units pushes tvl to 430 and weight to 53.4%
            // other weights then are 23.3%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 80)
            await expect(fAsset.mint(bAssets[0].address, approval, simpleToExactAmount("79.9"), sa.default.address)).to.be.revertedWith(
                "Mint quantity < min qty",
            )
            await fAsset.mint(bAssets[0].address, approval, simpleToExactAmount(76), sa.default.address)

            const dataEnd = await fAssetMachine.getBasketComposition(details)
            const minted = dataEnd.totalSupply.sub(dataBefore.totalSupply)

            expect(minted).to.lt(simpleToExactAmount(80, 18))
            expect(minted).to.gt(simpleToExactAmount(77, 18))
        })
        it("should fail if we go over max", async () => {
            const { bAssets, fAsset } = details
            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 80)
            await expect(fAsset.mint(bAssets[0].address, approval, simpleToExactAmount(87), sa.default.address)).to.be.revertedWith(
                "Exceeds weight limits",
            )
        })
        it("should allow lots of minting", async () => {
            const { bAssets, fAsset } = details
            const approval = await fAssetMachine.approveFasset(bAssets[1], fAsset, 80)
            await fAsset.mint(bAssets[1].address, approval.div(80), 0, sa.default.address)
            await fAsset.mint(bAssets[1].address, approval.div(80), 0, sa.default.address)
            await fAsset.mint(bAssets[1].address, approval.div(80), 0, sa.default.address)
            await bAssets[2].transfer(sa.dummy2.address, simpleToExactAmount(50, await bAssets[2].decimals()))
            const approval2 = await fAssetMachine.approveFasset(bAssets[2], fAsset, 50, sa.dummy2.signer)
            await fAsset.connect(sa.dummy2.signer).mint(bAssets[2].address, approval2.div(5), 0, sa.default.address)
            await fAsset.connect(sa.dummy2.signer).mint(bAssets[2].address, approval2.div(5), 0, sa.default.address)
            await fAsset.connect(sa.dummy2.signer).mint(bAssets[2].address, approval2.div(5), 0, sa.default.address)
            await fAsset.connect(sa.dummy2.signer).mint(bAssets[2].address, approval2.div(5), 0, sa.default.address)
            await fAsset.connect(sa.dummy2.signer).mint(bAssets[2].address, approval2.div(5), 0, sa.default.address)
        })
    })
    describe("testing some swaps", () => {
        let dataStart: BasketComposition
        before("set up basket", async () => {
            await runSetup()
            const { bAssets, fAsset } = details
            const approvals = await Promise.all(details.bAssets.map((b) => fAssetMachine.approveFasset(b, fAsset, 100)))
            await fAsset.mintMulti(
                bAssets.map((b) => b.address),
                approvals,
                simpleToExactAmount(99),
                sa.default.address,
            )
            dataStart = await fAssetMachine.getBasketComposition(details)

            expect(dataStart.totalSupply).to.eq(simpleToExactAmount(300, 18))
        })
        it("should swap 1:1(-fee) within normal range", async () => {
            // soft max is 41%, currently all are at 33% with 300 tvl
            // adding 10 units should result in 9.9994 output and 36.66%
            const { bAssets, fAsset } = details

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 10)
            await expect(
                fAsset.swap(
                    bAssets[0].address, // renBTC
                    bAssets[1].address, // sBTC
                    approval,
                    simpleToExactAmount(11),
                    sa.default.address,
                ),
            ).to.be.revertedWith("Output qty < minimum qty")
            await fAsset.swap(
                bAssets[0].address, // renBTC
                bAssets[1].address, // sBTC
                approval,
                simpleToExactAmount("9.9"),
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const swappedOut = dataStart.bAssets[1].fAssetUnits.sub(dataAfter.bAssets[1].fAssetUnits)
            assertBNClosePercent(swappedOut, simpleToExactAmount("9.994", 18), "0.1")

            expect(dataAfter.bAssets[0].fAssetUnits.sub(dataStart.bAssets[0].fAssetUnits)).to.eq(simpleToExactAmount(10, 18))

            expect(dataAfter.totalSupply).to.eq(dataStart.totalSupply)
        })
        it("should apply minute fee when 2% over soft max ", async () => {
            // soft max is 41%, currently at 36.66% with 110/300 tvl
            // adding 20 units pushes to 130/300 and weight to 43.2%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 20)
            await fAsset.swap(
                bAssets[0].address, // renBTC
                bAssets[2].address, // wBTC
                approval,
                simpleToExactAmount(19, 12),
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const swappedOut = dataBefore.bAssets[2].fAssetUnits.sub(dataAfter.bAssets[2].fAssetUnits)
            // sum of fee is 0.5% (incl 0.06% swap fee)
            expect(swappedOut).to.gt(simpleToExactAmount("19.9", 18))
            expect(swappedOut).to.lt(simpleToExactAmount(20, 18))
        })
        it("should apply close to 5% penalty near hard max", async () => {
            // hard max is 56%, currently at 43.2% with 130/300 tvl
            // adding 35 units pushes to 165/300 and weight to 55%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 35)
            await expect(
                fAsset.swap(
                    bAssets[0].address, // renBTC
                    bAssets[1].address, // sBTC
                    approval,
                    simpleToExactAmount("34.9"),
                    sa.default.address,
                ),
            ).to.be.revertedWith("Output qty < minimum qty")
            await fAsset.swap(
                bAssets[0].address, // renBTC
                bAssets[1].address, // sBTC
                approval,
                simpleToExactAmount(31),
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const swappedOut = dataBefore.bAssets[1].fAssetUnits.sub(dataAfter.bAssets[1].fAssetUnits)
            // sum of fee is 0.5% (incl 0.06% swap fee)
            expect(swappedOut).to.gt(simpleToExactAmount(33, 18))
            expect(swappedOut).to.lt(simpleToExactAmount("34.7", 18))
        })
        it("should fail if we go over max", async () => {
            const { bAssets, fAsset } = details
            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 10)
            await expect(
                fAsset.swap(
                    bAssets[0].address, // renBTC
                    bAssets[2].address, // wBTC
                    approval,
                    simpleToExactAmount(9, 12),
                    sa.default.address,
                ),
            ).to.be.revertedWith("Exceeds weight limits")
        })
    })

    describe("testing redeem exact fAsset", () => {
        let dataStart: BasketComposition
        before("set up basket", async () => {
            await runSetup()
            const { bAssets, fAsset } = details
            const approvals = await Promise.all(details.bAssets.map((b) => fAssetMachine.approveFasset(b, fAsset, 100)))
            await fAsset.mintMulti(
                bAssets.map((b) => b.address),
                approvals,
                99,
                sa.default.address,
            )
            dataStart = await fAssetMachine.getBasketComposition(details)

            expect(dataStart.totalSupply).to.eq(simpleToExactAmount(300, 18))
        })
        it("should redeem 1:1(-fee) within normal range", async () => {
            // soft min is 25%, currently all are at 33% with 300 tvl
            // redeeming 10 units should result in 9.9994 output and 31%
            const { bAssets, fAsset } = details

            const fAssetRedeemAmount = simpleToExactAmount(10, 18)
            const minBassetAmount = simpleToExactAmount(9, 18)
            await expect(
                fAsset.redeem(
                    bAssets[0].address, // renBTC,
                    fAssetRedeemAmount,
                    fAssetRedeemAmount,
                    sa.default.address,
                ),
            ).to.be.revertedWith("bAsset qty < min qty")
            await fAsset.redeem(
                bAssets[0].address, // renBTC,
                fAssetRedeemAmount,
                minBassetAmount,
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const redeemed = dataStart.bAssets[0].fAssetUnits.sub(dataAfter.bAssets[0].fAssetUnits)
            assertBNClosePercent(redeemed, simpleToExactAmount("9.994", 18), "0.1")

            expect(dataAfter.totalSupply).to.eq(dataStart.totalSupply.sub(fAssetRedeemAmount))
        })
        it("should apply minute fee when 2% under soft min ", async () => {
            // soft min is 25%, currently at 31% with 90/290 tvl
            // withdrawing 30 units pushes to 60/260 and weight to 23.07%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const fAssetRedeemAmount = simpleToExactAmount(30, 18)
            const minBassetAmount = simpleToExactAmount(29, 18)
            await fAsset.redeem(
                bAssets[0].address, // renBTC
                fAssetRedeemAmount,
                minBassetAmount,
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const redeemed = dataBefore.bAssets[0].fAssetUnits.sub(dataAfter.bAssets[0].fAssetUnits)
            // sum of slippage is max 0.33% (incl 0.06% swap fee)
            expect(redeemed).to.gt(simpleToExactAmount("29.9", 18))
            expect(redeemed).to.lt(simpleToExactAmount(30, 18))

            expect(dataAfter.totalSupply).to.eq(dataBefore.totalSupply.sub(fAssetRedeemAmount))
            expect(dataAfter.surplus.sub(dataBefore.surplus)).to.eq(simpleToExactAmount(18, 15))
        })
        it("should apply close to 5% penalty near hard min", async () => {
            // hard min is 10%, currently at 23.07% with 60/260 tvl
            // adding 37 units pushes to 23/223 and weight to 10.3%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const fAssetRedeemAmount = simpleToExactAmount(37, 18)
            const minBassetAmount = simpleToExactAmount(30, 18)
            await fAsset.redeem(
                bAssets[0].address, // renBTC
                fAssetRedeemAmount,
                minBassetAmount,
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const bAssetRedeemed = dataBefore.bAssets[0].fAssetUnits.sub(dataAfter.bAssets[0].fAssetUnits)
            // max slippage around 9%
            expect(bAssetRedeemed).to.gt(simpleToExactAmount("34", 18))
            expect(bAssetRedeemed).to.lt(simpleToExactAmount("36.5", 18))

            expect(dataAfter.totalSupply).to.eq(dataBefore.totalSupply.sub(fAssetRedeemAmount))
        })
    })

    describe("testing redeem exact bAsset(s)", () => {
        let dataStart: BasketComposition
        before("set up basket", async () => {
            await runSetup()
            const { bAssets, fAsset } = details
            const approvals = await Promise.all(details.bAssets.map((b) => fAssetMachine.approveFasset(b, fAsset, 100)))
            await fAsset.mintMulti(
                bAssets.map((b) => b.address),
                approvals,
                99,
                sa.default.address,
            )
            dataStart = await fAssetMachine.getBasketComposition(details)

            expect(dataStart.totalSupply).to.eq(simpleToExactAmount(300, 18))
        })
        it("should redeem 1:1(-fee) within normal range", async () => {
            // soft min is 25%, currently all are at 33% with 300 tvl
            // redeeming 10 units should result in 10.006 burned and 31%
            const { bAssets, fAsset } = details

            const bAssetAmount = simpleToExactAmount(10, 18)
            const maxFasset = simpleToExactAmount("10.01", 18)
            await fAsset.redeemExactBassets([bAssets[0].address], [bAssetAmount], maxFasset, sa.default.address)

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const fAssetBurned = dataStart.totalSupply.sub(dataAfter.totalSupply)
            assertBNClosePercent(fAssetBurned, simpleToExactAmount("10.006003602161296778", 18), "0.1")

            expect(dataAfter.bAssets[0].vaultBalance).to.eq(dataStart.bAssets[0].vaultBalance.sub(simpleToExactAmount(10, 18)))
        })
        it("should apply minute fee when 2% under soft min ", async () => {
            // soft min is 25%, currently at 31% with 90/290 tvl
            // withdrawing 30 units pushes to 60/260 and weight to 23.07%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const bAssetRedeemAmount = simpleToExactAmount(30, 18)
            const maxFasset = simpleToExactAmount(31, 18)
            await fAsset.redeemExactBassets([bAssets[0].address], [bAssetRedeemAmount], maxFasset, sa.default.address)

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const redeemed = dataBefore.bAssets[0].fAssetUnits.sub(dataAfter.bAssets[0].fAssetUnits)
            // sum of slippage is max 0.33% (incl 0.06% swap fee)
            expect(redeemed).to.eq(simpleToExactAmount(30, 18))

            const fAssetBurned = dataBefore.totalSupply.sub(dataAfter.totalSupply)
            expect(fAssetBurned).to.gt(simpleToExactAmount(30, 18))
            expect(fAssetBurned).to.lt(simpleToExactAmount(31, 18))

            assertBNClosePercent(dataAfter.surplus.sub(dataBefore.surplus), simpleToExactAmount(18, 15), 2)
        })
        it("should apply close to 5% penalty near hard min", async () => {
            // hard min is 10%, currently at 23.07% with 60/260 tvl
            // adding 37 units pushes to 23/223 and weight to 10.3%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const bAssetRedeemAmount = simpleToExactAmount(35, 18)
            const maxFasset = simpleToExactAmount(39, 18)
            await expect(
                fAsset.redeemExactBassets([bAssets[0].address], [bAssetRedeemAmount], simpleToExactAmount("35.3", 18), sa.default.address),
            ).to.be.revertedWith("Redeem fAsset qty > max quantity")
            await fAsset.redeemExactBassets([bAssets[0].address], [bAssetRedeemAmount], maxFasset, sa.default.address)

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const redeemed = dataBefore.bAssets[0].fAssetUnits.sub(dataAfter.bAssets[0].fAssetUnits)
            expect(redeemed).to.eq(simpleToExactAmount(35, 18))

            const fAssetBurned = dataBefore.totalSupply.sub(dataAfter.totalSupply)
            expect(fAssetBurned).to.gt(simpleToExactAmount("35.4", 18))
            expect(fAssetBurned).to.lt(simpleToExactAmount(39, 18))
        })
    })
})
