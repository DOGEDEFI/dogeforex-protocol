import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(readFileSync(join(root, 'scripts/execution/demoRollout.config.json'), 'utf8'));
const mode = process.env.DEMO_MODE || 'verify';
const stage = process.env.DEMO_STAGE || 'all';
const pilot = process.env.DEMO_PILOT;
if (!['estimate', 'deploy', 'verify', 'mint-due', 'invest'].includes(mode)) throw new Error('DEMO_MODE must be estimate, deploy, verify, mint-due or invest');
if (!['all', 'currencies', 'bridges', 'demo-tokens', 'pools', 'positions', 'equity'].includes(stage)) throw new Error('Unsupported DEMO_STAGE');
if (!process.versions.node.startsWith('20.')) throw new Error('Use Node 20 for the demo rollout');
if (pilot && !config.allCurrencies.includes(pilot)) throw new Error('Unknown currency pilot');
const feePolicy = {
  feeCapTDOGE: config.feeCapTDOGE,
  transactionFeeCapTDOGE: config.transactionFeeCapTDOGE,
  maxL1FeePerByteTDOGE: config.maxL1FeePerByteTDOGE,
  ...config.pilotFeePolicies?.[pilot],
};

function hardhat(args, script = false) {
  const env = {
    ...process.env,
    IMF_V2_DEPLOYER: config.owner,
    IMF_V2_DEPLOYMENT_SCOPE: 'DEMO_ROLLOUT',
    IMF_V2_MAX_TOTAL_FEE: feePolicy.feeCapTDOGE,
    IMF_V2_MAX_TX_FEE: feePolicy.transactionFeeCapTDOGE,
    IMF_V2_MAX_L1_FEE_PER_BYTE: feePolicy.maxL1FeePerByteTDOGE,
    DEMO_MODE: mode,
    DEMO_STAGE: stage,
  };
  const command = script ? ['run', args[0], '--network', 'chikyuV2'] : ['deploy', '--network', 'chikyuV2', '--tags', args[0]];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/hardhat/internal/cli/cli.js'), ...command], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Hardhat exited with ${code ?? 'null'} and signal ${signal ?? 'none'}`)));
  });
}

if (mode === 'estimate') {
  await hardhat(['scripts/deployment/demoPreflight.ts'], true);
} else if (stage === 'currencies' && mode === 'deploy') {
  const preflight = JSON.parse(readFileSync(join(root, 'scripts/deployment/deployments/chikyuV2/demo-preflight.json'), 'utf8'));
  if (preflight.status !== 'affordable-estimate' || preflight.broadcast !== false) throw new Error('Run a passing read-only preflight before deployment');
  const codes = process.env.DEMO_PILOT ? [process.env.DEMO_PILOT] : config.newCurrencies;
  if (codes.some((code) => !config.newCurrencies.includes(code))) throw new Error('DEMO_PILOT must be one of the missing V2 currencies');
  await hardhat([codes.join(',')]);
} else {
  await hardhat(['scripts/execution/demoRollout.ts'], true);
}
