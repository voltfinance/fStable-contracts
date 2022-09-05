/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-loop-func */

import { ethers } from "hardhat"
import { expect } from "chai"

import { simpleToExactAmount, BN } from "@utils/math"
import { DEAD_ADDRESS, MAX_UINT256, ZERO_ADDRESS } from "@utils/constants"
import { FassetLogic, FassetManager, ExposedFasset } from "types/generated"
import { assertBNClose, assertBNSlightlyGT } from "@utils/assertions"
import { FassetMachine, StandardAccounts } from "@utils/machines"
import { fAssetData } from "@utils/validator-data"

const config = {
    a: BN.from(120),
    limits: {
        min: simpleToExactAmount(5, 16),
        max: simpleToExactAmount(75, 16),
    },
}

const ratio = simpleToExactAmount(1, 8)
const tolerance = BN.from(10)

const cv = (n: number | string): BN => BN.from(BigInt(n).toString())
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getReserves = (data: any) =>
    [0, 1, 2, 3, 4, 5]
        .filter((i) => data[`reserve${i}`])
        .map((i) => ({
            ratio,
            vaultBalance: cv(data[`reserve${i}`]),
        }))

const runLongTests = process.env.LONG_TESTS === "true"

describe("Invariant Validator - One basket many tests @skip-on-coverage", () => {
    let fAsset: ExposedFasset
    let sa: StandardAccounts
    let recipient: string
    let bAssetAddresses: string[]
    before(async () => {
        const accounts = await ethers.getSigners()
        const fAssetMachine = await new FassetMachine().initAccounts(accounts)
        sa = fAssetMachine.sa
        recipient = await sa.default.address

        const renBTC = await fAssetMachine.loadBassetProxy("Ren BTC", "renBTC", 18)
        const sBTC = await fAssetMachine.loadBassetProxy("Synthetix BTC", "sBTC", 18)
        const wBTC = await fAssetMachine.loadBassetProxy("Wrapped BTC", "wBTC", 18)
        const bAssets = [renBTC, sBTC, wBTC]
        bAssetAddresses = bAssets.map((b) => b.address)

        const LogicFactory = await ethers.getContractFactory("FassetLogic")
        const logicLib = (await LogicFactory.deploy()) as FassetLogic

        // 3. Invariant Validator
        const ManagerFactory = await ethers.getContractFactory("FassetManager")
        const managerLib = (await ManagerFactory.deploy()) as FassetManager

        const FassetFactory = (
            await ethers.getContractFactory("ExposedFasset", {
                libraries: {
                    FassetLogic: logicLib.address,
                    FassetManager: managerLib.address,
                },
            })
        ).connect(sa.default.signer)
        fAsset = (await FassetFactory.deploy(DEAD_ADDRESS, simpleToExactAmount(5, 13))) as ExposedFasset
        await fAsset.initialize(
            "mStable Asset",
            "fAsset",
            bAssets.map((b) => ({
                addr: b.address,
                integrator: ZERO_ADDRESS,
                hasTxFee: false,
                status: 0,
            })),
            config,
        )

        await Promise.all(bAssets.map((b) => b.approve(fAsset.address, MAX_UINT256)))

        const reserves = getReserves(fAssetData.integrationData)

        await fAsset.mintMulti(
            bAssetAddresses,
            reserves.map((r) => r.vaultBalance),
            0,
            recipient,
        )
    })

    interface Data {
        totalSupply: BN
        surplus: BN
        vaultBalances: BN[]
        priceData: {
            price: BN
            k: BN
        }
    }
    const getData = async (_fAsset: ExposedFasset): Promise<Data> => ({
        totalSupply: await _fAsset.totalSupply(),
        surplus: (await _fAsset.data()).surplus,
        vaultBalances: (await _fAsset.getBassets())[1].map((b) => b[1]),
        priceData: await _fAsset.getPrice(),
    })

    describe("Run all the data", () => {
        let dataBefore: Data
        let lastKDiff = BN.from(0)
        let count = 0

        for (const testData of fAssetData.integrationData.actions.slice(
            0,
            runLongTests ? fAssetData.integrationData.actions.length : 100,
        )) {
            describe(`Action ${(count += 1)}`, () => {
                before(async () => {
                    dataBefore = await getData(fAsset)
                })
                switch (testData.type) {
                    case "mint":
                        if (testData.hardLimitError) {
                            it(`throws Max Weight error when minting ${testData.inputQty.toString()} bAssets with index ${
                                testData.inputIndex
                            }`, async () => {
                                await expect(
                                    fAsset.mint(bAssetAddresses[testData.inputIndex], cv(testData.inputQty), 0, recipient),
                                ).to.be.revertedWith("Exceeds weight limits")

                                await expect(
                                    fAsset.getMintOutput(bAssetAddresses[testData.inputIndex], cv(testData.inputQty)),
                                ).to.be.revertedWith("Exceeds weight limits")
                            })
                        } else {
                            it(`should deposit ${testData.inputQty.toString()} bAssets with index ${testData.inputIndex}`, async () => {
                                const expectedOutput = await fAsset.getMintOutput(
                                    bAssetAddresses[testData.inputIndex],
                                    cv(testData.inputQty),
                                )
                                assertBNClose(expectedOutput, cv(testData.expectedQty), tolerance)

                                await fAsset.mint(
                                    bAssetAddresses[testData.inputIndex],
                                    cv(testData.inputQty),
                                    cv(testData.expectedQty).sub(tolerance),
                                    recipient,
                                )

                                const dataMid = await getData(fAsset)
                                assertBNClose(dataMid.totalSupply.sub(dataBefore.totalSupply), expectedOutput, tolerance)
                            })
                        }
                        break
                    case "mintMulti":
                        {
                            const qtys = testData.inputQtys.map((b) => cv(b))
                            if (testData.hardLimitError) {
                                it(`throws Max Weight error when minting ${qtys} bAssets with index ${testData.inputIndex}`, async () => {
                                    await expect(fAsset.mintMulti(bAssetAddresses, qtys, 0, recipient)).to.be.revertedWith(
                                        "Exceeds weight limits",
                                    )

                                    await expect(fAsset.getMintMultiOutput(bAssetAddresses, qtys)).to.be.revertedWith(
                                        "Exceeds weight limits",
                                    )
                                })
                            } else {
                                it(`should mintMulti ${qtys} bAssets`, async () => {
                                    const expectedOutput = await fAsset.getMintMultiOutput(bAssetAddresses, qtys)
                                    assertBNClose(expectedOutput, cv(testData.expectedQty), tolerance)

                                    await fAsset.mintMulti(bAssetAddresses, qtys, cv(testData.expectedQty).sub(tolerance), recipient)

                                    const dataMid = await getData(fAsset)
                                    assertBNClose(dataMid.totalSupply.sub(dataBefore.totalSupply), expectedOutput, tolerance)
                                })
                            }
                        }
                        break
                    case "swap":
                        if (testData.hardLimitError) {
                            it(`throws Max Weight error when swapping ${testData.inputQty.toString()} ${testData.inputIndex} for ${
                                testData.outputIndex
                            }`, async () => {
                                await expect(
                                    fAsset.swap(
                                        bAssetAddresses[testData.inputIndex],
                                        bAssetAddresses[testData.outputIndex],
                                        cv(testData.inputQty),
                                        0,
                                        recipient,
                                    ),
                                ).to.be.revertedWith("Exceeds weight limits")
                                await expect(
                                    fAsset.getSwapOutput(
                                        bAssetAddresses[testData.inputIndex],
                                        bAssetAddresses[testData.outputIndex],
                                        cv(testData.inputQty),
                                    ),
                                ).to.be.revertedWith("Exceeds weight limits")
                            })
                        } else {
                            it(`swaps ${testData.inputQty.toString()} ${testData.inputIndex} for ${testData.outputIndex}`, async () => {
                                const expectedOutput = await fAsset.getSwapOutput(
                                    bAssetAddresses[testData.inputIndex],
                                    bAssetAddresses[testData.outputIndex],
                                    cv(testData.inputQty),
                                )
                                assertBNClose(expectedOutput, cv(testData.expectedQty), tolerance)

                                await fAsset.swap(
                                    bAssetAddresses[testData.inputIndex],
                                    bAssetAddresses[testData.outputIndex],
                                    cv(testData.inputQty),
                                    cv(testData.expectedQty).sub(tolerance),
                                    recipient,
                                )
                            })
                        }
                        break
                    case "redeem":
                        if (testData.hardLimitError) {
                            it(`throws Max Weight error when redeeming ${testData.inputQty} fAssets for bAsset ${testData.inputIndex}`, async () => {
                                await expect(
                                    fAsset.redeem(bAssetAddresses[testData.inputIndex], testData.inputQty, 0, recipient),
                                ).to.be.revertedWith("Exceeds weight limits")
                                await expect(
                                    fAsset.getRedeemOutput(bAssetAddresses[testData.inputIndex], testData.inputQty),
                                ).to.be.revertedWith("Exceeds weight limits")
                            })
                        } else if (testData.insufficientLiquidityError) {
                            it(`throws insufficient liquidity error when redeeming ${testData.inputQty} fAssets for bAsset ${testData.inputIndex}`, async () => {
                                await expect(
                                    fAsset.redeem(bAssetAddresses[testData.inputIndex], testData.inputQty, 0, recipient),
                                ).to.be.revertedWith("VM Exception")
                                await expect(
                                    fAsset.getRedeemOutput(bAssetAddresses[testData.inputIndex], testData.inputQty),
                                ).to.be.revertedWith("VM Exception")
                            })
                        } else {
                            it(`redeem ${testData.inputQty} fAssets for bAsset ${testData.inputIndex}`, async () => {
                                const expectedOutput = await fAsset.getRedeemOutput(bAssetAddresses[testData.inputIndex], testData.inputQty)
                                assertBNClose(expectedOutput, cv(testData.expectedQty), tolerance)

                                await fAsset.redeem(
                                    bAssetAddresses[testData.inputIndex],
                                    testData.inputQty,
                                    cv(testData.expectedQty).sub(tolerance),
                                    recipient,
                                )
                            })
                        }
                        break
                    case "redeemFasset":
                        {
                            const qtys = testData.expectedQtys.map((b) => cv(b).sub(5))
                            if (testData.insufficientLiquidityError) {
                                it(`throws throw insufficient liquidity error when redeeming ${testData.inputQty} fAsset`, async () => {
                                    await expect(fAsset.redeemFasset(cv(testData.inputQty), qtys, recipient)).to.be.revertedWith(
                                        "VM Exception",
                                    )
                                })
                            } else if (testData.hardLimitError) {
                                it(`throws Max Weight error when redeeming ${qtys} bAssets`, async () => {
                                    await expect(fAsset.redeemFasset(cv(testData.inputQty), qtys, recipient)).to.be.revertedWith(
                                        "Exceeds weight limits",
                                    )
                                    throw new Error("invalid exception")
                                })
                            } else {
                                it(`redeem ${testData.inputQty} fAssets for proportionate bAssets`, async () => {
                                    await fAsset.redeemFasset(cv(testData.inputQty), qtys, recipient)
                                })
                            }
                        }
                        break
                    case "redeemBassets":
                        {
                            const qtys = testData.inputQtys.map((b) => cv(b))

                            if (testData.insufficientLiquidityError) {
                                it(`throws throw insufficient liquidity error when redeeming ${qtys} bAssets`, async () => {
                                    await expect(fAsset.redeemExactBassets(bAssetAddresses, qtys, 100, recipient)).to.be.revertedWith(
                                        "VM Exception",
                                    )
                                    await expect(fAsset.getRedeemExactBassetsOutput(bAssetAddresses, qtys)).to.be.revertedWith(
                                        "VM Exception",
                                    )
                                })
                            } else if (testData.hardLimitError) {
                                it(`throws Max Weight error when redeeming ${qtys} bAssets`, async () => {
                                    await expect(fAsset.redeemExactBassets(bAssetAddresses, qtys, 100, recipient)).to.be.revertedWith(
                                        "Exceeds weight limits",
                                    )
                                    await expect(fAsset.getRedeemExactBassetsOutput(bAssetAddresses, qtys)).to.be.revertedWith(
                                        "Exceeds weight limits",
                                    )
                                })
                            } else {
                                it(`redeem ${qtys} bAssets`, async () => {
                                    const expectedOutput = await fAsset.getRedeemExactBassetsOutput(bAssetAddresses, qtys)
                                    const testDataOutput = cv(testData.expectedQty).add(cv(testData.swapFee))
                                    assertBNClose(expectedOutput, testDataOutput, tolerance)

                                    await fAsset.redeemExactBassets(bAssetAddresses, qtys, testDataOutput.add(tolerance), recipient)

                                    const dataMid = await getData(fAsset)
                                    assertBNClose(dataBefore.totalSupply.sub(dataMid.totalSupply), expectedOutput, tolerance)
                                })
                            }
                        }
                        break
                    default:
                        throw Error("unknown action")
                }

                it("holds invariant after action", async () => {
                    const dataEnd = await getData(fAsset)
                    // 1. Check resulting reserves
                    if (testData.reserves) {
                        dataEnd.vaultBalances.map((vb, i) => assertBNClose(vb, cv(testData.reserves[i]), BN.from(1000)))
                    }
                    // 2. Check swap fee accrual
                    if (testData.swapFee) {
                        assertBNClose(
                            dataEnd.surplus,
                            dataBefore.surplus.add(cv(testData.swapFee)),
                            2,
                            "Swap fees should accrue accurately after each action",
                        )
                    }
                    // 3. Check that invariant holds: `totalSupply + surplus = k = invariant(reserves)`
                    //    After each action, this property should hold true, proving 100% that mint/swap/redeem hold,
                    //    and fees are being paid 100% accurately. This should show that the redeemBasset holds.
                    assertBNSlightlyGT(
                        dataEnd.priceData.k,
                        dataEnd.surplus.add(dataEnd.totalSupply),
                        BN.from(1000000000000),
                        false,
                        "K does not hold",
                    )
                    //    The dust collected should always increase in favour of the system
                    const newKDiff = dataEnd.priceData.k.sub(dataEnd.surplus.add(dataEnd.totalSupply))
                    const cachedLastDiff = lastKDiff
                    lastKDiff = newKDiff
                    if (testData.type !== "redeemFasset") {
                        // 50 base unit tolerance on dust increase
                        expect(newKDiff, "Dust can only accumulate in favour of the system").gte(cachedLastDiff.sub(50))
                    } else if (newKDiff < cachedLastDiff) {
                        assertBNClose(newKDiff, cachedLastDiff, BN.from(200), "K dust accrues on redeemFasset")
                    }
                })
            })
        }
    })
})
