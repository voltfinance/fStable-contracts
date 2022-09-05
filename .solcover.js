module.exports = {
    skipFiles: [
        "interfaces",
        "integrations",
        "z_mocks",
        "shared/InitializableReentrancyGuard.sol",
        "integrations",
        "fasset/peripheral",
        "fasset/versions",
        "fasset/liquidator/Unliquidator.sol",
        "peripheral",
        "savings/peripheral",
        "upgradability",
        "legacy",
        "legacy-upgraded",
    ],
    mocha: {
        grep: "@skip-on-coverage", // Find everything with this tag
        invert: true, // Run the grep's inverse set.
    },
}
