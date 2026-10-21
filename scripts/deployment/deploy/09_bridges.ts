import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { deploymentName, loadInstances, selectInstances } from "../instanceConfig";

/**
 * Deploys one StablecoinBridge per K9 instance (the Frankencoin-start simulation, backlog G1):
 * locks the currency's TestStable and mints K9XXX 1:1 (redeemable by burning). Immutable limit
 * 1,000,000 units per bridge; 52-week horizon baked into the contract. Deliberately NOT wired:
 * the bridge becomes a minter only through the organic, veto-able suggestMinter path run by
 * scripts/execution/p6_bridge_bootstrap.mjs (treasury pays the 1,000-unit fee; 900 s application
 * period on Chikyu).
 */
const LIMIT = ethers.parseUnits("1000000", 18);

const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const instances = selectInstances(hre, loadInstances());

  for (const inst of instances) {
    log(`\n=== Instance ${inst.code}: StablecoinBridge ===`);
    const token = await get(deploymentName(inst, "Token"));
    const stable = await get(deploymentName(inst, "TestStable"));

    const bridge = await deploy(deploymentName(inst, "Bridge"), {
      contract: "StablecoinBridge",
      from: deployer,
      args: [stable.address, token.address, LIMIT],
      log: true,
    });
    console.log(
      `Verify StablecoinBridge:\nnpx hardhat verify --network chikyu ${bridge.address} ${stable.address} ${token.address} ${LIMIT}`
    );
  }
};
export default deploy;
deploy.tags = ["09_bridges", ...loadInstances().map((i) => i.code)];
deploy.dependencies = ["08_test_stables"];
