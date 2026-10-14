import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import {
  deploymentName,
  loadInstances,
  selectInstances,
} from "../instanceConfig";

/**
 * Deploys the per-instance GenesisBootstrapSale (one-shot genesis minter, 500k-unit float split
 * into pool seed / equity / challenger bounty / incentives) and registers it via the token's
 * deployer-gated initialize(). Runs after 00_deploy_all; instances without a bootstrap config
 * are skipped.
 */
const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const instances = selectInstances(hre, loadInstances());
  const endTime = Math.floor(Date.now() / 1000);

  for (const inst of instances) {
    if (!inst.bootstrap) {
      log(`Instance ${inst.code}: no bootstrap config, skipping`);
      continue;
    }
    log(`\n=== Instance ${inst.code}: GenesisBootstrapSale ===`);
    const token = await get(deploymentName(inst, "Token")); // ensures 00_deploy_all has run

    const b = inst.bootstrap;
    const poolSeed = b.poolSeedRecipient ?? deployer;
    const equity = b.equityRecipient ?? deployer;
    const bounty = b.challengerBountyRecipient ?? deployer;
    const incentives = b.incentivesRecipient ?? deployer;
    const saleEndTime = endTime + b.durationDays * 86400;

    const bootstrap = await deploy(deploymentName(inst, "GenesisBootstrap"), {
      contract: "GenesisBootstrapSale",
      from: deployer,
      args: [
        token.address,
        saleEndTime,
        poolSeed,
        equity,
        bounty,
        incentives,
        b.poolSeedAmount,
        b.equityAmount,
        b.challengerBountyAmount,
        b.incentivesAmount,
      ],
      log: true,
    });

    const ofd = await ethers.getContractAt("OracleFreeDollar", token.address);
    if ((await ofd.minters(bootstrap.address)) === 0n) {
      const tx = await ofd.initialize(bootstrap.address, "Genesis Bootstrap");
      await tx.wait();
      log(`initialized GenesisBootstrap at ${bootstrap.address}`);
    } else {
      log("GenesisBootstrap already registered, skipping");
    }

    console.log(
      `Verify GenesisBootstrapSale:\nnpx hardhat verify --network chikyu ${bootstrap.address} ${token.address} ${saleEndTime} ${poolSeed} ${equity} ${bounty} ${incentives} ${b.poolSeedAmount} ${b.equityAmount} ${b.challengerBountyAmount} ${b.incentivesAmount}`
    );
  }
};
export default deploy;
deploy.tags = ["06_genesis_bootstrap", ...loadInstances().map((i) => i.code)];
deploy.dependencies = ["00_deploy_all"];
