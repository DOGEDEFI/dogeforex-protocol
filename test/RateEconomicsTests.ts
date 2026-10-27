import { expect } from "chai";
import { ethers } from "hardhat";
import { bootstrapV2, deployInitializedV2Core, LOCAL_100, mintAndBridge } from "./helper/v2";
import { evm_increaseTime } from "./helper";
import { loadInstances } from "../scripts/deployment/instanceConfig";

for (const code of ["JPY", "GBP", "BRL"]) {
  describe(`${code} initial-rate economics`, () => {
    it("uses the configured rate for savings interest and long-tenor position fees", async () => {
      const instance = loadInstances().find((candidate) => candidate.code === code);
      if (!instance) throw new Error(`Missing ${code} configuration`);
      const rate = BigInt(instance.leadratePPM);
      const core = await deployInitializedV2Core(instance.leadratePPM);
      await bootstrapV2(core);
      await mintAndBridge(core, core.owner, 10_000n * 10n ** 6n);

      const principal = ethers.parseEther("1000");
      await core.savings["save(uint192)"](principal);
      const beforeRefresh = await core.savings.savings(core.owner.address);
      await evm_increaseTime(4 * 86400);
      const refreshReceipt = await (await core.savings.refreshMyBalance()).wait();
      const refreshBlock = await ethers.provider.getBlock(refreshReceipt!.blockNumber);
      const refreshTicks = await core.savings.ticks(BigInt(refreshBlock!.timestamp));
      const interest = ((refreshTicks - beforeRefresh.ticks) * principal) / 1_000_000n / (365n * 86400n);
      expect(interest).to.be.greaterThan(0);
      expect(interest).to.be.lessThan(LOCAL_100);
      expect((await core.savings.savings(core.owner.address)).saved).to.equal(principal + interest);
      expect(await core.token.equity()).to.equal(LOCAL_100 - interest);

      const collateral = await (await ethers.getContractFactory("TestToken")).deploy(
        `${code} Collateral`,
        `${code}COL`,
        18
      );
      await collateral.approve(await core.hub.getAddress(), ethers.MaxUint256);
      const args = [
        await collateral.getAddress(),
        ethers.parseEther("4000"),
        ethers.parseEther("4000"),
        ethers.parseEther("10000"),
        3n * 86400n,
        365n * 86400n,
        86400n,
        0,
        ethers.parseEther("1"),
        200000,
      ] as const;
      const address = await core.hub.openPosition.staticCall(...args);
      await core.hub.openPosition(...args);
      const position = await ethers.getContractAt("Position", address);
      expect(await position.annualInterestPPM()).to.equal(rate);
      await evm_increaseTime(3 * 86400);

      const mintAmount = ethers.parseEther("100");
      const beforeMint = await core.token.balanceOf(core.owner.address);
      const mintReceipt = await (await position.mint(core.owner.address, mintAmount)).wait();
      const mintBlock = await ethers.provider.getBlock(mintReceipt!.blockNumber);
      const expiration = await position.expiration();
      const appliedFee = ((expiration - BigInt(mintBlock!.timestamp)) * rate) / (365n * 86400n);
      expect(appliedFee).to.be.greaterThan(0);
      expect(appliedFee).to.be.lessThan(rate);
      expect(await position.calculateCurrentFee()).to.equal(appliedFee);
      expect(await position.minted()).to.equal(mintAmount);
      expect(await core.token.minterReserve()).to.equal(ethers.parseEther("20"));
      expect((await core.token.balanceOf(core.owner.address)) - beforeMint).to.equal(
        (mintAmount * (1_000_000n - 200_000n - appliedFee)) / 1_000_000n
      );
    });
  });
}
