import { ethers } from "hardhat"
import { FassetMachine } from "@utils/machines"
import { MockGovernable__factory } from "types/generated"
import { shouldBehaveLikeGovernable, IGovernableBehaviourContext } from "./Governable.behaviour"

describe("Governable", () => {
    const ctx: Partial<IGovernableBehaviourContext> = {}

    beforeEach("Create Contract", async () => {
        const accounts = await ethers.getSigners()
        const fAssetMachine = await new FassetMachine().initAccounts(accounts)
        ctx.governable = await new MockGovernable__factory(fAssetMachine.sa.governor.signer).deploy()
        ctx.owner = fAssetMachine.sa.governor
        ctx.other = fAssetMachine.sa.other
    })

    shouldBehaveLikeGovernable(ctx as Required<typeof ctx>)
})
