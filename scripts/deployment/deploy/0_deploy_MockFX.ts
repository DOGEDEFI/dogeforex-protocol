import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploys MOFX, the shared DogeForex mock FX collateral (testnet only: 18 dec,
 * deployer-gated mint, 1 MOFX = $1 convention). One deployment serves all currency
 * instances; scripted positions rehearse against MOFX on Chikyu while wDOGE-collateral
 * positions are mainnet-only (runbook §4.1). The MintingHub is collateral-agnostic, so
 * the rehearsal exercises the same code path. Verify with the printed command.
 */
const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const mofx = await deploy("MOFX", {
    contract: "MOFX",
    from: deployer,
    args: [],
    log: true,
  });

  log(`MOFX deployed at ${mofx.address}`);
  console.log(`Verify MOFX:\nnpx hardhat verify --network chikyu ${mofx.address}`);
};
export default deploy;
deploy.tags = ["0_deploy_MockFX", "MOFX"];
deploy.dependencies = [];
