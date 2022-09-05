// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

// External
import { IFasset } from "../interfaces/IFasset.sol";
import { ISavingsContractV2 } from "../interfaces/ISavingsContract.sol";

// Internal
import { IRevenueRecipient } from "../interfaces/IRevenueRecipient.sol";
import { ISavingsManager } from "../interfaces/ISavingsManager.sol";
import { PausableModule } from "../shared/PausableModule.sol";

// Libs
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { StableMath } from "../shared/StableMath.sol";
import { YieldValidator } from "../shared/YieldValidator.sol";

/**
 * @title   SavingsManager
 * @author  mStable
 * @notice  Savings Manager collects interest from fAssets and sends them to the
 *          corresponding Savings Contract, performing some validation in the process.
 * @dev     VERSION: 1.4
 *          DATE:    2021-10-15
 */
contract SavingsManager is ISavingsManager, PausableModule {
    using StableMath for uint256;
    using SafeERC20 for IERC20;

    // Core admin events
    event RevenueRecipientSet(address indexed fAsset, address recipient);
    event SavingsContractAdded(address indexed fAsset, address savingsContract);
    event SavingsContractUpdated(address indexed fAsset, address savingsContract);
    event SavingsRateChanged(uint256 newSavingsRate);
    event StreamsFrozen();
    // Interest collection
    event LiquidatorDeposited(address indexed fAsset, uint256 amount);
    event InterestCollected(
        address indexed fAsset,
        uint256 interest,
        uint256 newTotalSupply,
        uint256 apy
    );
    event InterestDistributed(address indexed fAsset, uint256 amountSent);
    event RevenueRedistributed(address indexed fAsset, address recipient, uint256 amount);

    // Locations of each fAsset savings contract
    mapping(address => ISavingsContractV2) public savingsContracts;
    mapping(address => IRevenueRecipient) public revenueRecipients;
    // Time at which last collection was made
    mapping(address => uint256) public lastPeriodStart;
    mapping(address => uint256) public lastCollection;
    mapping(address => uint256) public periodYield;

    // Amount of collected interest that will be sent to Savings Contract (1e18 = 100%)
    uint256 private savingsRate;
    // Streaming liquidated tokens
    uint256 private immutable DURATION; // measure in days. eg 1 days or 7 days
    uint256 private constant ONE_DAY = 1 days;
    uint256 private constant THIRTY_MINUTES = 30 minutes;
    // Streams
    bool private streamsFrozen = false;
    // Liquidator
    mapping(address => Stream) public liqStream;
    // Platform
    mapping(address => Stream) public yieldStream;
    // Batches are for the platformInterest collection
    mapping(address => uint256) public override lastBatchCollected;

    enum StreamType {
        liquidator,
        yield
    }

    struct Stream {
        uint256 end;
        uint256 rate;
    }

    constructor(
        address _nexus,
        address[] memory _fAssets,
        address[] memory _savingsContracts,
        address[] memory _revenueRecipients,
        uint256 _savingsRate,
        uint256 _duration
    ) PausableModule(_nexus) {
        uint256 len = _fAssets.length;
        require(
            _savingsContracts.length == len && _revenueRecipients.length == len,
            "Invalid inputs"
        );
        for (uint256 i = 0; i < len; i++) {
            _updateSavingsContract(_fAssets[i], _savingsContracts[i]);
            emit SavingsContractAdded(_fAssets[i], _savingsContracts[i]);

            revenueRecipients[_fAssets[i]] = IRevenueRecipient(_revenueRecipients[i]);
            emit RevenueRecipientSet(_fAssets[i], _revenueRecipients[i]);
        }
        savingsRate = _savingsRate;
        DURATION = _duration;
    }

    modifier onlyLiquidator() {
        require(msg.sender == _liquidator(), "Only liquidator can execute");
        _;
    }

    modifier whenStreamsNotFrozen() {
        require(!streamsFrozen, "Streaming is currently frozen");
        _;
    }

    /***************************************
                    STATE
    ****************************************/

    /**
     * @dev Adds a new savings contract
     * @param _fAsset           Address of underlying fAsset
     * @param _savingsContract  Address of the savings contract
     */
    function addSavingsContract(address _fAsset, address _savingsContract) external onlyGovernor {
        require(
            address(savingsContracts[_fAsset]) == address(0),
            "Savings contract already exists"
        );
        _updateSavingsContract(_fAsset, _savingsContract);
        emit SavingsContractAdded(_fAsset, _savingsContract);
    }

    /**
     * @dev Updates an existing savings contract
     * @param _fAsset           Address of underlying fAsset
     * @param _savingsContract  Address of the savings contract
     */
    function updateSavingsContract(address _fAsset, address _savingsContract)
        external
        onlyGovernor
    {
        require(
            address(savingsContracts[_fAsset]) != address(0),
            "Savings contract does not exist"
        );
        _updateSavingsContract(_fAsset, _savingsContract);
        emit SavingsContractUpdated(_fAsset, _savingsContract);
    }

    function _updateSavingsContract(address _fAsset, address _savingsContract) internal {
        require(_fAsset != address(0) && _savingsContract != address(0), "Must be valid address");
        savingsContracts[_fAsset] = ISavingsContractV2(_savingsContract);

        IERC20(_fAsset).safeApprove(address(_savingsContract), 0);
        IERC20(_fAsset).safeApprove(address(_savingsContract), type(uint256).max);
    }

    /**
     * @dev Freezes streaming of fAssets
     */
    function freezeStreams() external onlyGovernor whenStreamsNotFrozen {
        streamsFrozen = true;

        emit StreamsFrozen();
    }

    /**
     * @dev Sets the revenue recipient address
     * @param _fAsset           Address of underlying fAsset
     * @param _recipient        Address of the recipient
     */
    function setRevenueRecipient(address _fAsset, address _recipient) external onlyGovernor {
        revenueRecipients[_fAsset] = IRevenueRecipient(_recipient);

        emit RevenueRecipientSet(_fAsset, _recipient);
    }

    /**
     * @dev Sets a new savings rate for interest distribution
     * @param _savingsRate   Rate of savings sent to SavingsContract (100% = 1e18)
     */
    function setSavingsRate(uint256 _savingsRate) external onlyGovernor {
        // Greater than 25% up to 100%
        require(_savingsRate >= 25e16 && _savingsRate <= 1e18, "Must be a valid rate");
        savingsRate = _savingsRate;
        emit SavingsRateChanged(_savingsRate);
    }

    /**
     * @dev Allows the liquidator to deposit proceeds from liquidated gov tokens.
     * Transfers proceeds on a second by second basis to the Savings Contract over 1 week.
     * @param _fAsset The fAsset to transfer and distribute
     * @param _liquidated Units of fAsset to distribute
     */
    function depositLiquidation(address _fAsset, uint256 _liquidated)
        external
        override
        whenNotPaused
        onlyLiquidator
        whenStreamsNotFrozen
    {
        // Collect existing interest to ensure everything is up to date
        _collectAndDistributeInterest(_fAsset);

        // transfer liquidated fUSD to here
        IERC20(_fAsset).safeTransferFrom(_liquidator(), address(this), _liquidated);

        uint256 leftover = _unstreamedRewards(_fAsset, StreamType.liquidator);
        _initialiseStream(_fAsset, StreamType.liquidator, _liquidated + leftover, DURATION);

        emit LiquidatorDeposited(_fAsset, _liquidated);
    }

    /**
     * @dev Collects the platform interest from a given fAsset and then adds capital to the
     * stream. If there is > 24h left in current stream, just top it up, otherwise reset.
     * @param _fAsset The fAsset to fetch interest
     */
    function collectAndStreamInterest(address _fAsset)
        external
        override
        whenNotPaused
        whenStreamsNotFrozen
    {
        // Collect existing interest to ensure everything is up to date
        _collectAndDistributeInterest(_fAsset);

        uint256 currentTime = block.timestamp;
        uint256 previousBatch = lastBatchCollected[_fAsset];
        uint256 timeSincePreviousBatch = currentTime - previousBatch;
        require(timeSincePreviousBatch > 6 hours, "Cannot deposit twice in 6 hours");
        lastBatchCollected[_fAsset] = currentTime;

        // Batch collect
        (uint256 interestCollected, uint256 totalSupply) = IFasset(_fAsset)
        .collectPlatformInterest();

        if (interestCollected > 0) {
            // Validate APY
            uint256 apy = YieldValidator.validateCollection(
                totalSupply,
                interestCollected,
                timeSincePreviousBatch
            );

            // Get remaining rewards
            uint256 leftover = _unstreamedRewards(_fAsset, StreamType.yield);
            _initialiseStream(_fAsset, StreamType.yield, interestCollected + leftover, ONE_DAY);

            emit InterestCollected(_fAsset, interestCollected, totalSupply, apy);
        } else {
            emit InterestCollected(_fAsset, interestCollected, totalSupply, 0);
        }
    }

    /**
     * @dev Calculates how many rewards from the stream are still to be distributed, from the
     * last collection time to the end of the stream.
     * @param _fAsset The fAsset in question
     * @return leftover The total amount of fAsset that is yet to be collected from a stream
     */
    function _unstreamedRewards(address _fAsset, StreamType _stream)
        internal
        view
        returns (uint256 leftover)
    {
        uint256 lastUpdate = lastCollection[_fAsset];

        Stream memory stream = _stream == StreamType.liquidator
            ? liqStream[_fAsset]
            : yieldStream[_fAsset];
        uint256 unclaimedSeconds = 0;
        if (lastUpdate < stream.end) {
            unclaimedSeconds = stream.end - lastUpdate;
        }
        return unclaimedSeconds * stream.rate;
    }

    /**
     * @dev Simply sets up the stream
     * @param _fAsset The fAsset in question
     * @param _amount Amount of units to stream
     * @param _duration Duration of the stream, from now
     */
    function _initialiseStream(
        address _fAsset,
        StreamType _stream,
        uint256 _amount,
        uint256 _duration
    ) internal {
        uint256 currentTime = block.timestamp;
        // Distribute reward per second over X seconds
        uint256 rate = _amount / _duration;
        uint256 end = currentTime + _duration;
        if (_stream == StreamType.liquidator) {
            liqStream[_fAsset] = Stream(end, rate);
        } else {
            yieldStream[_fAsset] = Stream(end, rate);
        }

        // Reset pool data to enable lastCollection usage twice
        require(lastCollection[_fAsset] == currentTime, "Stream data must be up to date");
    }

    /***************************************
                COLLECTION
    ****************************************/

    /**
     * @dev Collects interest from a target fAsset and distributes to the SavingsContract.
     *      Applies constraints such that the max APY since the last fee collection cannot
     *      exceed the "MAX_APY" variable.
     * @param _fAsset       fAsset for which the interest should be collected
     */
    function collectAndDistributeInterest(address _fAsset) external override whenNotPaused {
        _collectAndDistributeInterest(_fAsset);
    }

    function _collectAndDistributeInterest(address _fAsset) internal {
        ISavingsContractV2 savingsContract = savingsContracts[_fAsset];
        require(address(savingsContract) != address(0), "Must have a valid savings contract");

        // Get collection details
        uint256 recentPeriodStart = lastPeriodStart[_fAsset];
        uint256 previousCollection = lastCollection[_fAsset];
        lastCollection[_fAsset] = block.timestamp;

        // 1. Collect the new interest from the fAsset
        IFasset fAsset = IFasset(_fAsset);
        (uint256 interestCollected, uint256 totalSupply) = fAsset.collectInterest();

        // 2. Update all the time stamps
        //    Avoid division by 0 by adding a minimum elapsed time of 1 second
        uint256 timeSincePeriodStart = StableMath.max(1, block.timestamp - recentPeriodStart);
        uint256 timeSinceLastCollection = StableMath.max(1, block.timestamp - previousCollection);

        uint256 inflationOperand = interestCollected;
        //    If it has been 30 mins since last collection, reset period data
        if (timeSinceLastCollection > THIRTY_MINUTES) {
            lastPeriodStart[_fAsset] = block.timestamp;
            periodYield[_fAsset] = 0;
        }
        //    Else if period has elapsed, start a new period from the lastCollection time
        else if (timeSincePeriodStart > THIRTY_MINUTES) {
            lastPeriodStart[_fAsset] = previousCollection;
            periodYield[_fAsset] = interestCollected;
        }
        //    Else add yield to period yield
        else {
            inflationOperand = periodYield[_fAsset] + interestCollected;
            periodYield[_fAsset] = inflationOperand;
        }

        //    Add on liquidated
        uint256 newReward = _unclaimedRewards(_fAsset, previousCollection);
        // 3. Validate that interest is collected correctly and does not exceed max APY
        if (interestCollected > 0 || newReward > 0) {
            require(
                IERC20(_fAsset).balanceOf(address(this)) >= interestCollected + newReward,
                "Must receive fUSD"
            );

            uint256 extrapolatedAPY = YieldValidator.validateCollection(
                totalSupply,
                inflationOperand,
                timeSinceLastCollection
            );

            emit InterestCollected(_fAsset, interestCollected, totalSupply, extrapolatedAPY);

            // 4. Distribute the interest
            //    Calculate the share for savers (95e16 or 95%)
            uint256 saversShare = (interestCollected + newReward).mulTruncate(savingsRate);

            //    Call depositInterest on contract
            savingsContract.depositInterest(saversShare);

            emit InterestDistributed(_fAsset, saversShare);
        } else {
            emit InterestCollected(_fAsset, 0, totalSupply, 0);
        }
    }

    /**
     * @dev Calculates unclaimed rewards from the liquidation stream
     * @param _fAsset fAsset key
     * @param _previousCollection Time of previous collection
     * @return Units of fAsset that have been unlocked for distribution
     */
    function _unclaimedRewards(address _fAsset, uint256 _previousCollection)
        internal
        view
        returns (uint256)
    {
        Stream memory liq = liqStream[_fAsset];
        uint256 unclaimedSeconds_liq = _unclaimedSeconds(_previousCollection, liq.end);
        uint256 subtotal_liq = unclaimedSeconds_liq * liq.rate;

        Stream memory yield = yieldStream[_fAsset];
        uint256 unclaimedSeconds_yield = _unclaimedSeconds(_previousCollection, yield.end);
        uint256 subtotal_yield = unclaimedSeconds_yield * yield.rate;

        return subtotal_liq + subtotal_yield;
    }

    /**
     * @dev Calculates the seconds of unclaimed rewards, based on period length
     * @param _lastUpdate Time of last update
     * @param _end End time of period
     * @return Seconds of stream that should be compensated
     */
    function _unclaimedSeconds(uint256 _lastUpdate, uint256 _end) internal view returns (uint256) {
        uint256 currentTime = block.timestamp;
        uint256 unclaimedSeconds = 0;

        if (currentTime <= _end) {
            unclaimedSeconds = currentTime - _lastUpdate;
        } else if (_lastUpdate < _end) {
            unclaimedSeconds = _end - _lastUpdate;
        }
        return unclaimedSeconds;
    }

    /***************************************
            Revenue Redistribution
    ****************************************/

    /**
     * @dev Redistributes the unallocated interest to the saved recipient, allowing
     * the siphoned assets to be used elsewhere in the system
     * @param _fAsset  fAsset to collect
     */
    function distributeUnallocatedInterest(address _fAsset) external override {
        IRevenueRecipient recipient = revenueRecipients[_fAsset];
        require(address(recipient) != address(0), "Must have valid recipient");

        IERC20 fAsset = IERC20(_fAsset);
        uint256 balance = fAsset.balanceOf(address(this));
        uint256 leftover_liq = _unstreamedRewards(_fAsset, StreamType.liquidator);
        uint256 leftover_yield = _unstreamedRewards(_fAsset, StreamType.yield);

        uint256 unallocated = balance - leftover_liq - leftover_yield;

        fAsset.approve(address(recipient), unallocated);
        recipient.notifyRedistributionAmount(_fAsset, unallocated);

        emit RevenueRedistributed(_fAsset, address(recipient), unallocated);
    }
}
