// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

// External
import { ISavingsManager } from "../interfaces/ISavingsManager.sol";

// Internal
import { ISavingsContractV4 } from "../interfaces/ISavingsContract.sol";
import { IUnwrapper } from "../interfaces/IUnwrapper.sol";
import { InitializableToken } from "../shared/InitializableToken.sol";
import { ImmutableModule } from "../shared/ImmutableModule.sol";
import { IConnector } from "./peripheral/IConnector.sol";
import { Initializable } from "../shared/@openzeppelin-2.5/Initializable.sol";

// Libs
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { StableMath } from "../shared/StableMath.sol";
import { YieldValidator } from "../shared/YieldValidator.sol";

/**
 * @title   SavingsContract
 * @author voltfinance
 * @notice  Savings contract uses the ever increasing "exchangeRate" to increase
 *          the value of the Savers "credits" (ERC20) relative to the amount of additional
 *          underlying collateral that has been deposited into this contract ("interest")
 * @dev     VERSION: 2.2
 *          DATE:    2022-04-08
 */
contract SavingsContract is ISavingsContractV4, Initializable, InitializableToken, ImmutableModule {
    using StableMath for uint256;

    // Core events for depositing and withdrawing
    event ExchangeRateUpdated(uint256 newExchangeRate, uint256 interestCollected);
    event SavingsDeposited(address indexed saver, uint256 savingsDeposited, uint256 creditsIssued);
    event CreditsRedeemed(
        address indexed redeemer,
        uint256 creditsRedeemed,
        uint256 savingsCredited
    );

    event AutomaticInterestCollectionSwitched(bool automationEnabled);

    // Connector poking
    event PokerUpdated(address poker);

    event FractionUpdated(uint256 fraction);
    event ConnectorUpdated(address connector);
    event EmergencyUpdate();

    event Poked(uint256 oldBalance, uint256 newBalance, uint256 interestDetected);
    event PokedRaw();

    // Tracking events
    event Referral(address indexed referrer, address beneficiary, uint256 amount);

    // Rate between 'savings credits' and underlying
    // e.g. 1 credit (1e17) mulTruncate(exchangeRate) = underlying, starts at 10:1
    // exchangeRate increases over time
    uint256 private constant startingRate = 1e17;
    uint256 public override exchangeRate;

    // Underlying asset is underlying
    IERC20 public immutable override underlying;
    bool private automateInterestCollection;

    // Yield
    // Poker is responsible for depositing/withdrawing from connector
    address public poker;
    // Last time a poke was made
    uint256 public lastPoke;
    // Last known balance of the connector
    uint256 public lastBalance;
    // Fraction of capital assigned to the connector (100% = 1e18)
    uint256 public fraction;
    // Address of the current connector (all IConnectors are mStable validated)
    IConnector public connector;
    // How often do we allow pokes
    uint256 private constant POKE_CADENCE = 4 hours;
    // Max APY generated on the capital in the connector
    uint256 private constant MAX_APY = 4e18;
    uint256 private constant SECONDS_IN_YEAR = 365 days;
    // Proxy contract for easy redemption
    address public immutable unwrapper;

    constructor(
        address _nexus,
        address _underlying,
        address _unwrapper
    ) ImmutableModule(_nexus) {
        require(_underlying != address(0), "mAsset address is zero");
        require(_unwrapper != address(0), "Unwrapper address is zero");
        underlying = IERC20(_underlying);
        unwrapper = _unwrapper;
    }

    // Add these constants to bytecode at deploytime
    function initialize(
        address _poker,
        string calldata _nameArg,
        string calldata _symbolArg
    ) external initializer {
        InitializableToken._initialize(_nameArg, _symbolArg);

        require(_poker != address(0), "Invalid poker address");
        poker = _poker;

        fraction = 2e17;
        automateInterestCollection = true;
        exchangeRate = startingRate;
    }

    /** @dev Only the savings managaer (pulled from Nexus) can execute this */
    modifier onlySavingsManager() {
        require(msg.sender == _savingsManager(), "Only savings manager can execute");
        _;
    }

    /***************************************
                    VIEW - E
    ****************************************/

    /**
     * @notice Returns the underlying balance of a given user
     * @param _user     Address of the user to check
     * @return balance  Units of underlying owned by the user. eg mUSD or mBTC
     */
    function balanceOfUnderlying(address _user) external view override returns (uint256 balance) {
        (balance, ) = _creditsToUnderlying(balanceOf(_user));
    }

    /**
     * @notice Converts a given underlying amount into credits. eg mUSD to imUSD.
     * @dev see IERC4626Vault.convertToShares()
     * @param _underlying  Units of underlying. eg mUSD or mBTC.
     * @return credits     Units of crefit. eg imUSD or imBTC
     */
    function underlyingToCredits(uint256 _underlying)
        external
        view
        override
        returns (uint256 credits)
    {
        (credits, ) = _underlyingToCredits(_underlying);
    }

    /**
     * @notice Converts a given credit amount into underlying. eg imUSD to mUSD
     * @dev see IERC4626Vault.convertToAssets(address)
     * @param _credits  Units of credits. eg imUSD or imBTC
     * @return amount   Units of underlying. eg mUSD or mBTC.
     */
    function creditsToUnderlying(uint256 _credits) external view override returns (uint256 amount) {
        (amount, ) = _creditsToUnderlying(_credits);
    }

    /**
     * @dev see IERC4626Vault.balanceOf(address)
     *  Maintained for backwards compatibility
     *  Returns the credit balance of a given user
     **/
    function creditBalances(address _user) external view override returns (uint256 balance) {
        balance = balanceOf(_user);
    }

    /***************************************
                    INTEREST
    ****************************************/

    /**
     * @notice Deposit interest (add to savings) and update exchange rate of contract.
     *      Exchange rate is calculated as the ratio between new savings q and credits:
     *                    exchange rate = savings / credits
     *
     * @param _amount   Units of underlying to add to the savings vault
     */
    function depositInterest(uint256 _amount) external override onlySavingsManager {
        require(_amount > 0, "Must deposit something");

        // Transfer the interest from sender to here
        require(underlying.transferFrom(msg.sender, address(this), _amount), "Must receive tokens");

        // Calc new exchange rate, protect against initialisation case
        uint256 totalCredits = totalSupply();
        if (totalCredits > 0) {
            // new exchange rate is relationship between _totalCredits & totalSavings
            // _totalCredits * exchangeRate = totalSavings
            // exchangeRate = totalSavings/_totalCredits
            (uint256 totalCollat, ) = _creditsToUnderlying(totalCredits);
            uint256 newExchangeRate = _calcExchangeRate(totalCollat + _amount, totalCredits);
            exchangeRate = newExchangeRate;

            emit ExchangeRateUpdated(newExchangeRate, _amount);
        }
    }

    /** @notice Enable or disable the automation of fee collection during deposit process */
    function automateInterestCollectionFlag(bool _enabled) external onlyGovernor {
        automateInterestCollection = _enabled;
        emit AutomaticInterestCollectionSwitched(_enabled);
    }

    /***************************************
                    DEPOSIT
    ****************************************/

    /**
     * @notice During a migration period, allow savers to deposit underlying here before the interest has been redirected
     * @param _underlying      Units of underlying to deposit into savings vault
     * @param _beneficiary     Immediately transfer the imUSD token to this beneficiary address
     * @return creditsIssued   Units of credits (imUSD) issued
     */
    function preDeposit(uint256 _underlying, address _beneficiary)
        external
        returns (uint256 creditsIssued)
    {
        require(exchangeRate == startingRate, "Can only use this method before streaming begins");
        creditsIssued = _deposit(_underlying, _beneficiary, false);
    }

    /**
     * @dev see IERC4626Vault.deposit(uint256 assets, address receiver)
     * @notice Deposit the senders savings to the vault, and credit them internally with "credits".
     *      Credit amount is calculated as a ratio of deposit amount and exchange rate:
     *                    credits = underlying / exchangeRate
     *      We will first update the internal exchange rate by collecting any interest generated on the underlying.
     * @param _underlying      Units of underlying to deposit into savings vault. eg mUSD or mBTC
     * @return creditsIssued   Units of credits issued. eg imUSD or imBTC
     */
    function depositSavings(uint256 _underlying) external override returns (uint256 creditsIssued) {
        creditsIssued = _deposit(_underlying, msg.sender, true);
    }

    /**
     * @dev see IERC4626Vault.deposit(uint256 assets, address receiver)
     * @notice Deposit the senders savings to the vault, and credit them internally with "credits".
     *      Credit amount is calculated as a ratio of deposit amount and exchange rate:
     *                    credits = underlying / exchangeRate
     *      We will first update the internal exchange rate by collecting any interest generated on the underlying.
     * @param _underlying      Units of underlying to deposit into savings vault. eg mUSD or mBTC
     * @param _beneficiary     Address to the new credits will be issued to.
     * @return creditsIssued   Units of credits issued. eg imUSD or imBTC
     */
    function depositSavings(uint256 _underlying, address _beneficiary)
        external
        override
        returns (uint256 creditsIssued)
    {
        creditsIssued = _deposit(_underlying, _beneficiary, true);
    }

    /**
     * @dev see IERC4626Vault.deposit(uint256 assets, address receiver, address _referrer)
     * @notice Overloaded `depositSavings` method with an optional referrer address.
     * @param _underlying      Units of underlying to deposit into savings vault. eg mUSD or mBTC
     * @param _beneficiary     Address to the new credits will be issued to.
     * @param _referrer        Referrer address for this deposit.
     * @return creditsIssued   Units of credits issued. eg imUSD or imBTC
     */
    function depositSavings(
        uint256 _underlying,
        address _beneficiary,
        address _referrer
    ) external override returns (uint256 creditsIssued) {
        emit Referral(_referrer, _beneficiary, _underlying);
        creditsIssued = _deposit(_underlying, _beneficiary, true);
    }

    /**
     * @dev Internally deposit the _underlying from the sender and credit the beneficiary with new imUSD
     */
    function _deposit(
        uint256 _underlying,
        address _beneficiary,
        bool _collectInterest
    ) internal returns (uint256 creditsIssued) {
        creditsIssued = _transferAndMint(_underlying, _beneficiary, _collectInterest);
    }

    /***************************************
                    REDEEM
    ****************************************/

    /** @dev Deprecated in favour of redeemCredits.
     * Maintaining backwards compatibility, this fn minimics the old redeem fn, in which
     * credits are redeemed but the interest from the underlying is not collected.
     */
    function redeem(uint256 _credits) external override returns (uint256 massetReturned) {
        require(_credits > 0, "Must withdraw something");

        (, massetReturned) = _redeem(_credits, true, true);

        // Collect recent interest generated by basket and update exchange rate
        if (automateInterestCollection) {
            ISavingsManager(_savingsManager()).collectAndDistributeInterest(address(underlying));
        }
    }

    /**
     * @dev see IERC4626.redeem(uint256 shares,address receiver,address owner)
     * @notice Redeem specific number of the senders "credits" in exchange for underlying.
     *      Payout amount is calculated as a ratio of credits and exchange rate:
     *                    payout = credits * exchangeRate
     * @param _credits         Amount of credits to redeem
     * @return massetReturned  Units of underlying mAsset paid out
     */
    function redeemCredits(uint256 _credits) external override returns (uint256 massetReturned) {
        require(_credits > 0, "Must withdraw something");

        // Collect recent interest generated by basket and update exchange rate
        if (automateInterestCollection) {
            ISavingsManager(_savingsManager()).collectAndDistributeInterest(address(underlying));
        }

        (, massetReturned) = _redeem(_credits, true, true);
    }

    /**
     * @dev see IERC4626.redeem(uint256 shares,address receiver,address owner)
     * @notice Redeem credits into a specific amount of underlying.
     *      Credits needed to burn is calculated using:
     *                    credits = underlying / exchangeRate
     * @param _underlying     Amount of underlying to redeem
     * @return creditsBurned  Units of credits burned from sender
     */
    function redeemUnderlying(uint256 _underlying)
        external
        override
        returns (uint256 creditsBurned)
    {
        require(_underlying > 0, "Must withdraw something");

        // Collect recent interest generated by basket and update exchange rate
        if (automateInterestCollection) {
            ISavingsManager(_savingsManager()).collectAndDistributeInterest(address(underlying));
        }

        // Ensure that the payout was sufficient
        uint256 massetReturned;
        (creditsBurned, massetReturned) = _redeem(_underlying, false, true);
        require(massetReturned == _underlying, "Invalid output");
    }

    /**
     * @notice Redeem credits into a specific amount of underlying, unwrap
     *      into a selected output asset, and send to a beneficiary
     *      Credits needed to burn is calculated using:
     *                    credits = underlying / exchangeRate
     * @param _amount         Units to redeem (either underlying or credit amount).
     * @param _isCreditAmt    `true` if `amount` is in credits. eg imUSD. `false` if `amount` is in underlying. eg mUSD.
     * @param _minAmountOut   Minimum amount of `output` tokens to unwrap for. This is to the same decimal places as the `output` token.
     * @param _output         Asset to receive in exchange for the redeemed mAssets. This can be a bAsset or a fAsset. For example:
        - bAssets (USDC, DAI, sUSD or USDT) or fAssets (GUSD, BUSD, alUSD, FEI or RAI) for mainnet imUSD Vault.
        - bAssets (USDC, DAI or USDT) or fAsset FRAX for Polygon imUSD Vault.
        - bAssets (WBTC, sBTC or renBTC) or fAssets (HBTC or TBTCV2) for mainnet imBTC Vault.
     * @param _beneficiary    Address to send `output` tokens to.
     * @param _router         mAsset address if the output is a bAsset. Feeder Pool address if the output is a fAsset.
     * @param _isBassetOut    `true` if `output` is a bAsset. `false` if `output` is a fAsset.
     * @return creditsBurned  Units of credits burned from sender. eg imUSD or imBTC.
     * @return massetReturned Units of the underlying mAssets that were redeemed or swapped for the output tokens. eg mUSD or mBTC.
     * @return outputQuantity Units of `output` tokens sent to the beneficiary.
     */
    function redeemAndUnwrap(
        uint256 _amount,
        bool _isCreditAmt,
        uint256 _minAmountOut,
        address _output,
        address _beneficiary,
        address _router,
        bool _isBassetOut
    )
        external
        override
        returns (
            uint256 creditsBurned,
            uint256 massetReturned,
            uint256 outputQuantity
        )
    {
        require(_amount > 0, "Must withdraw something");
        require(_output != address(0), "Output address is zero");
        require(_beneficiary != address(0), "Beneficiary address is zero");
        require(_router != address(0), "Router address is zero");

        // Collect recent interest generated by basket and update exchange rate
        if (automateInterestCollection) {
            ISavingsManager(_savingsManager()).collectAndDistributeInterest(address(underlying));
        }

        // Ensure that the payout was sufficient
        (creditsBurned, massetReturned) = _redeem(_amount, _isCreditAmt, false);
        require(
            _isCreditAmt ? creditsBurned == _amount : massetReturned == _amount,
            "Invalid output"
        );

        // Approve wrapper to spend contract's underlying; just for this tx
        underlying.approve(unwrapper, massetReturned);

        // Unwrap the underlying into `output` and transfer to `beneficiary`
        outputQuantity = IUnwrapper(unwrapper).unwrapAndSend(
            _isBassetOut,
            _router,
            address(underlying),
            _output,
            massetReturned,
            _minAmountOut,
            _beneficiary
        );
    }

    /**
     * @dev Internally burn the credits and optionally send the underlying to msg.sender
     */
    function _redeem(
        uint256 _amt,
        bool _isCreditAmt,
        bool _transferUnderlying
    ) internal returns (uint256 creditsBurned, uint256 massetReturned) {
        // Centralise credit <> underlying calcs and minimise SLOAD count
        uint256 exchangeRate_;
        // If the input is a credit amt, then calculate underlying payout and cache the exchangeRate
        if (_isCreditAmt) {
            creditsBurned = _amt;
            (massetReturned, exchangeRate_) = _creditsToUnderlying(_amt);
        }
        // If the input is in underlying, then calculate credits needed to burn
        else {
            massetReturned = _amt;
            (creditsBurned, exchangeRate_) = _underlyingToCredits(_amt);
        }

        _burnTransfer(
            massetReturned,
            creditsBurned,
            msg.sender,
            msg.sender,
            exchangeRate_,
            _transferUnderlying
        );

        emit CreditsRedeemed(msg.sender, creditsBurned, massetReturned);
    }

    struct ConnectorStatus {
        // Limit is the max amount of units allowed in the connector
        uint256 limit;
        // Derived balance of the connector
        uint256 inConnector;
    }

    /**
     * @dev Derives the units of collateral held in the connector
     * @param _data         Struct containing data on balances
     * @param _exchangeRate Current system exchange rate
     * @return status       Contains max amount of assets allowed in connector
     */
    function _getConnectorStatus(CachedData memory _data, uint256 _exchangeRate)
        internal
        pure
        returns (ConnectorStatus memory)
    {
        // Total units of underlying collateralised
        uint256 totalCollat = _data.totalCredits.mulTruncate(_exchangeRate);
        // Max amount of underlying that can be held in the connector
        uint256 limit = totalCollat.mulTruncate(_data.fraction + 2e17);
        // Derives amount of underlying present in the connector
        uint256 inConnector = _data.rawBalance >= totalCollat ? 0 : totalCollat - _data.rawBalance;

        return ConnectorStatus(limit, inConnector);
    }

    /***************************************
                    YIELD - E
    ****************************************/

    /** @dev Modifier allowing only the designated poker to execute the fn */
    modifier onlyPoker() {
        require(msg.sender == poker, "Only poker can execute");
        _;
    }

    /**
     * @notice External poke function allows for the redistribution of collateral between here and the
     * current connector, setting the ratio back to the defined optimal.
     */
    function poke() external onlyPoker {
        CachedData memory cachedData = _cacheData();
        _poke(cachedData, false);
    }

    /**
     * @notice Governance action to set the address of a new poker
     * @param _newPoker     Address of the new poker
     */
    function setPoker(address _newPoker) external onlyGovernor {
        require(_newPoker != address(0) && _newPoker != poker, "Invalid poker");

        poker = _newPoker;

        emit PokerUpdated(_newPoker);
    }

    /**
     * @notice Governance action to set the percentage of assets that should be held
     * in the connector.
     * @param _fraction     Percentage of assets that should be held there (where 20% == 2e17)
     */
    function setFraction(uint256 _fraction) external onlyGovernor {
        require(_fraction <= 5e17, "Fraction must be <= 50%");

        fraction = _fraction;

        CachedData memory cachedData = _cacheData();
        _poke(cachedData, true);

        emit FractionUpdated(_fraction);
    }

    /**
     * @notice Governance action to set the address of a new connector, and move funds (if any) across.
     * @param _newConnector     Address of the new connector
     */
    function setConnector(address _newConnector) external onlyGovernor {
        // Withdraw all from previous by setting target = 0
        CachedData memory cachedData = _cacheData();
        cachedData.fraction = 0;
        _poke(cachedData, true);

        // Set new connector
        CachedData memory cachedDataNew = _cacheData();
        connector = IConnector(_newConnector);
        _poke(cachedDataNew, true);

        emit ConnectorUpdated(_newConnector);
    }

    /**
     * @notice Governance action to perform an emergency withdraw of the assets in the connector,
     * should it be the case that some or all of the liquidity is trapped in. This causes the total
     * collateral in the system to go down, causing a hard refresh.
     */
    function emergencyWithdraw(uint256 _withdrawAmount) external onlyGovernor {
        // withdraw _withdrawAmount from connection
        connector.withdraw(_withdrawAmount);

        // reset the connector
        connector = IConnector(address(0));
        emit ConnectorUpdated(address(0));

        // set fraction to 0
        fraction = 0;
        emit FractionUpdated(0);

        // check total collateralisation of credits
        CachedData memory data = _cacheData();
        // use rawBalance as the remaining liquidity in the connector is now written off
        _refreshExchangeRate(data.rawBalance, data.totalCredits, true);

        emit EmergencyUpdate();
    }

    /***************************************
                    YIELD - I
    ****************************************/

    /** @dev Internal poke function to keep the balance between connector and raw balance healthy */
    function _poke(CachedData memory _data, bool _ignoreCadence) internal {
        require(_data.totalCredits > 0, "Must have something to poke");

        // 1. Verify that poke cadence is valid, unless this is a manual action by governance
        uint256 currentTime = uint256(block.timestamp);
        uint256 timeSinceLastPoke = currentTime - lastPoke;
        require(_ignoreCadence || timeSinceLastPoke > POKE_CADENCE, "Not enough time elapsed");
        lastPoke = currentTime;

        // If there is a connector, check the balance and settle to the specified fraction %
        IConnector connector_ = connector;
        if (address(connector_) != address(0)) {
            // 2. Check and verify new connector balance
            uint256 lastBalance_ = lastBalance;
            uint256 connectorBalance = connector_.checkBalance();
            //      Always expect the collateral in the connector to increase in value
            require(connectorBalance >= lastBalance_, "Invalid yield");
            if (connectorBalance > 0) {
                //  Validate the collection by ensuring that the APY is not ridiculous
                YieldValidator.validateCollection(
                    connectorBalance,
                    connectorBalance - lastBalance_,
                    timeSinceLastPoke,
                    MAX_APY,
                    1e15
                );
            }

            // 3. Level the assets to Fraction (connector) & 100-fraction (raw)
            uint256 sum = _data.rawBalance + connectorBalance;
            uint256 ideal = sum.mulTruncate(_data.fraction);
            //     If there is not enough mAsset in the connector, then deposit
            if (ideal > connectorBalance) {
                uint256 deposit_ = ideal - connectorBalance;
                underlying.approve(address(connector_), deposit_);
                connector_.deposit(deposit_);
            }
            //     Else withdraw, if there is too much mAsset in the connector
            else if (connectorBalance > ideal) {
                // If fraction == 0, then withdraw everything
                if (ideal == 0) {
                    connector_.withdrawAll();
                    sum = IERC20(underlying).balanceOf(address(this));
                } else {
                    connector_.withdraw(connectorBalance - ideal);
                }
            }
            //     Else ideal == connectorBalance (e.g. 0), do nothing
            require(connector_.checkBalance() >= ideal, "Enforce system invariant");

            // 4i. Refresh exchange rate and emit event
            lastBalance = ideal;
            _refreshExchangeRate(sum, _data.totalCredits, false);
            emit Poked(lastBalance_, ideal, connectorBalance - lastBalance_);
        } else {
            // 4ii. Refresh exchange rate and emit event
            lastBalance = 0;
            _refreshExchangeRate(_data.rawBalance, _data.totalCredits, false);
            emit PokedRaw();
        }
    }

    /**
     * @dev Internal fn to refresh the exchange rate, based on the sum of collateral and the number of credits
     * @param _realSum          Sum of collateral held by the contract
     * @param _totalCredits     Total number of credits in the system
     * @param _ignoreValidation This is for use in the emergency situation, and ignores a decreasing exchangeRate
     */
    function _refreshExchangeRate(
        uint256 _realSum,
        uint256 _totalCredits,
        bool _ignoreValidation
    ) internal {
        // Based on the current exchange rate, how much underlying is collateralised?
        (uint256 totalCredited, ) = _creditsToUnderlying(_totalCredits);

        // Require the amount of capital held to be greater than the previously credited units
        require(_ignoreValidation || _realSum >= totalCredited, "ExchangeRate must increase");
        // Work out the new exchange rate based on the current capital
        uint256 newExchangeRate = _calcExchangeRate(_realSum, _totalCredits);
        exchangeRate = newExchangeRate;

        emit ExchangeRateUpdated(
            newExchangeRate,
            _realSum > totalCredited ? _realSum - totalCredited : 0
        );
    }

    /***************************************
                    VIEW - I
    ****************************************/

    struct CachedData {
        // SLOAD from 'fraction'
        uint256 fraction;
        // ERC20 balance of underlying, held by this contract
        // underlying.balanceOf(address(this))
        uint256 rawBalance;
        // totalSupply()
        uint256 totalCredits;
    }

    /**
     * @dev Retrieves generic data to avoid duplicate SLOADs
     */
    function _cacheData() internal view returns (CachedData memory) {
        uint256 balance = underlying.balanceOf(address(this));
        return CachedData(fraction, balance, totalSupply());
    }

    /**
     * @dev Converts masset amount into credits based on exchange rate
     *               c = (masset / exchangeRate) + 1
     */
    function _underlyingToCredits(uint256 _underlying)
        internal
        view
        returns (uint256 credits, uint256 exchangeRate_)
    {
        // e.g. (1e20 * 1e18) / 1e18 = 1e20
        // e.g. (1e20 * 1e18) / 14e17 = 7.1429e19
        // e.g. 1 * 1e18 / 1e17 + 1 = 11 => 11 * 1e17 / 1e18 = 1.1e18 / 1e18 = 1
        exchangeRate_ = exchangeRate;
        credits = _underlying.divPrecisely(exchangeRate_) + 1;
    }

    /**
     * @dev Works out a new exchange rate, given an amount of collateral and total credits
     *               e = underlying / (credits-1)
     */
    function _calcExchangeRate(uint256 _totalCollateral, uint256 _totalCredits)
        internal
        pure
        returns (uint256 _exchangeRate)
    {
        _exchangeRate = _totalCollateral.divPrecisely(_totalCredits - 1);
    }

    /**
     * @dev Converts credit amount into masset based on exchange rate
     *               m = credits * exchangeRate
     */
    function _creditsToUnderlying(uint256 _credits)
        internal
        view
        returns (uint256 underlyingAmount, uint256 exchangeRate_)
    {
        // e.g. (1e20 * 1e18) / 1e18 = 1e20
        // e.g. (1e20 * 14e17) / 1e18 = 1.4e20
        exchangeRate_ = exchangeRate;
        underlyingAmount = _credits.mulTruncate(exchangeRate_);
    }

    /*///////////////////////////////////////////////////////////////
                                IERC4626Vault
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice it must be an ERC-20 token contract. Must not revert.
     *
     * @return assetTokenAddress the address of the underlying asset token. eg mUSD or mBTC
     */
    function asset() external view override returns (address assetTokenAddress) {
        assetTokenAddress = address(underlying);
    }

    /**
     * @return totalManagedAssets the total amount of the underlying asset tokens that is “managed” by Vault.
     */
    function totalAssets() external view override returns (uint256 totalManagedAssets) {
        totalManagedAssets = underlying.balanceOf(address(this));
    }

    /**
     * @notice The amount of shares that the Vault would exchange for the amount of assets provided, in an ideal scenario where all the conditions are met.
     * @param assets The amount of underlying assets to be convert to vault shares.
     * @return shares The amount of vault shares converted from the underlying assets.
     */
    function convertToShares(uint256 assets) external view override returns (uint256 shares) {
        (shares, ) = _underlyingToCredits(assets);
    }

    /**
     * @notice The amount of assets that the Vault would exchange for the amount of shares provided, in an ideal scenario where all the conditions are met.
     * @param shares The amount of vault shares to be converted to the underlying assets.
     * @return assets The amount of underlying assets converted from the vault shares.
     */
    function convertToAssets(uint256 shares) external view override returns (uint256 assets) {
        (assets, ) = _creditsToUnderlying(shares);
    }

    /**
     * @notice The maximum number of underlying assets that caller can deposit.
     * caller Account that the assets will be transferred from.
     * @return maxAssets The maximum amount of underlying assets the caller can deposit.
     */
    function maxDeposit(
        address /** caller **/
    ) external pure override returns (uint256 maxAssets) {
        maxAssets = type(uint256).max;
    }

    /**
     * @notice Allows an on-chain or off-chain user to simulate the effects of their deposit at the current block, given current on-chain conditions.
     * @param assets The amount of underlying assets to be transferred.
     * @return shares The amount of vault shares that will be minted.
     */
    function previewDeposit(uint256 assets) external view override returns (uint256 shares) {
        require(assets > 0, "Must deposit something");
        (shares, ) = _underlyingToCredits(assets);
    }

    /**
     * @notice Mint vault shares to receiver by transferring exact amount of underlying asset tokens from the caller.
     *      Credit amount is calculated as a ratio of deposit amount and exchange rate:
     *                    credits = underlying / exchangeRate
     *      We will first update the internal exchange rate by collecting any interest generated on the underlying.
     * Emits a {Deposit} event.
     * @param assets      Units of underlying to deposit into savings vault. eg mUSD or mBTC
     * @param receiver    The address to receive the Vault shares.
     * @return shares     Units of credits issued. eg imUSD or imBTC
     */
    function deposit(uint256 assets, address receiver) external override returns (uint256 shares) {
        shares = _transferAndMint(assets, receiver, true);
    }

    /**
     *
     * @notice Overloaded `deposit` method with an optional referrer address.
     * @param assets    Units of underlying to deposit into savings vault. eg mUSD or mBTC
     * @param receiver  Address to the new credits will be issued to.
     * @param referrer  Referrer address for this deposit.
     * @return shares   Units of credits issued. eg imUSD or imBTC
     */
    function deposit(
        uint256 assets,
        address receiver,
        address referrer
    ) external override returns (uint256 shares) {
        shares = _transferAndMint(assets, receiver, true);
        emit Referral(referrer, receiver, assets);
    }

    /**
     * @notice The maximum number of vault shares that caller can mint.
     * caller Account that the underlying assets will be transferred from.
     * @return maxShares The maximum amount of vault shares the caller can mint.
     */
    function maxMint(
        address /* caller */
    ) external pure override returns (uint256 maxShares) {
        maxShares = type(uint256).max;
    }

    /**
     * @notice Allows an on-chain or off-chain user to simulate the effects of their mint at the current block, given current on-chain conditions.
     * @param shares The amount of vault shares to be minted.
     * @return assets The amount of underlying assests that will be transferred from the caller.
     */
    function previewMint(uint256 shares) external view override returns (uint256 assets) {
        (assets, ) = _creditsToUnderlying(shares);
    }

    /**
     * @notice Mint exact amount of vault shares to the receiver by transferring enough underlying asset tokens from the caller.
     * Emits a {Deposit} event.
     *
     * @param shares The amount of vault shares to be minted.
     * @param receiver The account the vault shares will be minted to.
     * @return assets The amount of underlying assets that were transferred from the caller.
     */
    function mint(uint256 shares, address receiver) external override returns (uint256 assets) {
        (assets, ) = _creditsToUnderlying(shares);
        _transferAndMint(assets, receiver, true);
    }

    /**
     * @notice Mint exact amount of vault shares to the receiver by transferring enough underlying asset tokens from the caller.
     * @param shares The amount of vault shares to be minted.
     * @param receiver The account the vault shares will be minted to.
     * @param referrer  Referrer address for this deposit.
     * @return assets The amount of underlying assets that were transferred from the caller.
     * Emits a {Deposit}, {Referral} events
     */
    function mint(
        uint256 shares,
        address receiver,
        address referrer
    ) external override returns (uint256 assets) {
        (assets, ) = _creditsToUnderlying(shares);
        _transferAndMint(assets, receiver, true);
        emit Referral(referrer, receiver, assets);
    }

    /**
     * @notice The maximum number of underlying assets that owner can withdraw.
     * @param owner Address that owns the underlying assets.
     * @return maxAssets The maximum amount of underlying assets the owner can withdraw.
     */
    function maxWithdraw(address owner) external view override returns (uint256 maxAssets) {
        (maxAssets, ) = _creditsToUnderlying(balanceOf(owner));
    }

    /**
     * @notice Allows an on-chain or off-chain user to simulate the effects of their withdrawal at the current block, given current on-chain conditions.
     * @param assets The amount of underlying assets to be withdrawn.
     * @return shares The amount of vault shares that will be burnt.
     */
    function previewWithdraw(uint256 assets) external view override returns (uint256 shares) {
        (shares, ) = _underlyingToCredits(assets);
    }

    /**
     * @notice Burns enough vault shares from owner and transfers the exact amount of underlying asset tokens to the receiver.
     * Emits a {Withdraw} event.
     *
     * @param assets The amount of underlying assets to be withdrawn from the vault.
     * @param receiver The account that the underlying assets will be transferred to.
     * @param owner Account that owns the vault shares to be burnt.
     * @return shares The amount of vault shares that were burnt.
     */
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) external override returns (uint256 shares) {
        require(assets > 0, "Must withdraw something");
        uint256 _exchangeRate;
        if (automateInterestCollection) {
            ISavingsManager(_savingsManager()).collectAndDistributeInterest(address(underlying));
        }
        (shares, _exchangeRate) = _underlyingToCredits(assets);

        _burnTransfer(assets, shares, receiver, owner, _exchangeRate, true);
    }

    /**
     * @notice it must return a limited value if owner is subject to some withdrawal limit or timelock. must return balanceOf(owner) if owner is not subject to any withdrawal limit or timelock. MAY be used in the previewRedeem or redeem methods for shares input parameter. must NOT revert.
     *
     * @param owner Address that owns the shares.
     * @return maxShares Total number of shares that owner can redeem.
     */
    function maxRedeem(address owner) external view override returns (uint256 maxShares) {
        maxShares = balanceOf(owner);
    }

    /**
     * @notice Allows an on-chain or off-chain user to simulate the effects of their redeemption at the current block, given current on-chain conditions.
     *
     * @return assets the exact amount of underlying assets that would be withdrawn by the caller if redeeming a given exact amount of Vault shares using the redeem method
     */
    function previewRedeem(uint256 shares) external view override returns (uint256 assets) {
        (assets, ) = _creditsToUnderlying(shares);
    }

    /**
     * @notice Burns exact amount of vault shares from owner and transfers the underlying asset tokens to the receiver.
     * Emits a {Withdraw} event.
     *
     * @param shares The amount of vault shares to be burnt.
     * @param receiver The account the underlying assets will be transferred to.
     * @param owner The account that owns the vault shares to be burnt.
     * @return assets The amount of underlying assets that were transferred to the receiver.
     */
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) external override returns (uint256 assets) {
        require(shares > 0, "Must withdraw something");
        uint256 _exchangeRate;
        if (automateInterestCollection) {
            ISavingsManager(_savingsManager()).collectAndDistributeInterest(address(underlying));
        }
        (assets, _exchangeRate) = _creditsToUnderlying(shares);

        _burnTransfer(assets, shares, receiver, owner, _exchangeRate, true); //transferAssets=true
    }

    /*///////////////////////////////////////////////////////////////
                        INTERNAL DEPOSIT/MINT
    //////////////////////////////////////////////////////////////*/
    function _transferAndMint(
        uint256 assets,
        address receiver,
        bool _collectInterest
    ) internal returns (uint256 shares) {
        require(assets > 0, "Must deposit something");
        require(receiver != address(0), "Invalid beneficiary address");

        // Collect recent interest generated by basket and update exchange rate
        IERC20 mAsset = underlying;
        if (_collectInterest) {
            ISavingsManager(_savingsManager()).collectAndDistributeInterest(address(mAsset));
        }

        // Transfer tokens from sender to here
        require(mAsset.transferFrom(msg.sender, address(this), assets), "Must receive tokens");

        // Calc how many credits they receive based on currentRatio
        (shares, ) = _underlyingToCredits(assets);

        // add credits to ERC20 balances
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        emit SavingsDeposited(receiver, assets, shares);
    }

    /*///////////////////////////////////////////////////////////////
                        INTERNAL WITHDRAW/REDEEM
    //////////////////////////////////////////////////////////////*/

    function _burnTransfer(
        uint256 assets,
        uint256 shares,
        address receiver,
        address owner,
        uint256 _exchangeRate,
        bool transferAssets
    ) internal {
        require(receiver != address(0), "Invalid beneficiary address");

        // If caller is not the owner of the shares
        uint256 allowed = allowance(owner, msg.sender);
        if (msg.sender != owner && allowed != type(uint256).max) {
            require(shares <= allowed, "Amount exceeds allowance");
            _approve(owner, msg.sender, allowed - shares);
        }

        // Burn required shares from the owner FIRST
        _burn(owner, shares);

        // Optionally, transfer tokens from here to receiver
        if (transferAssets) {
            require(underlying.transfer(receiver, assets), "Must send tokens");
            emit Withdraw(msg.sender, receiver, owner, assets, shares);
        }
        // If this withdrawal pushes the portion of stored collateral in the `connector` over a certain
        // threshold (fraction + 20%), then this should trigger a _poke on the connector. This is to avoid
        // a situation in which there is a rush on withdrawals for some reason, causing the connector
        // balance to go up and thus having too large an exposure.
        CachedData memory cachedData = _cacheData();
        ConnectorStatus memory status = _getConnectorStatus(cachedData, _exchangeRate);
        if (status.inConnector > status.limit) {
            _poke(cachedData, false);
        }
    }
}
