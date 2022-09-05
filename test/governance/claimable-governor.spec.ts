import { ethers } from "hardhat"
import { expect } from "chai"

import { FassetMachine } from "@utils/machines"
import { ClaimableGovernor__factory } from "types/generated"
import { shouldBehaveLikeClaimable, IClaimableGovernableBehaviourContext } from "./ClaimableGovernor.behaviour"

describe("ClaimableGovernable", () => {
    const ctx: Partial<IClaimableGovernableBehaviourContext> = {}

    beforeEach("Create Contract", async () => {
        const accounts = await ethers.getSigners()
        const fAssetMachine = await new FassetMachine().initAccounts(accounts)
        ctx.default = fAssetMachine.sa.default
        ctx.governor = fAssetMachine.sa.governor
        ctx.other = fAssetMachine.sa.other
        ctx.claimable = await new ClaimableGovernor__factory(fAssetMachine.sa.governor.signer).deploy(fAssetMachine.sa.governor.address)
    })

    shouldBehaveLikeClaimable(ctx as Required<typeof ctx>)

    describe("after initiating a transfer", () => {
        let newOwner

        beforeEach(async () => {
            const accounts = await ethers.getSigners()
            const fAssetMachine = await new FassetMachine().initAccounts(accounts)
            newOwner = fAssetMachine.sa.other
            await ctx.claimable.connect(fAssetMachine.sa.governor.signer).requestGovernorChange(newOwner.address)
        })

        it("changes allow pending owner to claim ownership", async () => {
            await ctx.claimable.connect(newOwner.signer).claimGovernorChange()
            const owner = await ctx.claimable.governor()

            expect(owner === newOwner.address).to.equal(true)
        })
    })
})
