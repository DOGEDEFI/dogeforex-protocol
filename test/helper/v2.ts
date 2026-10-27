import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

export const LOCAL_100 = ethers.parseEther("100");
export const SOURCE_100 = 100_000_000n;
export const INITIAL_SHARES = ethers.parseEther("1000");
export const BRIDGE_LIMIT = ethers.parseEther("1000000");

export async function deployV2Core(initialRatePPM: bigint | number = 50000) {
  const [owner, alice, bob] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("OracleFreeDollar")).deploy(
    10 * 86400,
    "IMF Test Dollar",
    "K9TST"
  );
  const source = await (await ethers.getContractFactory("TestUSDC")).deploy();
  const bridge = await (await ethers.getContractFactory("StablecoinBridge")).deploy(
    await source.getAddress(),
    await token.getAddress(),
    BRIDGE_LIMIT
  );
  const positionFactory = await (await ethers.getContractFactory("PositionFactory")).deploy();
  const roller = await (await ethers.getContractFactory("PositionRoller")).deploy(
    await token.getAddress()
  );
  const savings = await (await ethers.getContractFactory("Savings")).deploy(
    await token.getAddress(),
    initialRatePPM
  );
  const hub = await (await ethers.getContractFactory("MintingHub")).deploy(
    await token.getAddress(),
    await savings.getAddress(),
    await roller.getAddress(),
    await positionFactory.getAddress()
  );
  const equity = await ethers.getContractAt("Equity", await token.reserve());
  return { owner, alice, bob, token, source, bridge, positionFactory, roller, savings, hub, equity };
}

export async function initializeV2Core(core: Awaited<ReturnType<typeof deployV2Core>>) {
  const registrations = [
    [core.savings, "Savings"],
    [core.positionFactory, "Position Factory"],
    [core.roller, "Position Roller"],
    [core.hub, "Minting Hub V2"],
    [core.bridge, "Source Stablecoin Bridge"],
  ] as const;
  for (const [contract, label] of registrations) {
    await core.token.initialize(await contract.getAddress(), label);
  }
}

export async function deployInitializedV2Core(initialRatePPM: bigint | number = 50000) {
  const core = await deployV2Core(initialRatePPM);
  await initializeV2Core(core);
  return core;
}

export async function mintAndBridge(
  core: Awaited<ReturnType<typeof deployV2Core>>,
  account: HardhatEthersSigner,
  sourceAmount: bigint
) {
  await core.source.mint(account.address, sourceAmount);
  await core.source.connect(account).approve(await core.bridge.getAddress(), sourceAmount);
  await core.bridge.connect(account).mint(sourceAmount);
}

export async function bootstrapV2(core: Awaited<ReturnType<typeof deployV2Core>>) {
  await mintAndBridge(core, core.owner, SOURCE_100);
  await core.equity.invest(LOCAL_100, INITIAL_SHARES);
}

export async function asBridge(core: Awaited<ReturnType<typeof deployV2Core>>) {
  const address = await core.bridge.getAddress();
  await ethers.provider.send("hardhat_setBalance", [address, "0xde0b6b3a7640000"]);
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  return await ethers.getSigner(address);
}
