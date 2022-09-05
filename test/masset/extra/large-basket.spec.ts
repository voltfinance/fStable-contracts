import { ethers } from "hardhat"
import { expect } from "chai"

import { simpleToExactAmount } from "@utils/math"
import { FassetDetails, FassetMachine, StandardAccounts } from "@utils/machines"

import { DEAD_ADDRESS, ZERO_ADDRESS } from "@utils/constants"
import { BasketComposition } from "types"
import { AssetProxy__factory, FassetLogic, FassetManager, ExposedFasset } from "types/generated"
import { assertBNClosePercent } from "@utils/assertions"

describe("Many asset Fasset", () => {
    let sa: StandardAccounts
    let fAssetMachine: FassetMachine
    let details: FassetDetails

    const runSetup = async (): Promise<void> => {
        const renBtc = await fAssetMachine.loadBassetProxy("Ren BTC", "renBTC", 18)
        const sbtc = await fAssetMachine.loadBassetProxy("Synthetix BTC", "sBTC", 18)
        const wbtc = await fAssetMachine.loadBassetProxy("Wrapped BTC", "wBTC", 12)
        const btc4 = await fAssetMachine.loadBassetProxy("BTC4", "BTC4", 18)
        const btc5 = await fAssetMachine.loadBassetProxy("BTC5", "BTC5", 18)
        const bAssets = [renBtc, sbtc, wbtc, btc4, btc5]

        const LogicFactory = await ethers.getContractFactory("FassetLogic")
        const logicLib = (await LogicFactory.deploy()) as FassetLogic

        const ManagerFactory = await ethers.getContractFactory("FassetManager")
        const managerLib = (await ManagerFactory.deploy()) as FassetManager

        const factory = (
            await ethers.getContractFactory("ExposedFasset", {
                libraries: {
                    FassetLogic: logicLib.address,
                    FassetManager: managerLib.address,
                },
            })
        ).connect(sa.default.signer)
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
                    max: simpleToExactAmount(37, 16),
                },
            },
        ])
        const fAsset = await new AssetProxy__factory(sa.default.signer).deploy(impl.address, DEAD_ADDRESS, data)
        details = {
            fAsset: (await factory.attach(fAsset.address)) as ExposedFasset,
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
                simpleToExactAmount(99),
                sa.default.address,
            )
            const dataEnd = await fAssetMachine.getBasketComposition(details)

            expect(dataEnd.totalSupply).eq(simpleToExactAmount(500, 18))
        })
        it("should mint less when going into penalty zone", async () => {
            // soft max is 30%, currently all are at 20% with 300 tvl
            // adding 90 units pushes tvl to 590 and weight to 32.2%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 90)
            await fAsset["mint(address,uint256,uint256,address)"](bAssets[0].address, approval, simpleToExactAmount(89), sa.default.address)

            const dataEnd = await fAssetMachine.getBasketComposition(details)
            const minted = dataEnd.totalSupply.sub(dataBefore.totalSupply)

            expect(minted).lt(simpleToExactAmount(90, 18))
            expect(minted).gt(simpleToExactAmount("89.6", 18))
        })
        it("should apply close to 5% penalty near hard max", async () => {
            // hard max is 37%, currently at 32.2% with 590 tvl
            // adding 40 units pushes tvl to 630 and weight to 36.5%
            // other weights then are 15.8%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 40)
            await fAsset["mint(address,uint256,uint256,address)"](bAssets[0].address, approval, simpleToExactAmount(37), sa.default.address)

            const dataEnd = await fAssetMachine.getBasketComposition(details)
            const minted = dataEnd.totalSupply.sub(dataBefore.totalSupply)

            expect(minted).lt(simpleToExactAmount(40, 18))
            expect(minted).gt(simpleToExactAmount("39.3", 18))
        })
        it("should fail if we go over max", async () => {
            const { bAssets, fAsset } = details
            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 30)
            await expect(
                fAsset["mint(address,uint256,uint256,address)"](bAssets[0].address, approval, simpleToExactAmount(10), sa.default.address),
            ).to.be.revertedWith("Exceeds weight limits")
        })
        it("should allow lots of minting", async () => {
            const { bAssets, fAsset } = details
            const approval = await fAssetMachine.approveFasset(bAssets[1], fAsset, 80)
            await fAsset["mint(address,uint256,uint256,address)"](bAssets[1].address, approval.div(80), 0, sa.default.address)
            await fAsset["mint(address,uint256,uint256,address)"](bAssets[1].address, approval.div(80), 0, sa.default.address)
            await fAsset["mint(address,uint256,uint256,address)"](bAssets[1].address, approval.div(80), 0, sa.default.address)
            await bAssets[2].transfer(sa.dummy2.address, simpleToExactAmount(50, await bAssets[2].decimals()))
            const approval2 = await fAssetMachine.approveFasset(bAssets[2], fAsset, 50, sa.dummy2.signer)
            await fAsset
                .connect(sa.dummy2.signer)
                ["mint(address,uint256,uint256,address)"](bAssets[2].address, approval2.div(5), 0, sa.default.address)
            await fAsset
                .connect(sa.dummy2.signer)
                ["mint(address,uint256,uint256,address)"](bAssets[2].address, approval2.div(5), 0, sa.default.address)
            await fAsset
                .connect(sa.dummy2.signer)
                ["mint(address,uint256,uint256,address)"](bAssets[2].address, approval2.div(5), 0, sa.default.address)
            await fAsset
                .connect(sa.dummy2.signer)
                ["mint(address,uint256,uint256,address)"](bAssets[2].address, approval2.div(5), 0, sa.default.address)
            await fAsset
                .connect(sa.dummy2.signer)
                ["mint(address,uint256,uint256,address)"](bAssets[2].address, approval2.div(5), 0, sa.default.address)
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
                99,
                sa.default.address,
            )
            dataStart = await fAssetMachine.getBasketComposition(details)

            expect(dataStart.totalSupply).eq(simpleToExactAmount(500, 18))
        })
        it("should swap almost 1:1(-fee) within normal range", async () => {
            // soft max is 30%, currently all are at 20% with 500 tvl
            // adding 10 units should result in 9.9994 output and 22%
            const { bAssets, fAsset } = details

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 10)
            await fAsset["swap(address,address,uint256,uint256,address)"](
                bAssets[0].address,
                bAssets[1].address,
                approval,
                simpleToExactAmount("9.95"),
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const swappedOut = dataStart.bAssets[1].fAssetUnits.sub(dataAfter.bAssets[1].fAssetUnits)
            assertBNClosePercent(swappedOut, simpleToExactAmount("9.994", 18), "0.1")

            expect(dataAfter.bAssets[0].fAssetUnits.sub(dataStart.bAssets[0].fAssetUnits)).eq(simpleToExactAmount(10, 18))

            expect(dataAfter.totalSupply).eq(dataStart.totalSupply)
        })
        it("should apply minute fee when 2% over soft max ", async () => {
            // soft max is 30%, currently at 22% with 110/500 tvl
            // adding 50 units pushes to 160/500 and weight to 32%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 50)
            await fAsset["swap(address,address,uint256,uint256,address)"](
                bAssets[0].address,
                bAssets[2].address,
                approval,
                simpleToExactAmount(49, 12),
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const swappedOut = dataBefore.bAssets[2].fAssetUnits.sub(dataAfter.bAssets[2].fAssetUnits)
            // sum of fee is 0.5% (incl 0.06% swap fee)
            expect(swappedOut).gt(simpleToExactAmount("49.6", 18))
            expect(swappedOut).lt(simpleToExactAmount(50, 18))
        })
        it("should apply close to 5% penalty near hard max", async () => {
            // hard max is 37%, currently at 32% with 160/500 tvl
            // adding 24 units pushes to 184/500 and weight to 36.8%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 24)
            await fAsset["swap(address,address,uint256,uint256,address)"](
                bAssets[0].address,
                bAssets[1].address,
                approval,
                simpleToExactAmount(22),
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const swappedOut = dataBefore.bAssets[1].fAssetUnits.sub(dataAfter.bAssets[1].fAssetUnits)
            // sum of fee is 0.5% (incl 0.06% swap fee)
            expect(swappedOut).lt(simpleToExactAmount(24, 18))
            expect(swappedOut).gt(simpleToExactAmount("22.8", 18))
        })
        it("should fail if we go over max", async () => {
            const { bAssets, fAsset } = details
            const approval = await fAssetMachine.approveFasset(bAssets[0], fAsset, 10)
            await expect(
                fAsset["swap(address,address,uint256,uint256,address)"](
                    bAssets[0].address,
                    bAssets[2].address,
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

            expect(dataStart.totalSupply).eq(simpleToExactAmount(500, 18))
        })
        it("should redeem almost 1:1(-fee) within normal range", async () => {
            // soft min is 10%, currently all are at 20% with 500 tvl
            const { bAssets, fAsset } = details

            const fAssetRedeemAmount = simpleToExactAmount(10, 18)
            const minBassetAmount = simpleToExactAmount(9, 18)
            await fAsset["redeem(address,uint256,uint256,address)"](
                bAssets[0].address,
                fAssetRedeemAmount,
                minBassetAmount,
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const redeemed = dataStart.bAssets[0].fAssetUnits.sub(dataAfter.bAssets[0].fAssetUnits)
            assertBNClosePercent(redeemed, simpleToExactAmount("9.994", 18), "0.1")

            expect(dataAfter.totalSupply).eq(dataStart.totalSupply.sub(fAssetRedeemAmount))
        })
        it("should apply minute fee when 2% under soft min ", async () => {
            // soft min is 20%, currently at 90/490 tvl
            // withdrawing 50 units pushes to 40/440 and weight to 9.1%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const fAssetRedeemAmount = simpleToExactAmount(50, 18)
            const minBassetAmount = simpleToExactAmount(49, 18)
            await fAsset["redeem(address,uint256,uint256,address)"](
                bAssets[0].address,
                fAssetRedeemAmount,
                minBassetAmount,
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const redeemed = dataBefore.bAssets[0].fAssetUnits.sub(dataAfter.bAssets[0].fAssetUnits)
            // sum of slippage is max 0.33% (incl 0.06% swap fee)
            expect(redeemed).gt(simpleToExactAmount("49.6", 18))
            expect(redeemed).lt(simpleToExactAmount("49.95", 18))

            expect(dataAfter.totalSupply).eq(dataBefore.totalSupply.sub(fAssetRedeemAmount))
            expect(dataAfter.surplus.sub(dataBefore.surplus)).eq(simpleToExactAmount(30, 15))
        })
        it("should apply close to 5% penalty near hard min", async () => {
            // hard min is 5%, currently at 9.1% with 40/440 tvl
            // redeeming 18 units pushes to 22/422 and weight to 5.2%
            const { bAssets, fAsset } = details

            const dataBefore = await fAssetMachine.getBasketComposition(details)

            const fAssetRedeemAmount = simpleToExactAmount(18, 18)
            const minBassetAmount = simpleToExactAmount(14, 18)
            await fAsset["redeem(address,uint256,uint256,address)"](
                bAssets[0].address,
                fAssetRedeemAmount,
                minBassetAmount,
                sa.default.address,
            )

            const dataAfter = await fAssetMachine.getBasketComposition(details)

            const bAssetRedeemed = dataBefore.bAssets[0].fAssetUnits.sub(dataAfter.bAssets[0].fAssetUnits)
            // max slippage around 9%
            expect(bAssetRedeemed).gt(simpleToExactAmount("16.6", 18))
            expect(bAssetRedeemed).lt(simpleToExactAmount("17.52", 18))

            expect(dataAfter.totalSupply).eq(dataBefore.totalSupply.sub(fAssetRedeemAmount))
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

            expect(dataStart.totalSupply).eq(simpleToExactAmount(300, 18))
        })
    })
})
