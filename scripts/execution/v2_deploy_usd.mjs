import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'ethers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const HARDHAT = join(ROOT, 'node_modules/hardhat/internal/cli/cli.js');
const mode = process.argv[2];
if (!['--estimate', '--preflight', '--deploy', '--verify'].includes(mode)) {
  throw new Error('Use --estimate, --preflight, --deploy, or --verify; no other arguments are accepted');
}
if (!process.versions.node.startsWith('20.')) {
  throw new Error('Use Node 20 from the repository .nvmrc before running Chikyu V2 commands');
}
const legacy = JSON.parse(readFileSync(join(ROOT, 'deployments/k9usd.chikyu.json'), 'utf8'));
const deployer = getAddress(legacy.roles.deployer);
const env = {
  ...process.env,
  IMF_V2_DEPLOYER: deployer,
  IMF_V2_DEPLOYMENT_SCOPE: 'USD',
  IMF_V2_ESTIMATE_ONLY: mode === '--estimate' ? '1' : '0',
};

function hardhat(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARDHAT, ...args], { cwd: ROOT, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Hardhat ${args[0]} exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}`));
    });
  });
}

if (mode === '--deploy') await hardhat(['compile', '--force']);
if (mode !== '--verify') await hardhat(['run', 'scripts/deployment/v2Preflight.ts', '--network', 'chikyuV2']);
if (mode === '--deploy') await hardhat(['deploy', '--network', 'chikyuV2', '--tags', 'USD']);
if (!['--estimate', '--preflight'].includes(mode)) {
  await hardhat(['run', 'scripts/deployment/v2VerifyDeployment.ts', '--network', 'chikyuV2']);
}
