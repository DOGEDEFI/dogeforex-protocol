import { expect } from "chai";
import { ethers } from "hardhat";
import { deployInitializedV2Core, deployV2Core, LOCAL_100, mintAndBridge, SOURCE_100 } from "./helper/v2";
import { evm_increaseTime } from "./helper";

describe("V2 source stablecoin bridge", () => {
  let core: Awaited<ReturnType<typeof deployV2Core>>;

  beforeEach(async () => {
    core = await deployInitializedV2Core();
  });

  it("rounds burns to whole six-decimal source units without burning the residual", async () => {
    await mintAndBridge(core, core.owner, 1_000_000n);
    expect(await core.token.balanceOf(core.owner.address)).to.equal(ethers.parseEther("1"));

    await core.bridge.burn(1);
    expect(await core.token.balanceOf(core.owner.address)).to.equal(ethers.parseEther("1"));
    expect(await core.bridge.minted()).to.equal(ethers.parseEther("1"));
    expect(await core.source.balanceOf(core.owner.address)).to.equal(0);

    await core.bridge.burn(1_500_000_000_000n);
    expect(await core.source.balanceOf(core.owner.address)).to.equal(1);
    expect(await core.bridge.minted()).to.equal(ethers.parseEther("1") - 1_000_000_000_000n);
    expect(await core.token.balanceOf(core.owner.address)).to.equal(
      ethers.parseEther("1") - 1_000_000_000_000n
    );

    await core.bridge.burn(ethers.parseEther("1") - 1_000_000_000_000n);
    expect(await core.source.balanceOf(core.owner.address)).to.equal(1_000_000);
    expect(await core.bridge.minted()).to.equal(0);
    expect(await core.token.totalSupply()).to.equal(0);
  });

  it("normalizes zero-, six-, eight-, and 18-decimal sources and rejects more than 18", async () => {
    for (const decimals of [0, 6, 8, 18]) {
      const token = await (await ethers.getContractFactory("OracleFreeDollar")).deploy(
        10 * 86400,
        "IMF Test Currency",
        "K9TST"
      );
      const source = await (await ethers.getContractFactory("TestToken")).deploy(
        "Source",
        "SRC",
        decimals
      );
      const bridge = await (await ethers.getContractFactory("StablecoinBridge")).deploy(
        await source.getAddress(),
        await token.getAddress(),
        ethers.parseEther("1000")
      );
      await token.initialize(await bridge.getAddress(), "bridge");
      const amount = 10n ** BigInt(decimals);
      await source.approve(await bridge.getAddress(), amount);
      await bridge.mint(amount);
      expect(await bridge.decimalMultiplier()).to.equal(10n ** BigInt(18 - decimals));
      expect(await token.balanceOf(core.owner.address)).to.equal(ethers.parseEther("1"));
      expect(await bridge.minted()).to.equal(ethers.parseEther("1"));
    }

    const token = await (await ethers.getContractFactory("OracleFreeDollar")).deploy(
      10 * 86400,
      "IMF Test Currency",
      "K9TST"
    );
    const source = await (await ethers.getContractFactory("TestToken")).deploy("Source", "SRC", 19);
    await expect(
      (await ethers.getContractFactory("StablecoinBridge")).deploy(
        await source.getAddress(),
        await token.getAddress(),
        ethers.parseEther("1000")
      )
    ).to.be.revertedWithPanic(0x11);
  });

  it("enforces its cap in local units and permits redemption after minting expires", async () => {
    const token = await (await ethers.getContractFactory("OracleFreeDollar")).deploy(
      10 * 86400,
      "IMF Test Currency",
      "K9TST"
    );
    const source = await (await ethers.getContractFactory("TestUSDC")).deploy();
    const bridge = await (await ethers.getContractFactory("StablecoinBridge")).deploy(
      await source.getAddress(),
      await token.getAddress(),
      LOCAL_100
    );
    await token.initialize(await bridge.getAddress(), "bridge");
    await source.mint(core.owner.address, SOURCE_100 + 1_000_000n);
    await source.approve(await bridge.getAddress(), SOURCE_100 + 1_000_000n);
    await bridge.mint(SOURCE_100);
    await expect(bridge.mint(1_000_000n)).to.be.revertedWithCustomError(bridge, "Limit");

    await evm_increaseTime(53 * 7 * 86400);
    await expect(bridge.mint(1_000_000n)).to.be.revertedWithCustomError(bridge, "Expired");
    await bridge.burn(ethers.parseEther("50"));
    expect(await source.balanceOf(core.owner.address)).to.equal(51_000_000n);
    expect(await bridge.minted()).to.equal(ethers.parseEther("50"));
  });

  it("credits restricted recipients and pays them after the restriction is lifted", async () => {
    const token = await (await ethers.getContractFactory("OracleFreeDollar")).deploy(
      10 * 86400,
      "IMF Test Currency",
      "K9TST"
    );
    const source = await (await ethers.getContractFactory("TestRestrictedUSDC")).deploy();
    const bridge = await (await ethers.getContractFactory("StablecoinBridge")).deploy(
      await source.getAddress(),
      await token.getAddress(),
      ethers.parseEther("1000")
    );
    await token.initialize(await bridge.getAddress(), "bridge");
    await source.mint(core.owner.address, SOURCE_100);
    await source.approve(await bridge.getAddress(), SOURCE_100);
    await bridge.mint(SOURCE_100);
    await source.setBlocked(core.alice.address, true);

    await bridge.burnAndCredit(core.alice.address, ethers.parseEther("40"));
    expect(await bridge.balanceOf(core.alice.address)).to.equal(40_000_000n);
    await expect(bridge.payoutCredit(core.alice.address)).to.be.revertedWith(
      "TestUSDC: restricted transfer"
    );
    await expect(bridge.burnAndSend(core.alice.address, ethers.parseEther("1"))).to.be.revertedWith(
      "TestUSDC: restricted transfer"
    );
    expect(await token.balanceOf(core.owner.address)).to.equal(ethers.parseEther("60"));
    expect(await bridge.balanceOf(core.alice.address)).to.equal(40_000_000n);

    await source.setBlocked(core.alice.address, false);
    await bridge.connect(core.bob).payoutCredit(core.alice.address);
    expect(await source.balanceOf(core.alice.address)).to.equal(40_000_000n);
    expect(await bridge.balanceOf(core.alice.address)).to.equal(0);
  });

  it("rolls back source deposits and local burns for zero-address targets", async () => {
    await core.source.mint(core.owner.address, SOURCE_100);
    await core.source.approve(await core.bridge.getAddress(), SOURCE_100);
    await expect(core.bridge.mintTo(ethers.ZeroAddress, SOURCE_100)).to.be.revertedWithoutReason();
    expect(await core.source.balanceOf(core.owner.address)).to.equal(SOURCE_100);
    expect(await core.token.totalSupply()).to.equal(0);

    await core.bridge.mint(SOURCE_100);
    await expect(core.bridge.burnAndSend(ethers.ZeroAddress, LOCAL_100)).to.be.revertedWithoutReason();
    expect(await core.token.balanceOf(core.owner.address)).to.equal(LOCAL_100);
    expect(await core.bridge.minted()).to.equal(LOCAL_100);
  });

  it("tracks conversions rather than provenance when other minter liquidity is redeemed", async () => {
    const token = await (await ethers.getContractFactory("OracleFreeDollar")).deploy(
      10 * 86400,
      "IMF Test Currency",
      "K9TST"
    );
    const source = await (await ethers.getContractFactory("TestUSDC")).deploy();
    const bridge = await (await ethers.getContractFactory("StablecoinBridge")).deploy(
      await source.getAddress(),
      await token.getAddress(),
      ethers.parseEther("1000")
    );
    await token.initialize(core.owner.address, "direct test minter");
    await token.initialize(await bridge.getAddress(), "bridge");
    await token.mint(core.owner.address, LOCAL_100);
    await source.mint(core.owner.address, SOURCE_100);
    await source.approve(await bridge.getAddress(), SOURCE_100);
    await bridge.mint(SOURCE_100);

    await token.transfer(core.alice.address, LOCAL_100);
    await bridge.connect(core.alice).burn(LOCAL_100);
    expect(await source.balanceOf(core.alice.address)).to.equal(SOURCE_100);
    expect(await bridge.minted()).to.equal(0);
    expect(await token.totalSupply()).to.equal(LOCAL_100);
    expect(await token.balanceOf(core.owner.address)).to.equal(LOCAL_100);
  });
});
