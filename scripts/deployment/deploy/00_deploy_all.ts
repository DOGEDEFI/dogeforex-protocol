import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import {
  deploymentName,
  loadInstances,
  minApplicationPeriodFor,
  selectInstances,
} from "../instanceConfig";

/**
 * Deploys the core contract suite for every instance in instances/instances.json:
 *   Token (Equity is auto-deployed by the token constructor, do not compute its address —
 *   read OFD.reserve()) -> PositionFactory -> PositionRoller -> Savings (=Leadrate) -> MintingHub,
 * then registers the four genesis minters via the token's deployer-gated initialize().
 * All downstream addresses come from deployment outputs (deployments.get), never hand-edited.
 *
 * Select one currency with e.g. --tags USD; run everything with --tags 00_deploy_all.
 */
const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const chainId = Number(
    hre.network.config.chainId ?? (await ethers.provider.getNetwork()).chainId
  );
  const minApplicationPeriod = minApplicationPeriodFor(chainId);
  const instances = selectInstances(hre, loadInstances());

  for (const inst of instances) {
    log(`\n=== Instance ${inst.code}: ${inst.tokenName} (${inst.tokenSymbol}) ===`);

    const token = await deploy(deploymentName(inst, "Token"), {
      contract: "OracleFreeDollar",
      from: deployer,
      args: [minApplicationPeriod, inst.tokenName, inst.tokenSymbol],
      log: true,
    });

    const positionFactory = await deploy(deploymentName(inst, "PositionFactory"), {
      contract: "PositionFactory",
      from: deployer,
      log: true,
    });

    const positionRoller = await deploy(deploymentName(inst, "PositionRoller"), {
      contract: "PositionRoller",
      from: deployer,
      args: [token.address],
      log: true,
    });

    const savings = await deploy(deploymentName(inst, "Savings"), {
      contract: "Savings",
      from: deployer,
      args: [token.address, inst.leadratePPM],
      log: true,
    });

    const mintingHub = await deploy(deploymentName(inst, "MintingHub"), {
      contract: "MintingHub",
      from: deployer,
      args: [token.address, savings.address, positionRoller.address, positionFactory.address],
      log: true,
    });

    const ofd = await ethers.getContractAt("OracleFreeDollar", token.address);
    const equity = await ofd.reserve();

    // Genesis minter registrations (deployer-gated, supply==0-gated, idempotent). Equity
    // verifies as a library-free companion: npx hardhat verify --network <net> <equity> <token>
    const registrations: Array<[string, string]> = [
      [savings.address, "Savings"],
      [positionFactory.address, "Position Factory"],
      [positionRoller.address, "Position Roller"],
      [mintingHub.address, "Minting Hub V2"],
    ];
    for (const [address, label] of registrations) {
      if ((await ofd.minters(address)) === 0n) {
        const tx = await ofd.initialize(address, label);
        await tx.wait();
        log(`initialized ${label} at ${address}`);
      } else {
        log(`${label} already registered, skipping`);
      }
    }

    console.log(
      `Verify ${inst.tokenSymbol}:\nnpx hardhat verify --network chikyu ${token.address} ${minApplicationPeriod} "${inst.tokenName}" "${inst.tokenSymbol}"`
    );
    console.log(
      `Verify ${inst.tokenSymbol}PS (Equity):\nnpx hardhat verify --network chikyu ${equity} ${token.address} "${inst.tokenName}" "${inst.tokenSymbol}"`
    );
    console.log(
      `Verify PositionFactory:\nnpx hardhat verify --network chikyu ${positionFactory.address}`
    );
    console.log(
      `Verify PositionRoller:\nnpx hardhat verify --network chikyu ${positionRoller.address} ${token.address}`
    );
    console.log(
      `Verify Savings:\nnpx hardhat verify --network chikyu ${savings.address} ${token.address} ${inst.leadratePPM}`
    );
    console.log(
      `Verify MintingHub:\nnpx hardhat verify --network chikyu ${mintingHub.address} ${token.address} ${savings.address} ${positionRoller.address} ${positionFactory.address}`
    );
  }
};
export default deploy;
deploy.tags = ["00_deploy_all", ...loadInstances().map((i) => i.code)];
deploy.dependencies = [];
