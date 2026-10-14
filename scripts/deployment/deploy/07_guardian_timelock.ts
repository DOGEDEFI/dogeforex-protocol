import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import {
  deploymentName,
  loadInstances,
  selectInstances,
} from "../instanceConfig";

/**
 * Deploys the per-instance GuardianTimelock (72h timelock on unpause/guardian rotation; the
 * guardian can pause admissions instantly) and wires it on the token via setGuardian. Once set,
 * the guardian's pause blocks suggestMinter, MintingHub.openPosition, and MintingHub.clone —
 * never transfers, challenges, repayments, or savings. Instances with guardian: null keep the
 * default fully-open (Frankencoin) behavior. Runs after 00_deploy_all.
 */
const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const instances = selectInstances(hre, loadInstances());

  for (const inst of instances) {
    if (!inst.guardian) {
      log(`Instance ${inst.code}: no guardian configured, admission gate stays open`);
      continue;
    }
    log(`\n=== Instance ${inst.code}: GuardianTimelock ===`);
    const token = await get(deploymentName(inst, "Token")); // ensures 00_deploy_all has run

    const timelock = await deploy(deploymentName(inst, "GuardianTimelock"), {
      contract: "GuardianTimelock",
      from: deployer,
      args: [inst.guardian],
      log: true,
    });

    const ofd = await ethers.getContractAt("OracleFreeDollar", token.address);
    if ((await ofd.guardian()) === ethers.ZeroAddress) {
      const tx = await ofd.setGuardian(timelock.address);
      await tx.wait();
      log(`guardian wired on ${inst.tokenSymbol}: ${timelock.address}`);
    } else {
      log("guardian already wired, skipping");
    }

    console.log(
      `Verify GuardianTimelock:\nnpx hardhat verify --network chikyu ${timelock.address} ${inst.guardian}`
    );
  }
};
export default deploy;
deploy.tags = ["07_guardian_timelock", ...loadInstances().map((i) => i.code)];
deploy.dependencies = ["00_deploy_all"];
