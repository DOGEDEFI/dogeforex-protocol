import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { bootstrapV2, deployInitializedV2Core, deployV2Core, mintAndBridge, SOURCE_100 } from "./helper/v2";

async function signPermit(
  signer: HardhatEthersSigner,
  tokenAddress: string,
  spender: string,
  value: bigint,
  nonce: bigint,
  deadline: bigint
) {
  const network = await ethers.provider.getNetwork();
  const signature = await signer.signTypedData(
    { chainId: network.chainId, verifyingContract: tokenAddress },
    {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { owner: signer.address, spender, value, nonce, deadline }
  );
  return ethers.Signature.from(signature);
}

async function currentDeadline(offset: bigint) {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp) + offset;
}

describe("V2 token and pool-share permits", () => {
  let core: Awaited<ReturnType<typeof deployV2Core>>;

  beforeEach(async () => {
    core = await deployInitializedV2Core();
    await bootstrapV2(core);
  });

  it("uses a name-independent domain separator and consumes a currency permit once", async () => {
    await mintAndBridge(core, core.owner, SOURCE_100);
    const token = core.token;
    const address = await core.token.getAddress();
    const value = ethers.parseEther("100");
    const signature = await signPermit(
      core.owner,
      address,
      core.alice.address,
      value,
      0n,
      await currentDeadline(3600n)
    );

    await token.connect(core.bob).permit(
      core.owner.address,
      core.alice.address,
      value,
      await currentDeadline(3600n),
      signature.v,
      signature.r,
      signature.s
    );
    expect(await core.token.nonces(core.owner.address)).to.equal(1);
    expect(await core.token.allowance(core.owner.address, core.alice.address)).to.equal(value);
    await core.token.connect(core.alice).transferFrom(
      core.owner.address,
      core.alice.address,
      ethers.parseEther("25")
    );
    expect(await core.token.allowance(core.owner.address, core.alice.address)).to.equal(
      ethers.parseEther("75")
    );
    await expect(
      token.permit(
        core.owner.address,
        core.alice.address,
        value,
        await currentDeadline(3600n),
        signature.v,
        signature.r,
        signature.s
      )
    ).to.be.revertedWith("INVALID_SIGNER");

    const expired = await currentDeadline(-1n);
    const expiredSignature = await signPermit(core.owner, address, core.alice.address, 1n, 1n, expired);
    await expect(
      token.permit(core.owner.address, core.alice.address, 1n, expired, expiredSignature.v, expiredSignature.r, expiredSignature.s)
    ).to.be.revertedWith("PERMIT_DEADLINE_EXPIRED");
  });

  it("supports pool-share permits with an independent verifying contract", async () => {
    const equity = core.equity;
    const address = await core.equity.getAddress();
    expect(await core.equity.symbol()).to.equal("K9TSTPS");
    expect(await core.equity.DOMAIN_SEPARATOR()).not.to.equal(await core.token.DOMAIN_SEPARATOR());
    const value = ethers.parseEther("500");
    const signature = await signPermit(
      core.owner,
      address,
      core.alice.address,
      value,
      0n,
      await currentDeadline(3600n)
    );

    await equity.connect(core.bob).permit(
      core.owner.address,
      core.alice.address,
      value,
      await currentDeadline(3600n),
      signature.v,
      signature.r,
      signature.s
    );
    expect(await core.equity.nonces(core.owner.address)).to.equal(1);
    await core.equity.connect(core.alice).transferFrom(
      core.owner.address,
      core.alice.address,
      ethers.parseEther("200")
    );
    expect(await core.equity.balanceOf(core.alice.address)).to.equal(ethers.parseEther("200"));
    expect(await core.equity.allowance(core.owner.address, core.alice.address)).to.equal(
      ethers.parseEther("300")
    );
  });
});
