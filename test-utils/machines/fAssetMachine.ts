import { Signer } from "ethers"
import {
    AssetProxy__factory,
    MockNexus__factory,
    ExposedFasset,
    ExposedFasset__factory,
    Fasset,
    MockERC20,
    DelayedProxyAdmin,
    MockInitializableToken,
    MockAaveV2__factory,
    MockATokenV2__factory,
    MockPlatformIntegration,
    MockPlatformIntegration__factory,
    IPlatformIntegration,
    MockInitializableToken__factory,
    MockInitializableTokenWithFee__factory,
    AssetProxy,
    MockNexus,
    FassetLogic,
    FassetManager,
    FassetLogic__factory,
    FassetManager__factory,
    MockERC20__factory,
} from "types/generated"
import { BN, minimum, simpleToExactAmount } from "@utils/math"
import { fullScale, ratioScale, ZERO_ADDRESS, DEAD_ADDRESS } from "@utils/constants"
import { Basset } from "@utils/mstable-objects"
import { EthAddress } from "types/common"
import { StandardAccounts } from "./standardAccounts"
import { ActionDetails, ATokenDetails, BasketComposition, BassetIntegrationDetails } from "../../types/machines"

export interface FassetDetails {
    fAsset?: ExposedFasset
    bAssets?: Array<MockERC20>
    pTokens?: Array<string>
    proxyAdmin?: DelayedProxyAdmin
    platform?: MockPlatformIntegration
    aavePlatformAddress?: string
    integrationAddress?: string
    logicLib?: FassetLogic
    managerLib?: FassetManager
    wrappedManagerLib?: FassetManager
    nexus?: MockNexus
}

export class FassetMachine {
    public sa: StandardAccounts

    public async initAccounts(accounts: Signer[]): Promise<FassetMachine> {
        this.sa = await new StandardAccounts().initAccounts(accounts)
        return this
    }

    // 3 bAssets, custom reserve
    public async deployLite(a = 135): Promise<FassetDetails> {
        const bAssets = await Promise.all([0, 1, 2].map((i) => this.loadBassetProxy(`${i}BASSET`, `${i}BASSET`, 18)))

        // 2. Invariant Validator
        const logicLib = await new FassetLogic__factory(this.sa.default.signer).deploy()

        // 3. Invariant Validator
        const ManagerFactory = await new FassetManager__factory(this.sa.default.signer)
        const managerLib = await ManagerFactory.deploy()

        const nexus = await new MockNexus__factory(this.sa.default.signer).deploy(
            this.sa.governor.address,
            this.sa.mockSavingsManager.address,
            this.sa.mockInterestValidator.address,
        )
        const fAssetFactoryLibs = {
            "contracts/fasset/FassetLogic.sol:FassetLogic": logicLib.address,
            "contracts/fasset/FassetManager.sol:FassetManager": managerLib.address,
        }
        const FassetFactory = new ExposedFasset__factory(fAssetFactoryLibs, this.sa.default.signer)
        const impl = (await FassetFactory.deploy(nexus.address, simpleToExactAmount(5, 13))) as ExposedFasset

        const data = impl.interface.encodeFunctionData("initialize", [
            "fAsset Lite",
            "mLite",
            bAssets.map((b) => ({
                addr: b.address,
                integrator: ZERO_ADDRESS,
                hasTxFee: false,
                status: 0,
            })),
            {
                a: BN.from(a),
                limits: {
                    min: simpleToExactAmount(5, 16),
                    max: simpleToExactAmount(75, 16),
                },
            },
        ])
        const fAsset = await new AssetProxy__factory(this.sa.default.signer).deploy(impl.address, DEAD_ADDRESS, data)

        return {
            fAsset: (await FassetFactory.attach(fAsset.address)) as ExposedFasset,
            bAssets,
            logicLib: logicLib as FassetLogic,
            nexus,
        }
    }

    public async deployFasset(useLendingMarkets = false, useTransferFees = false, a = 100): Promise<FassetDetails> {
        // 1. Bassets
        const bAssets = await this.loadBassetsLocal(useLendingMarkets, useTransferFees)

        // 2. Invariant Validator
        const logicLib = await new FassetLogic__factory(this.sa.default.signer).deploy()

        // 3. Invariant Validator
        const ManagerFactory = await new FassetManager__factory(this.sa.default.signer)
        const managerLib = await ManagerFactory.deploy()

        const nexus = await new MockNexus__factory(this.sa.default.signer).deploy(
            this.sa.governor.address,
            this.sa.mockSavingsManager.address,
            this.sa.mockInterestValidator.address,
        )
        const integrationAddress = useLendingMarkets
            ? (
                  await new MockPlatformIntegration__factory(this.sa.default.signer).deploy(
                      nexus.address,
                      bAssets.aavePlatformAddress,
                      bAssets.bAssets.map((b) => b.address),
                      bAssets.aTokens.map((at) => at.aToken),
                  )
              ).address
            : ZERO_ADDRESS

        // 3.2. Fasset
        const fAssetFactoryLibs = {
            "contracts/fasset/FassetLogic.sol:FassetLogic": logicLib.address,
            "contracts/fasset/FassetManager.sol:FassetManager": managerLib.address,
        }
        const FassetFactory = new ExposedFasset__factory(fAssetFactoryLibs, this.sa.default.signer)
        const impl = (await FassetFactory.deploy(nexus.address, simpleToExactAmount(5, 13))) as Fasset

        const data = impl.interface.encodeFunctionData("initialize", [
            "mStable BTC",
            "mBTC",
            bAssets.bAssets.map((b, i) => ({
                addr: b.address,
                integrator: integrationAddress,
                hasTxFee: bAssets.bAssetTxFees[i],
                status: 0,
            })),
            {
                a,
                limits: {
                    min: simpleToExactAmount(5, 16),
                    max: simpleToExactAmount(65, 16),
                },
            },
        ])
        const fAsset = await new AssetProxy__factory(this.sa.default.signer).deploy(impl.address, DEAD_ADDRESS, data)

        if (useLendingMarkets) {
            await new MockPlatformIntegration__factory(this.sa.default.signer).attach(integrationAddress).addWhitelist([fAsset.address])
        }
        return {
            fAsset: (await FassetFactory.attach(fAsset.address)) as ExposedFasset,
            bAssets: bAssets.bAssets,
            aavePlatformAddress: bAssets.aavePlatformAddress,
            integrationAddress,
            platform: useLendingMarkets
                ? await new MockPlatformIntegration__factory(this.sa.default.signer).attach(integrationAddress)
                : null,
            pTokens: useLendingMarkets ? bAssets.aTokens.map((at) => at.aToken) : [],
            logicLib,
            managerLib,
            wrappedManagerLib: await ManagerFactory.attach(fAsset.address),
            nexus,
        }
    }

    /**
     * @dev Seeds the fAsset basket with custom weightings
     * @param md Fasset details object containing all deployed contracts
     * @param weights Whole numbers of fAsset to mint for each given bAsset
     */
    public async seedWithWeightings(md: FassetDetails, weights: Array<BN | number>, inputIsInBaseUnits = false): Promise<void> {
        const { fAsset, bAssets } = md
        const approvals = await Promise.all(
            bAssets.map((b, i) => this.approveFasset(b, fAsset, weights[i], this.sa.default.signer, inputIsInBaseUnits)),
        )
        await fAsset.mintMulti(
            bAssets.map((b) => b.address),
            approvals,
            0,
            this.sa.default.address,
        )
    }

    // /**
    //  * @dev Deploys an fAsset with default parameters, modelled on original fUSD
    //  * @return Interface will all deployed information
    //  */
    // public async deployFasset(enableUSDTFee = false, useOldAave = false): Promise<FassetDetails> {
    //     const md: FassetDetails = {};

    //     /** *************************************
    //     0. Mock platforms and bAssets
    //     Dependencies: []
    //     *************************************** */
    //     const bassetDetails = await this.loadBassets(enableUSDTFee, useOldAave);
    //     md.bAssets = bassetDetails.bAssets;

    //     /** *************************************
    //     2. fUSD
    //         Dependencies: [
    //             BasketManager [
    //                 ProxyAdmin,
    //                 PlatformIntegrations [
    //                     MockPlatforms
    //                 ]
    //             ]
    //         ]
    //     *************************************** */

    //     // 2.0. Deploy ProxyAdmin
    //     const d_DelayedProxyAdmin: t.DelayedProxyAdminInstance = await c_DelayedProxyAdmin.new(
    //         this.system.nexus.address,
    //         {
    //             from: this.sa.default,
    //         },
    //     );
    //     md.proxyAdmin = d_DelayedProxyAdmin;

    //     // 2.1. Deploy no Init BasketManager
    //     //  - Deploy Implementation
    //     const d_BasketManager = await c_BasketManager.new();
    //     //  - Initialize the BasketManager implementation to avoid someone else doing it
    //     const d_DeadIntegration = await c_DeadIntegration.new();
    //     const d_DeadErc20 = await c_MockERC20.new("DEAD", "D34", 18, DEAD_ADDRESS, 1);
    //     await d_BasketManager.initialize(
    //         DEAD_ADDRESS,
    //         DEAD_ADDRESS,
    //         [d_DeadErc20.address],
    //         [d_DeadIntegration.address],
    //         [percentToWeight(100).toString()],
    //         [false],
    //     );
    //     //  - Deploy Initializable Proxy
    //     const d_BasketManagerProxy = await c_BasketManagerProxy.new();

    //     // 2.2. Deploy no Init AaveIntegration
    //     //  - Deploy Implementation with dummy params (this storage doesn't get used)
    //     const d_AaveIntegration = await (useOldAave
    //         ? c_AaveIntegration.new()
    //         : c_AaveV2Integration.new());
    //     await d_AaveIntegration.initialize(DEAD_ADDRESS, [DEAD_ADDRESS], DEAD_ADDRESS, [], []);
    //     //  - Deploy Initializable Proxy
    //     const d_AaveIntegrationProxy = await c_VaultProxy.new();

    //     // 2.3. Deploy no Init CompoundIntegration
    //     //  - Deploy Implementation
    //     // We do not need platform address for compound
    //     const d_CompoundIntegration: t.CompoundIntegrationInstance = await c_CompoundIntegration.new();
    //     await d_CompoundIntegration.initialize(DEAD_ADDRESS, [DEAD_ADDRESS], DEAD_ADDRESS, [], []);
    //     //  - Deploy Initializable Proxy
    //     const d_CompoundIntegrationProxy = await c_VaultProxy.new();

    //     md.basketManager = await c_BasketManager.at(d_BasketManagerProxy.address);
    //     md.aaveIntegration = await c_AaveIntegration.at(d_AaveIntegrationProxy.address);
    //     md.compoundIntegration = await c_CompoundIntegration.at(d_CompoundIntegrationProxy.address);

    //     // 2.4. Deploy fUSD (w/ BasketManager addr)
    //     // 2.4.1. Deploy ForgeValidator
    //     const d_ForgeValidator = await c_ForgeValidator.new({
    //         from: this.sa.default,
    //     });
    //     md.forgeValidator = d_ForgeValidator;
    //     // 2.4.2. Deploy fUSD
    //     // Deploy implementation
    //     const d_fUSD = await c_Fasset.new();
    //     await d_fUSD.initialize("", "", DEAD_ADDRESS, DEAD_ADDRESS, DEAD_ADDRESS);
    //     // Deploy proxy
    //     const d_fUSDProxy = await c_AssetProxy.new();
    //     // Initialize proxy
    //     const initializationData_fUSD: string = d_fUSD.contract.methods
    //         .initialize(
    //             "mStable Mock",
    //             "mMOCK",
    //             this.system.nexus.address,
    //             d_ForgeValidator.address,
    //             d_BasketManagerProxy.address,
    //         )
    //         .encodeABI();
    //     await d_fUSDProxy.methods["initialize(address,address,bytes)"](
    //         d_fUSD.address,
    //         d_DelayedProxyAdmin.address,
    //         initializationData_fUSD,
    //     );
    //     md.fAsset = await c_Fasset.at(d_fUSDProxy.address);

    //     // 2.5. Init AaveIntegration
    //     const initializationData_AaveIntegration: string = d_AaveIntegration.contract.methods
    //         .initialize(
    //             this.system.nexus.address,
    //             [d_fUSDProxy.address, d_BasketManagerProxy.address],
    //             bassetDetails.aavePlatformAddress,
    //             bassetDetails.aTokens.map((a) => a.bAsset),
    //             bassetDetails.aTokens.map((a) => a.aToken),
    //         )
    //         .encodeABI();
    //     await d_AaveIntegrationProxy.methods["initialize(address,address,bytes)"](
    //         d_AaveIntegration.address,
    //         d_DelayedProxyAdmin.address,
    //         initializationData_AaveIntegration,
    //     );

    //     // 2.6. Init CompoundIntegration
    //     const initializationData_CompoundIntegration: string = d_CompoundIntegration.contract.methods
    //         .initialize(
    //             this.system.nexus.address,
    //             [d_fUSDProxy.address, d_BasketManagerProxy.address],
    //             ZERO_ADDRESS, // We don't need Compound sys addr
    //             bassetDetails.cTokens.map((c) => c.bAsset),
    //             bassetDetails.cTokens.map((c) => c.cToken),
    //         )
    //         .encodeABI();
    //     await d_CompoundIntegrationProxy.methods["initialize(address,address,bytes)"](
    //         d_CompoundIntegration.address,
    //         d_DelayedProxyAdmin.address,
    //         initializationData_CompoundIntegration,
    //     );

    //     // 2.7. Init BasketManager
    //     const weight = 100;
    //     const initializationData_BasketManager: string = d_BasketManager.contract.methods
    //         .initialize(
    //             this.system.nexus.address,
    //             d_fUSDProxy.address,
    //             bassetDetails.bAssets.map((b) => b.address),
    //             bassetDetails.platforms.map((p) =>
    //                 p === Platform.aave
    //                     ? d_AaveIntegrationProxy.address
    //                     : d_CompoundIntegrationProxy.address,
    //             ),
    //             bassetDetails.bAssets.map(() => percentToWeight(weight).toString()),
    //             bassetDetails.fees,
    //         )
    //         .encodeABI();
    //     await d_BasketManagerProxy.methods["initialize(address,address,bytes)"](
    //         d_BasketManager.address,
    //         d_DelayedProxyAdmin.address,
    //         initializationData_BasketManager,
    //     );

    //     return md;
    // }

    // public async loadBassets(
    //     enableUSDTFee = false,
    //     useOldAave = false,
    // ): Promise<BassetIntegrationDetails> {
    //     return this.system.isGanacheFork
    //         ? this.loadBassetsFork(enableUSDTFee)
    //         : this.loadBassetsLocal(enableUSDTFee, useOldAave);
    // }

    // public async loadBassetsFork(enableUSDTFee = false): Promise<BassetIntegrationDetails> {
    //     // load all the REAL bAssets
    //     const bAsset_DAI = await c_MockERC20.at(this.ma.DAI);
    //     await this.mintERC20(bAsset_DAI, this.ma.FUND_SOURCES.dai);

    //     const bAsset_USDC = await c_MockERC20.at(this.ma.USDC);
    //     await this.mintERC20(bAsset_USDC, this.ma.FUND_SOURCES.usdc);

    //     const bAsset_TUSD = await c_MockERC20.at(this.ma.TUSD);
    //     await this.mintERC20(bAsset_TUSD, this.ma.FUND_SOURCES.tusd);

    //     const bAsset_USDT = await c_MockERC20.at(this.ma.USDT);
    //     await this.mintERC20(bAsset_USDT, this.ma.FUND_SOURCES.usdt);

    //     const mockUSDT = await c_MockUSDT.at(bAsset_USDT.address);
    //     if (enableUSDTFee) {
    //         // Set fee rate to 0.1% and max fee to 30 USDT
    //         await mockUSDT.setParams("10", "30", {
    //             from: this.ma.USDT_OWNER,
    //         });
    //     } else {
    //         // Set fee rate to 0.1% and max fee to 30 USDT
    //         await mockUSDT.setParams("0", "30", {
    //             from: this.ma.USDT_OWNER,
    //         });
    //     }
    //     // credit sa.default with ample balances
    //     const bAssets = [bAsset_DAI, bAsset_USDC, bAsset_TUSD, bAsset_USDT];
    //     // return all the addresses
    //     return {
    //         bAssets,
    //         fees: [false, false, false, enableUSDTFee],
    //         platforms: [Platform.compound, Platform.compound, Platform.aave, Platform.aave],
    //         aavePlatformAddress: this.ma.aavePlatform,
    //         aTokens: [
    //             {
    //                 bAsset: bAsset_TUSD.address,
    //                 aToken: this.ma.aTUSD,
    //             },
    //             {
    //                 bAsset: bAsset_USDT.address,
    //                 aToken: this.ma.aUSDT,
    //             },
    //         ],
    //         cTokens: [
    //             {
    //                 bAsset: bAsset_DAI.address,
    //                 cToken: this.ma.cDAI,
    //             },
    //             {
    //                 bAsset: bAsset_USDC.address,
    //                 cToken: this.ma.cUSDC,
    //             },
    //         ],
    //     };
    // }

    public async loadBassetProxy(
        name: string,
        sym: string,
        dec: number,
        recipient: string = this.sa.default.address,
        init = 10000000000,
        enableUSDTFee = false,
    ): Promise<MockERC20> {
        // Factories
        const tokenFactory = enableUSDTFee
            ? await new MockInitializableTokenWithFee__factory(this.sa.default.signer)
            : await new MockInitializableToken__factory(this.sa.default.signer)
        const AssetProxyFactory = new AssetProxy__factory(this.sa.default.signer)

        // Impl
        const mockInitializableToken = (await tokenFactory.deploy()) as MockInitializableToken

        // Proxy
        const data = await mockInitializableToken.interface.encodeFunctionData("initialize", [name, sym, dec, recipient, init])
        const fAssetProxy = await AssetProxyFactory.deploy(mockInitializableToken.address, this.sa.governor.address, data)
        const fAsset = MockERC20__factory.connect(fAssetProxy.address, this.sa.default.signer)
        return fAsset
    }

    public async loadBassetsLocal(
        useLendingMarkets = false,
        useTransferFees = false,
        recipient = this.sa.default.address,
    ): Promise<BassetIntegrationDetails> {
        //  - Mock bAssets
        const mockBasset1 = await this.loadBassetProxy("Ren BTC", "renBTC", 18, recipient)
        const mockBasset2 = await this.loadBassetProxy("Synthetix BTC", "sBTC", 6, recipient)
        const mockBasset3 = await this.loadBassetProxy("Wrapped BTC", "wBTC", 12, recipient, 10000000000, useTransferFees)
        const mockBasset4 = await this.loadBassetProxy("Binance Wrapped BTC", "bBTC", 18, recipient, 10000000000, useTransferFees)
        const bAssets = [mockBasset1, mockBasset2, mockBasset3, mockBasset4]
        // bAssets at index 2 and 3 only have transfer fees if useTransferFees is true
        const bAssetTxFees = bAssets.map((_, i) => useTransferFees && (i === 2 || i === 3))

        // Only deploy Aave mock and A tokens if lending markets are required
        const lendingProperties = useLendingMarkets ? await this.loadATokens(bAssets) : {}

        return {
            aavePlatformAddress: ZERO_ADDRESS,
            aTokens: [],
            ...lendingProperties,
            bAssets,
            bAssetTxFees,
        }
    }

    /**
     * Deploy a mocked Aave contract.
     * For each bAsset:
     *   - transfer some bAsset tokens to the Aave mock
     *   - deploy a new mocked A token for the bAsset
     *   - add new A token to the fAsset platform integration
     * @param bAssets
     * @returns
     */
    public async loadATokens(bAssets: MockERC20[]): Promise<{
        aavePlatformAddress: EthAddress
        aTokens?: Array<ATokenDetails>
    }> {
        //  - Mock Aave integration
        const mockAave = await new MockAaveV2__factory(this.sa.default.signer).deploy()
        await Promise.all(bAssets.map(async (b) => b.transfer(mockAave.address, (await b.totalSupply()).div(1000))))

        //  - Mock aTokens
        const aTokenFactory = new MockATokenV2__factory(this.sa.default.signer)
        const mockATokens = await Promise.all(bAssets.map((b) => aTokenFactory.deploy(mockAave.address, b.address)))

        //  - Add to the Platform
        await Promise.all(bAssets.map((b, i) => mockAave.addAToken(mockATokens[i].address, b.address)))

        return {
            aavePlatformAddress: mockAave.address,
            aTokens: bAssets.map((b, i) => ({
                bAsset: b.address,
                aToken: mockATokens[i].address,
            })),
        }
    }

    // public async mintERC20(
    //     erc20: t.MockERC20Instance,
    //     source: Address,
    //     recipient: string = this.sa.default,
    // ): Promise<Truffle.TransactionResponse<any>> {
    //     const decimals = await erc20.decimals();
    //     return erc20.transfer(recipient, simpleToExactAmount(1000, decimals), {
    //         from: source,
    //     });
    // }

    // /**
    //  * @dev Deploy a Fasset via the Manager then:
    //  *      1. Mint with optimal weightings
    //  */
    // public async deployFassetAndSeedBasket(
    //     enableUSDTFee = false,
    //     initialSupply = 100,
    // ): Promise<FassetDetails> {
    //     const fAssetDetails = await this.deployFasset(enableUSDTFee);

    //     // Mint initialSupply with shared weightings
    //     const basketDetails = await this.getBassetsInFasset(fAssetDetails);

    //     // Calc optimal weightings
    //     const totalWeighting = basketDetails.reduce((p, c) => {
    //         return p.add(new BN(c.maxWeight));
    //     }, new BN(0));
    //     const totalMintAmount = simpleToExactAmount(initialSupply, 18);
    //     const mintAmounts = await Promise.all(
    //         basketDetails.map(async (b) => {
    //             // e.g. 5e35 / 2e18 = 2.5e17
    //             const relativeWeighting = new BN(b.maxWeight).mul(fullScale).div(totalWeighting);
    //             // e.g. 1e20 * 25e16 / 1e18 = 25e18
    //             const mintAmount = totalMintAmount.mul(relativeWeighting).div(fullScale);
    //             // const bAssetDecimals: BN = await b.decimals();
    //             // const decimalDelta = new BN(18).sub(bAssetDecimals);
    //             return mintAmount.mul(ratioScale).div(new BN(b.ratio));
    //         }),
    //     );

    //     // Approve bAssets
    //     await Promise.all(
    //         fAssetDetails.bAssets.map((b, i) =>
    //             b.approve(fAssetDetails.fAsset.address, mintAmounts[i].muln(2), {
    //                 from: this.system.sa.default,
    //             }),
    //         ),
    //     );

    //     await fAssetDetails.fAsset.mintMulti(
    //         basketDetails.map((b) => b.addr),
    //         mintAmounts,
    //         this.system.sa.default,
    //         { from: this.system.sa.default },
    //     );
    //     await fAssetDetails.fAsset.mintMulti(
    //         basketDetails.map((b) => b.addr),
    //         mintAmounts,
    //         this.system.sa.default,
    //         { from: this.system.sa.default },
    //     );

    //     return fAssetDetails;
    // }

    public async getBassetsInFasset(fAssetDetails: FassetDetails): Promise<Basset[]> {
        const [personal, data] = await fAssetDetails.fAsset.getBassets()
        const bArrays: Array<Basset> = personal.map((b, i) => {
            const d = data[i]
            return {
                addr: b.addr,
                status: b.status,
                isTransferFeeCharged: b.hasTxFee,
                ratio: BN.from(d.ratio),
                vaultBalance: BN.from(d.vaultBalance),
                integratorAddr: b.integrator,
            }
        })
        const bAssetContracts: MockERC20[] = await Promise.all(
            bArrays.map((b) => MockERC20__factory.connect(b.addr, this.sa.default.signer)),
        )
        const integrators = await Promise.all(
            bArrays.map((b) =>
                b.integratorAddr === ZERO_ADDRESS
                    ? null
                    : (MockPlatformIntegration__factory.connect(
                          b.integratorAddr,
                          this.sa.default.signer,
                      ) as unknown as IPlatformIntegration),
            ),
        )
        return bArrays.map((b, i) => ({
            ...b,
            contract: bAssetContracts[i],
            integrator: integrators[i],
        }))
    }

    public async getBasset(fAssetDetails: FassetDetails, bAssetAddress: string): Promise<Basset> {
        const bAsset = await fAssetDetails.fAsset.getBasset(bAssetAddress)
        const bAssetContract = MockERC20__factory.connect(bAsset.personal.addr, this.sa.default.signer)
        const integrator =
            bAsset.personal.integrator === ZERO_ADDRESS
                ? null
                : ((await new MockPlatformIntegration__factory(this.sa.default.signer).attach(
                      bAsset.personal.integrator,
                  )) as unknown as IPlatformIntegration)
        return {
            addr: bAsset.personal.addr,
            status: bAsset.personal.status,
            isTransferFeeCharged: bAsset.personal.hasTxFee,
            ratio: BN.from(bAsset.bData.ratio),
            vaultBalance: BN.from(bAsset.bData.vaultBalance),
            integratorAddr: bAsset.personal.integrator,
            contract: bAssetContract,
            pToken: integrator ? await integrator.callStatic["bAssetToPToken(address)"](bAsset.personal.addr) : null,
            integrator,
        }
    }

    public async getBasketComposition(fAssetDetails: FassetDetails): Promise<BasketComposition> {
        // raw bAsset data
        const bAssets = await this.getBassetsInFasset(fAssetDetails)

        const [failed, undergoingRecol] = await fAssetDetails.fAsset.getBasket()
        // total supply of fAsset
        const supply = await fAssetDetails.fAsset.totalSupply()
        const { surplus } = await fAssetDetails.fAsset.data()
        // get actual balance of each bAsset
        const rawBalances = await Promise.all(
            bAssets.map((b) =>
                b.integrator ? b.contract.balanceOf(b.integrator.address) : b.contract.balanceOf(fAssetDetails.fAsset.address),
            ),
        )
        const platformBalances = await Promise.all(
            bAssets.map((b) => (b.integrator ? b.integrator.callStatic.checkBalance(b.addr) : BN.from(0))),
        )

        const balances = rawBalances.map((b, i) => b.add(platformBalances[i]))
        // get overweight
        const currentVaultUnits = bAssets.map((b) => BN.from(b.vaultBalance).mul(BN.from(b.ratio)).div(ratioScale))
        // get total amount
        const sumOfBassets = currentVaultUnits.reduce((p, c) => p.add(c), BN.from(0))
        return {
            bAssets: bAssets.map((b, i) => ({
                ...b,
                address: b.addr,
                fAssetUnits: currentVaultUnits[i],
                actualBalance: balances[i],
                rawBalance: rawBalances[i],
                platformBalance: platformBalances[i],
            })),
            totalSupply: supply,
            surplus,
            sumOfBassets,
            failed,
            undergoingRecol,
        }
    }

    /**
     * @dev Takes a whole unit approval amount, and converts it to the equivalent
     * base asset amount, before approving and returning the exact approval
     * @param bAsset Asset to approve spending of
     * @param fAsset Fasset that gets permission to spend
     * @param fullFassetUnits Whole number or fraction to approve
     * @param sender Set if needed, else fall back to default
     * @param inputIsBaseUnits Override the scaling up to FassetQ
     */
    public async approveFasset(
        bAsset: MockERC20,
        fAsset: Fasset | ExposedFasset | MockERC20 | AssetProxy,
        fullFassetUnits: number | BN | string,
        sender: Signer = this.sa.default.signer,
        inputIsBaseUnits = false,
    ): Promise<BN> {
        const bAssetDecimals = await bAsset.decimals()
        const approvalAmount: BN = inputIsBaseUnits ? BN.from(fullFassetUnits) : simpleToExactAmount(fullFassetUnits, bAssetDecimals)
        await bAsset.connect(sender).approve(fAsset.address, approvalAmount)
        return approvalAmount
    }

    public async approveFassetMulti(
        bAssets: Array<MockERC20>,
        fAsset: Fasset | ExposedFasset,
        fullFassetUnits: number,
        sender: Signer,
    ): Promise<Array<BN>> {
        const result = Promise.all(bAssets.map((b) => this.approveFasset(b, fAsset, fullFassetUnits, sender)))
        return result
    }

    public static async getPlatformInteraction(
        fAsset: Fasset | ExposedFasset,
        type: "deposit" | "withdrawal",
        amount: BN,
        bAsset: Basset,
    ): Promise<ActionDetails> {
        const hasIntegrator = bAsset.integratorAddr === ZERO_ADDRESS
        const integratorBalBefore = await bAsset.contract.balanceOf(bAsset.integrator ? bAsset.integratorAddr : fAsset.address)
        if (hasIntegrator) {
            return {
                hasLendingMarket: false,
                expectInteraction: false,
                rawBalance: type === "deposit" ? integratorBalBefore.add(amount) : integratorBalBefore.sub(amount),
            }
        }
        const hasTxFee = bAsset.isTransferFeeCharged
        if (hasTxFee) {
            return {
                hasLendingMarket: true,
                expectInteraction: true,
                amount,
                rawBalance: BN.from(0),
            }
        }
        const totalSupply = await fAsset.totalSupply()
        const { cacheSize, surplus } = await fAsset.data()
        const maxC = totalSupply.add(surplus).mul(ratioScale).div(BN.from(bAsset.ratio)).mul(cacheSize).div(fullScale)
        const newSum = BN.from(integratorBalBefore).add(amount)
        const expectInteraction = type === "deposit" ? newSum.gte(maxC) : amount.gt(BN.from(integratorBalBefore))
        return {
            hasLendingMarket: true,
            expectInteraction,
            amount:
                type === "deposit"
                    ? newSum.sub(maxC.div(2))
                    : minimum(
                          maxC.div(2).add(amount).sub(BN.from(integratorBalBefore)),
                          BN.from(bAsset.vaultBalance).sub(BN.from(integratorBalBefore)),
                      ),
            rawBalance:
                type === "deposit"
                    ? expectInteraction
                        ? maxC.div(2)
                        : newSum
                    : expectInteraction
                    ? minimum(maxC.div(2), BN.from(bAsset.vaultBalance).sub(amount))
                    : BN.from(integratorBalBefore).sub(amount),
        }
    }
}
