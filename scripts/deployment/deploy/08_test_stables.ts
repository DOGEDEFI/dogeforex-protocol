import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { deploymentName, loadInstances, selectInstances } from "../instanceConfig";

/**
 * Deploys one TestStable per K9 currency (testnet-only source stable for the G1 bridge
 * bootstrap simulation): "DogeOS Test USD"/testUSD … "DogeOS Test NGN"/testNGN. Deployer-gated
 * mint, 1 unit = 1 fiat unit by convention. Pure deployment — no protocol wiring here;
 * the StablecoinBridge is deployed by 09_bridges and registered as a minter via the organic
 * suggestMinter path in scripts/execution/p6_bridge_bootstrap.mjs.
 */
const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const instances = selectInstances(hre, loadInstances());

  for (const inst of instances) {
    const name = `DogeOS Test ${inst.code}`;
    const symbol = `test${inst.code}`;
    log(`\n=== TestStable ${inst.code}: ${name} (${symbol}) ===`);
    const t = await deploy(deploymentName(inst, "TestStable"), {
      contract: "TestStable",
      from: deployer,
      args: [name, symbol],
      log: true,
    });
    console.log(`Verify TestStable:\nnpx hardhat verify --network chikyu ${t.address} "${name}" "${symbol}"`);
  }
};
export default deploy;
deploy.tags = ["08_test_stables", ...loadInstances().map((i) => i.code)];
deploy.dependencies = ["00_deploy_all"];
