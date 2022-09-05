import { impersonate } from "@utils/fork"
import { Signer, ContractFactory } from "ethers"
import { expect } from "chai"
import { network } from "hardhat"
import { deployContract } from "tasks/utils/deploy-utils"
import {
    BoostedVault,
    BoostedVault__factory,
    DelayedProxyAdmin,
    DelayedProxyAdmin__factory,
    ERC20__factory,
    IERC20__factory,
    // Mainnet ifUSD Contract
    SavingsContract,
    SavingsContract__factory,
    Unwrapper,
    Unwrapper__factory,
} from "types/generated"
import { Chain, DEAD_ADDRESS, simpleToExactAmount, assertBNClosePercent, DAI, WBTC, MTA, alUSD, fUSD, mBTC, HBTC, USDT } from "index"
import { BigNumber } from "@ethersproject/bignumber"
import { getChainAddress } from "tasks/utils/networkAddressFactory"
import { upgradeContract } from "@utils/deploy"

const chain = Chain.mainnet
const delayedProxyAdminAddress = getChainAddress("DelayedProxyAdmin", chain)
const governorAddress = getChainAddress("Governor", chain)
const nexusAddress = getChainAddress("Nexus", chain)
const boostDirectorAddress = getChainAddress("BoostDirector", chain)
const deployerAddress = getChainAddress("OperationsSigner", chain)

const ifusdHolderAddress = "0xdA1fD36cfC50ED03ca4dd388858A78C904379fb3"
const fusdHolderAddress = "0x8474ddbe98f5aa3179b3b3f5942d724afcdec9f6"
const imbtcHolderAddress = "0xd2270cdc82675a3c0ad8cbee1e9c26c85b46456c"
const vmbtcHolderAddress = "0x10d96b1fd46ce7ce092aa905274b8ed9d4585a6e"
const vhbtcmbtcHolderAddress = "0x10d96b1fd46ce7ce092aa905274b8ed9d4585a6e"
const vfusdHolderAddress = "0x0c2ef8a1b3bc00bf676053732f31a67ebba5bd81"

context("Unwrapper", () => {
    let deployer: Signer
    let fusdHolder: Signer
    let unwrapper: Unwrapper
    let governor: Signer
    let delayedProxyAdmin: DelayedProxyAdmin

    before("reset block number", async () => {
        await network.provider.request({
            method: "hardhat_reset",
            params: [
                {
                    forking: {
                        jsonRpcUrl: process.env.NODE_URL,
                        //  (Nov-01-2021 06:33:00 AM +UTC)
                        blockNumber: 13529662,
                    },
                },
            ],
        })
        fusdHolder = await impersonate(fusdHolderAddress)
        deployer = await impersonate(deployerAddress)
        governor = await impersonate(governorAddress)
        delayedProxyAdmin = DelayedProxyAdmin__factory.connect(delayedProxyAdminAddress, governor)
    })
    it("Test connectivity", async () => {
        const startEther = await deployer.getBalance()
        const address = await deployer.getTransactionCount()
        console.log(`Deployer ${address} has ${startEther} Ether`)
    })

    it("Deploys the unwrapper proxy contract ", async () => {
        unwrapper = await deployContract<Unwrapper>(new Unwrapper__factory(deployer), "Unwrapper", [nexusAddress])
        expect(unwrapper.address).to.length(42)

        // approve tokens for router
        const routers = [alUSD.feederPool, HBTC.feederPool]
        const tokens = [fUSD.address, mBTC.address]

        await unwrapper.connect(governor).approve(routers, tokens)
    })

    describe("Successfully call getIsBassetOut for", () => {
        const isCredit = true
        it("fAssets", async () => {
            expect(await unwrapper.callStatic.getIsBassetOut(fUSD.address, !isCredit, DAI.address)).to.eq(true)
            expect(await unwrapper.callStatic.getIsBassetOut(fUSD.address, !isCredit, USDT.address)).to.eq(true)
            expect(await unwrapper.callStatic.getIsBassetOut(fUSD.address, !isCredit, fUSD.address)).to.eq(false)
            expect(await unwrapper.callStatic.getIsBassetOut(fUSD.address, !isCredit, alUSD.address)).to.eq(false)
            expect(await unwrapper.callStatic.getIsBassetOut(mBTC.address, !isCredit, WBTC.address)).to.eq(true)
            expect(await unwrapper.callStatic.getIsBassetOut(mBTC.address, !isCredit, mBTC.address)).to.eq(false)
            expect(await unwrapper.callStatic.getIsBassetOut(mBTC.address, !isCredit, HBTC.address)).to.eq(false)
        })
        it("interest-bearing assets", async () => {
            expect(await unwrapper.callStatic.getIsBassetOut(fUSD.savings, isCredit, DAI.address)).to.eq(true)
            expect(await unwrapper.callStatic.getIsBassetOut(fUSD.savings, isCredit, USDT.address)).to.eq(true)
            expect(await unwrapper.callStatic.getIsBassetOut(fUSD.savings, isCredit, fUSD.address)).to.eq(false)
            expect(await unwrapper.callStatic.getIsBassetOut(fUSD.savings, isCredit, alUSD.address)).to.eq(false)
            expect(await unwrapper.callStatic.getIsBassetOut(mBTC.savings, isCredit, WBTC.address)).to.eq(true)
            expect(await unwrapper.callStatic.getIsBassetOut(mBTC.savings, isCredit, mBTC.address)).to.eq(false)
            expect(await unwrapper.callStatic.getIsBassetOut(mBTC.savings, isCredit, HBTC.address)).to.eq(false)
        })
    })

    const validateAssetRedemption = async (
        config: {
            router: string
            input: string
            output: string
            amount: BigNumber
            isCredit: boolean
        },
        signer: Signer,
    ) => {
        // Get estimated output via getUnwrapOutput
        const signerAddress = await signer.getAddress()
        const isBassetOut = await unwrapper.callStatic.getIsBassetOut(config.input, config.isCredit, config.output)

        const amountOut = await unwrapper.getUnwrapOutput(
            isBassetOut,
            config.router,
            config.input,
            config.isCredit,
            config.output,
            config.amount,
        )
        expect(amountOut.toString().length).to.be.gte(18)
        const minAmountOut = amountOut.mul(98).div(1e2)

        const newConfig = {
            ...config,
            minAmountOut,
            beneficiary: signerAddress,
        }

        // check balance before
        const tokenOut = IERC20__factory.connect(config.output, signer)
        const tokenBalanceBefore = await tokenOut.balanceOf(signerAddress)

        // approve fusd for unwrapping
        const fusd = IERC20__factory.connect(fUSD.address, signer)
        await fusd.approve(unwrapper.address, config.amount)

        // Statically call unwrapAndSend to get the returned quantity of output tokens
        const outputQuantity = await unwrapper
            .connect(signer)
            .callStatic.unwrapAndSend(
                isBassetOut,
                newConfig.router,
                newConfig.input,
                newConfig.output,
                newConfig.amount,
                newConfig.minAmountOut,
                newConfig.beneficiary,
            )
        // redeem to basset via unwrapAndSend
        await unwrapper
            .connect(signer)
            .unwrapAndSend(
                isBassetOut,
                newConfig.router,
                newConfig.input,
                newConfig.output,
                newConfig.amount,
                newConfig.minAmountOut,
                newConfig.beneficiary,
            )
        // check balance after
        const tokenBalanceAfter = await tokenOut.balanceOf(signerAddress)
        expect(tokenBalanceAfter, "Token balance has increased").to.be.gt(tokenBalanceBefore)
        expect(outputQuantity, "Token output quantity").to.eq(tokenBalanceAfter.sub(tokenBalanceBefore))
    }

    it("Receives the correct output from getUnwrapOutput", async () => {
        const config = {
            router: fUSD.address,
            input: fUSD.address,
            output: DAI.address,
            amount: simpleToExactAmount(1, 18),
            isCredit: false,
        }
        const isBassetOut = await unwrapper.callStatic.getIsBassetOut(config.input, config.isCredit, config.output)
        const output = await unwrapper.getUnwrapOutput(
            isBassetOut,
            config.router,
            config.input,
            config.isCredit,
            config.output,
            config.amount,
        )
        expect(output.toString()).to.be.length(19)
    })

    it("ifUSD redeem to bAsset via unwrapAndSend", async () => {
        const config = {
            router: fUSD.address,
            input: fUSD.address,
            output: DAI.address,
            amount: simpleToExactAmount(1, 18),
            isCredit: false,
        }
        await validateAssetRedemption(config, fusdHolder)
    })

    it("ifUSD redeem to fdAsset via unwrapAndSend", async () => {
        const config = {
            router: alUSD.feederPool,
            input: fUSD.address,
            output: alUSD.address,
            amount: simpleToExactAmount(1, 18),
            isCredit: false,
        }
        await validateAssetRedemption(config, fusdHolder)
    })

    it("Upgrades the ifUSD contract", async () => {
        const constructorArguments = [nexusAddress, fUSD.address, unwrapper.address]
        const fusdSaveImpl = await deployContract<SavingsContract>(
            new SavingsContract__factory(deployer),
            "mStable: fUSD Savings Contract",
            constructorArguments,
        )

        const saveContractProxy = await upgradeContract<SavingsContract>(
            SavingsContract__factory as unknown as ContractFactory,
            fusdSaveImpl,
            fUSD.savings,
            governor,
            delayedProxyAdmin,
        )
        const unwrapperAddress = await saveContractProxy.unwrapper()
        expect(unwrapperAddress).to.eq(unwrapper.address)
        expect(await delayedProxyAdmin.getProxyImplementation(fUSD.savings)).eq(fusdSaveImpl.address)
    })

    it("ifUSD contract works after upgraded", async () => {
        const ifusdHolder = await impersonate(ifusdHolderAddress)

        const config = {
            router: fUSD.address,
            input: fUSD.address,
            output: DAI.address,
            amount: simpleToExactAmount(1, 18),
            isCredit: false,
        }

        // Get estimated output via getUnwrapOutput
        const isBassetOut = await unwrapper.callStatic.getIsBassetOut(config.input, config.isCredit, config.output)
        const amountOut = await unwrapper.getUnwrapOutput(
            isBassetOut,
            config.router,
            config.input,
            config.isCredit,
            config.output,
            config.amount,
        )
        expect(amountOut.toString().length).to.be.gte(18)
        const minAmountOut = amountOut.mul(98).div(1e2)

        // dai balance before
        const daiBalanceBefore = await IERC20__factory.connect(DAI.address, ifusdHolder).balanceOf(ifusdHolderAddress)

        const saveContractProxy = SavingsContract__factory.connect(fUSD.savings, ifusdHolder)
        await saveContractProxy.redeemAndUnwrap(
            config.amount,
            config.isCredit,
            minAmountOut,
            config.output,
            ifusdHolderAddress,
            config.router,
            isBassetOut,
        )
        const daiBalanceAfter = await IERC20__factory.connect(DAI.address, ifusdHolder).balanceOf(ifusdHolderAddress)
        const tokenBalanceDifference = daiBalanceAfter.sub(daiBalanceBefore)
        expect(tokenBalanceDifference, "Withdrawn amount eq estimated amountOut").to.be.eq(amountOut)
        expect(daiBalanceAfter, "Token balance has increased").to.be.gt(daiBalanceBefore.add(minAmountOut))
    })

    it("Upgrades the ifUSD Vault", async () => {
        const priceCoeff = simpleToExactAmount(1, 18)
        const boostCoeff = 9
        const constructorArguments = [nexusAddress, fUSD.address, boostDirectorAddress, priceCoeff, boostCoeff, MTA.address]
        const saveVaultImpl = await deployContract<BoostedVault>(
            new BoostedVault__factory(deployer),
            "mStable: fUSD Savings Vault",
            constructorArguments,
        )
        await upgradeContract<BoostedVault>(
            BoostedVault__factory as unknown as ContractFactory,
            saveVaultImpl,
            fUSD.vault,
            governor,
            delayedProxyAdmin,
        )
        expect(await delayedProxyAdmin.getProxyImplementation(fUSD.vault)).eq(saveVaultImpl.address)
    })
    const withdrawAndUnwrap = async (holderAddress: string, router: string, input: "fusd" | "mbtc", outputAddress: string) => {
        const isCredit = true
        const holder = await impersonate(holderAddress)
        const vaultAddress = input === "fusd" ? fUSD.vault : mBTC.vault
        const inputAddress = input === "fusd" ? fUSD.savings : mBTC.savings
        const isBassetOut = await unwrapper.callStatic.getIsBassetOut(inputAddress, isCredit, outputAddress)

        const config = {
            router,
            input: inputAddress,
            output: outputAddress,
            amount: simpleToExactAmount(input === "fusd" ? 100 : 10, 18),
            isCredit,
        }

        // Get estimated output via getUnwrapOutput
        const amountOut = await unwrapper.getUnwrapOutput(
            isBassetOut,
            config.router,
            config.input,
            config.isCredit,
            config.output,
            config.amount,
        )
        expect(amountOut.toString().length).to.be.gte(input === "fusd" ? 18 : 9)
        const minAmountOut = amountOut.mul(98).div(1e2)

        const outContract = IERC20__factory.connect(config.output, holder)
        const tokenBalanceBefore = await outContract.balanceOf(holderAddress)

        // withdraw and unwrap
        const saveVault = BoostedVault__factory.connect(vaultAddress, holder)
        await saveVault.withdrawAndUnwrap(config.amount, minAmountOut, config.output, holderAddress, config.router, isBassetOut)

        const tokenBalanceAfter = await outContract.balanceOf(holderAddress)
        const tokenBalanceDifference = tokenBalanceAfter.sub(tokenBalanceBefore)
        assertBNClosePercent(tokenBalanceDifference, amountOut, 0.0001)
        expect(tokenBalanceAfter, "Token balance has increased").to.be.gt(tokenBalanceBefore)
    }

    it.skip("ifUSD Vault redeem to bAsset", async () => {
        await withdrawAndUnwrap(vfusdHolderAddress, fUSD.address, "fusd", DAI.address)
    })

    it.skip("ifUSD Vault redeem to fdAsset", async () => {
        await withdrawAndUnwrap(vfusdHolderAddress, alUSD.feederPool, "fusd", alUSD.address)
    })

    it("Upgrades the imBTC contract", async () => {
        const constructorArguments = [nexusAddress, mBTC.address, unwrapper.address]
        const saveImpl = await deployContract<SavingsContract>(
            new SavingsContract__factory(deployer),
            "mStable: mBTC Savings",
            constructorArguments,
        )

        await upgradeContract<SavingsContract>(
            SavingsContract__factory as unknown as ContractFactory,
            saveImpl,
            mBTC.savings,
            governor,
            delayedProxyAdmin,
        )
        expect(await delayedProxyAdmin.getProxyImplementation(mBTC.savings)).eq(saveImpl.address)
    })
    it("imBTC contract works after upgraded", async () => {
        const imbtcHolder = await impersonate(imbtcHolderAddress)

        const config = {
            router: mBTC.address,
            input: mBTC.address,
            output: WBTC.address,
            amount: simpleToExactAmount(1, 18),
            isCredit: false,
        }

        // Get estimated output via getUnwrapOutput
        const isBassetOut = await unwrapper.callStatic.getIsBassetOut(config.input, config.isCredit, config.output)
        const amountOut = await unwrapper.getUnwrapOutput(
            isBassetOut,
            config.router,
            config.input,
            config.isCredit,
            config.output,
            config.amount,
        )
        expect(amountOut.toString().length).to.be.gte(8)
        const minAmountOut = amountOut.mul(98).div(1e2)

        // wbtc balance before
        const wbtcBalanceBefore = await IERC20__factory.connect(WBTC.address, imbtcHolder).balanceOf(imbtcHolderAddress)
        const saveContractProxy = SavingsContract__factory.connect(mBTC.savings, imbtcHolder)

        await saveContractProxy.redeemAndUnwrap(
            config.amount,
            config.isCredit,
            minAmountOut,
            config.output,
            imbtcHolderAddress,
            config.router,
            isBassetOut,
        )
        const wbtcBalanceAfter = await IERC20__factory.connect(WBTC.address, imbtcHolder).balanceOf(imbtcHolderAddress)
        const tokenBalanceDifference = wbtcBalanceAfter.sub(wbtcBalanceBefore)
        expect(tokenBalanceDifference, "Withdrawn amount eq estimated amountOut").to.be.eq(amountOut)
        expect(wbtcBalanceAfter, "Token balance has increased").to.be.gt(wbtcBalanceBefore.add(minAmountOut))
    })

    it("Upgrades the imBTC Vault", async () => {
        const boostDirector = boostDirectorAddress
        const priceCoeff = simpleToExactAmount(4800, 18)
        const boostCoeff = 9

        const saveVaultImpl = await deployContract<BoostedVault>(new BoostedVault__factory(deployer), "mStable: mBTC Savings Vault", [
            nexusAddress,
            mBTC.savings,
            boostDirector,
            priceCoeff,
            boostCoeff,
            MTA.address,
        ])
        await upgradeContract<BoostedVault>(
            BoostedVault__factory as unknown as ContractFactory,
            saveVaultImpl,
            mBTC.vault,
            governor,
            delayedProxyAdmin,
        )
        expect(await delayedProxyAdmin.getProxyImplementation(mBTC.vault)).eq(saveVaultImpl.address)
    })

    it("imBTC Vault redeem to bAsset", async () => {
        await withdrawAndUnwrap(vmbtcHolderAddress, mBTC.address, "mbtc", WBTC.address)
    })

    it("imBTC Vault redeem to fdAsset", async () => {
        await withdrawAndUnwrap(vhbtcmbtcHolderAddress, HBTC.feederPool, "mbtc", HBTC.address)
    })

    it("Emits referrer successfully", async () => {
        const saveContractProxy = SavingsContract__factory.connect(fUSD.savings, fusdHolder)
        const fusdContractProxy = ERC20__factory.connect(fUSD.address, fusdHolder)
        await fusdContractProxy.approve(fUSD.savings, simpleToExactAmount(100, 18))
        const tx = await saveContractProxy["depositSavings(uint256,address,address)"](
            simpleToExactAmount(1, 18),
            fusdHolderAddress,
            DEAD_ADDRESS,
        )
        await expect(tx)
            .to.emit(saveContractProxy, "Referral")
            .withArgs(DEAD_ADDRESS, "0x8474DdbE98F5aA3179B3B3F5942D724aFcdec9f6", simpleToExactAmount(1, 18))
    })
})
