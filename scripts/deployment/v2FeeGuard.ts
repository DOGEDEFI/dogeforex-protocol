import { EIP1193Provider, JsonRpcRequest, JsonRpcResponse, RequestArguments } from "hardhat/types";
import { AbiCoder, BytesLike, getAddress, Interface, parseEther, Transaction } from "ethers";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";

export const CHIKYU_CHAIN_ID = 6281971n;
export const CHIKYU_L1_FEE_ORACLE = "0x5300000000000000000000000000000000000002";
export const REFERENCE_L1_FEE_PER_BYTE = parseEther("0.000071");
export const MAX_L1_FEE_PER_BYTE = REFERENCE_L1_FEE_PER_BYTE * 5n;
export const DEFAULT_DEPLOYMENT_BUDGET = parseEther("50");
export const DEFAULT_TRANSACTION_LIMIT = parseEther("15");
export const DEFAULT_MAX_GAS_PRICE = 50_000_000n;

const ORACLE_ABI = ["function getL1Fee(bytes) view returns (uint256)"];
const coder = AbiCoder.defaultAbiCoder();

interface FeeTransaction {
  hash: string;
  from: string;
  nonce: string;
  rawBytes: string;
  l1QuoteWei: string;
  maxL2FeeWei: string;
  reservedFeeWei: string;
  label: string;
  status: "pending" | "mined";
  actualFeeWei?: string;
  actualL1FeeWei?: string;
  blockNumber?: string;
}

interface FeeState {
  transactions: Record<string, FeeTransaction>;
}

interface FeeGuardOptions {
  network: string;
  chainId: bigint;
  deployer?: string;
  scope?: string;
  stateFile?: string | null;
  maxTotalFee?: bigint;
  maxTransactionFee?: bigint;
  maxGasPrice?: bigint;
  oracleAddress?: string;
}

export interface TransactionFeeQuote {
  hash: string;
  from: string;
  nonce: string;
  rawBytes: bigint;
  l1Fee: bigint;
  maxL2Fee: bigint;
  reservedFee: bigint;
}

export function receiptTotalFee(receipt: { gasUsed: string; effectiveGasPrice: string; l1Fee?: string }): {
  l2Fee: bigint;
  l1Fee: bigint;
  totalFee: bigint;
} {
  if (!receipt.gasUsed || !receipt.effectiveGasPrice || !receipt.l1Fee) {
    throw new Error("Receipt is missing gasUsed, effectiveGasPrice, or the Chikyu L1 fee");
  }
  const l2Fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const l1Fee = BigInt(receipt.l1Fee);
  return { l2Fee, l1Fee, totalFee: l2Fee + l1Fee };
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid fee-state ${label}`);
  }
  return value;
}

export class TotalFeeGuard extends EventEmitter implements EIP1193Provider {
  readonly network: string;
  readonly chainId: bigint;
  readonly maxTotalFee: bigint;
  readonly maxTransactionFee: bigint;
  readonly maxGasPrice: bigint;
  readonly oracleAddress: string;
  private readonly wrapped: EIP1193Provider;
  private readonly deployer?: string;
  private readonly scope: string;
  private readonly stateFile: string | null;
  private oracleCode?: Promise<void>;
  private state: FeeState;
  private nextLabel = "deployment";
  private locked = false;
  private readonly releaseLock = (): void => {
    if (!this.stateFile || !this.locked) return;
    const lockFile = this.stateFile + ".lock";
    if (existsSync(lockFile) && readFileSync(lockFile, "utf8") === String(process.pid)) unlinkSync(lockFile);
    this.locked = false;
  };

  constructor(wrapped: EIP1193Provider, options: FeeGuardOptions) {
    super();
    if (options.network !== "chikyuV2" || options.chainId !== CHIKYU_CHAIN_ID) {
      throw new Error("The total-fee guard is only configured for chikyuV2");
    }
    this.wrapped = wrapped;
    this.network = options.network;
    this.chainId = options.chainId;
    this.deployer = options.deployer ? getAddress(options.deployer) : undefined;
    this.scope = options.scope ?? "";
    this.maxTotalFee = options.maxTotalFee ?? DEFAULT_DEPLOYMENT_BUDGET;
    this.maxTransactionFee = options.maxTransactionFee ?? DEFAULT_TRANSACTION_LIMIT;
    this.maxGasPrice = options.maxGasPrice ?? DEFAULT_MAX_GAS_PRICE;
    this.oracleAddress = getAddress(options.oracleAddress ?? CHIKYU_L1_FEE_ORACLE);
    this.stateFile =
      options.stateFile === undefined
        ? join(__dirname, "deployments", options.network, `feeGuard-${this.scope || "unscoped"}.json`)
        : options.stateFile;
    this.state = this.loadState();
  }

  private loadState(): FeeState {
    if (!this.stateFile || !existsSync(this.stateFile)) return { transactions: {} };
    const data = JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, unknown>;
    if (
      data.schemaVersion !== "1.0" ||
      data.network !== this.network ||
      data.chainId !== this.chainId.toString() ||
      data.scope !== this.scope ||
      data.maxTotalFeeWei !== this.maxTotalFee.toString() ||
      (this.deployer && data.deployer !== this.deployer) ||
      !data.transactions ||
      typeof data.transactions !== "object" ||
      Array.isArray(data.transactions)
    ) {
      throw new Error("Fee-state identity, budget, deployer, or transaction table is invalid");
    }
    const transactions: Record<string, FeeTransaction> = {};
    let spent = 0n;
    for (const [key, value] of Object.entries(data.transactions as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fee-state transaction");
      const entry = value as Record<string, unknown>;
      if (
        key !== entry.hash ||
        typeof entry.hash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(entry.hash) ||
        getAddress(String(entry.from)) !== this.deployer ||
        (entry.status !== "pending" && entry.status !== "mined")
      ) {
        throw new Error(`Invalid fee-state transaction ${key}`);
      }
      const tx: FeeTransaction = {
        hash: entry.hash,
        from: getAddress(String(entry.from)),
        nonce: decimal(entry.nonce, "nonce"),
        rawBytes: decimal(entry.rawBytes, "rawBytes"),
        l1QuoteWei: decimal(entry.l1QuoteWei, "l1QuoteWei"),
        maxL2FeeWei: decimal(entry.maxL2FeeWei, "maxL2FeeWei"),
        reservedFeeWei: decimal(entry.reservedFeeWei, "reservedFeeWei"),
        label: typeof entry.label === "string" ? entry.label : "deployment",
        status: entry.status,
      };
      if (entry.status === "mined") {
        tx.actualFeeWei = decimal(entry.actualFeeWei, "actualFeeWei");
        tx.actualL1FeeWei = decimal(entry.actualL1FeeWei, "actualL1FeeWei");
        tx.blockNumber = decimal(entry.blockNumber, "blockNumber");
        spent += BigInt(tx.actualFeeWei);
      }
      transactions[key] = tx;
    }
    if (data.spentFeeWei !== spent.toString() || spent > this.maxTotalFee) throw new Error("Invalid fee-state spending total");
    return { transactions };
  }

  private persist(): void {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp-${process.pid}`;
    writeFileSync(
      temporary,
      JSON.stringify(
        {
          schemaVersion: "1.0",
          network: this.network,
          chainId: this.chainId.toString(),
          scope: this.scope,
          deployer: this.deployer,
          maxTotalFeeWei: this.maxTotalFee.toString(),
          spentFeeWei: this.spentFee().toString(),
          updatedAt: new Date().toISOString(),
          transactions: this.state.transactions,
        },
        null,
        2
      ) + "\n"
    );
    renameSync(temporary, this.stateFile);
  }

  private claimLock(): void {
    if (!this.stateFile || this.locked) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const lockFile = this.stateFile + ".lock";
    if (existsSync(lockFile)) {
      const pid = Number(readFileSync(lockFile, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error(`Another guarded deployment is active with PID ${pid}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      unlinkSync(lockFile);
    }
    writeFileSync(lockFile, String(process.pid), { flag: "wx" });
    this.locked = true;
    process.once("exit", this.releaseLock);
  }

  close(): void {
    this.releaseLock();
    process.removeListener("exit", this.releaseLock);
  }

  labelNextTransaction(label: string): void {
    if (!/^[a-z0-9-]{1,80}$/.test(label)) throw new Error("Invalid transaction label");
    this.nextLabel = label;
  }

  spentFee(): bigint {
    return Object.values(this.state.transactions).reduce(
      (total, tx) => total + (tx.status === "mined" ? BigInt(tx.actualFeeWei as string) : 0n),
      0n
    );
  }

  reservedFee(): bigint {
    return Object.values(this.state.transactions).reduce(
      (total, tx) => total + (tx.status === "pending" ? BigInt(tx.reservedFeeWei) : 0n),
      0n
    );
  }

  snapshot(): { spentFeeWei: string; reservedFeeWei: string; maxTotalFeeWei: string; transactions: FeeTransaction[] } {
    return {
      spentFeeWei: this.spentFee().toString(),
      reservedFeeWei: this.reservedFee().toString(),
      maxTotalFeeWei: this.maxTotalFee.toString(),
      transactions: Object.values(this.state.transactions),
    };
  }

  async quoteL1(data: BytesLike, blockTag = "latest"): Promise<bigint> {
    if (!this.oracleCode) {
      this.oracleCode = (async () => {
        const code = await this.wrapped.request({ method: "eth_getCode", params: [this.oracleAddress, "latest"] });
        if (typeof code !== "string" || code === "0x") throw new Error("The Chikyu L1 fee oracle has no bytecode");
      })().catch((error) => {
        this.oracleCode = undefined;
        throw error;
      });
    }
    await this.oracleCode;
    const oracle = new Interface(ORACLE_ABI);
    const result = await this.wrapped.request({
      method: "eth_call",
      params: [{ to: this.oracleAddress, data: oracle.encodeFunctionData("getL1Fee", [data]) }, blockTag],
    });
    if (typeof result !== "string") throw new Error("The Chikyu L1 fee oracle returned an invalid response");
    return BigInt(oracle.decodeFunctionResult("getL1Fee", result)[0]);
  }

  async quoteSerialized(serialized: string): Promise<TransactionFeeQuote> {
    const tx = Transaction.from(serialized);
    if (tx.chainId !== this.chainId) throw new Error("Signed transaction has the wrong Chikyu chain ID");
    if (!this.deployer || this.scope !== "USD" || tx.from !== this.deployer) {
      throw new Error("Signed transaction is outside the authorized USD deployer scope");
    }
    if (!tx.hash || !tx.from || tx.gasLimit <= 0n || tx.value !== 0n) throw new Error("Invalid guarded deployment transaction");
    if (Object.values(this.state.transactions).some((previous) => previous.nonce === tx.nonce.toString())) {
      throw new Error(`A guarded transaction already uses nonce ${tx.nonce}`);
    }
    const gasPrice = tx.maxFeePerGas ?? tx.gasPrice;
    if (gasPrice === null || gasPrice <= 0n || gasPrice > this.maxGasPrice) {
      throw new Error(`Execution gas-price ceiling exceeded: ${gasPrice} > ${this.maxGasPrice}`);
    }
    const rawBytes = BigInt((serialized.length - 2) / 2);
    const l1Fee = await this.quoteL1(serialized);
    if (l1Fee > MAX_L1_FEE_PER_BYTE * rawBytes) {
      throw new Error("L1 data-fee regime exceeds five times the reference per-byte rate");
    }
    const maxL2Fee = tx.gasLimit * gasPrice;
    const reservedFee = maxL2Fee + l1Fee * 2n;
    if (reservedFee > this.maxTransactionFee) {
      throw new Error(`Reserved transaction fee ${reservedFee} exceeds ${this.maxTransactionFee} wei`);
    }
    return {
      hash: tx.hash,
      from: tx.from,
      nonce: tx.nonce.toString(),
      rawBytes,
      l1Fee,
      maxL2Fee,
      reservedFee,
    };
  }

  private async reconcilePending(): Promise<void> {
    for (const tx of Object.values(this.state.transactions)) {
      if (tx.status !== "pending") continue;
      const receipt = (await this.wrapped.request({ method: "eth_getTransactionReceipt", params: [tx.hash] })) as {
        status: string;
      } | null;
      if (!receipt) throw new Error(`Unresolved transaction ${tx.hash}; inspect it before any further broadcast`);
      await this.recordReceipt(tx.hash, receipt);
      if (receipt.status !== "0x1") throw new Error(`Earlier guarded transaction failed: ${tx.hash}`);
    }
  }

  private async sendRaw(serialized: string): Promise<string> {
    this.claimLock();
    await this.reconcilePending();
    const hash = Transaction.from(serialized).hash;
    if (hash && this.state.transactions[hash]?.status === "mined") return hash;
    const quote = await this.quoteSerialized(serialized);
    const previous = this.state.transactions[quote.hash];
    if (previous) throw new Error(`Transaction ${quote.hash} is still pending`);
    if (this.spentFee() + this.reservedFee() + quote.reservedFee > this.maxTotalFee) {
      throw new Error(`Total deployment-fee budget ${this.maxTotalFee} wei would be exceeded`);
    }
    this.state.transactions[quote.hash] = {
      hash: quote.hash,
      from: quote.from,
      nonce: quote.nonce,
      rawBytes: quote.rawBytes.toString(),
      l1QuoteWei: quote.l1Fee.toString(),
      maxL2FeeWei: quote.maxL2Fee.toString(),
      reservedFeeWei: quote.reservedFee.toString(),
      label: this.nextLabel,
      status: "pending",
    };
    this.nextLabel = "deployment";
    this.persist();
    return (await this.wrapped.request({ method: "eth_sendRawTransaction", params: [serialized] })) as string;
  }

  private async recordReceipt(hash: string, receipt: unknown): Promise<void> {
    const tx = this.state.transactions[hash];
    if (!tx || tx.status !== "pending" || !receipt) return;
    const raw = receipt as { gasUsed: string; effectiveGasPrice: string; l1Fee?: string; blockNumber: string; status: string };
    const { totalFee, l1Fee } = receiptTotalFee(raw);
    tx.status = "mined";
    tx.actualFeeWei = totalFee.toString();
    tx.actualL1FeeWei = l1Fee.toString();
    tx.blockNumber = BigInt(raw.blockNumber).toString();
    this.persist();
    if (raw.status !== "0x1") throw new Error(`Guarded transaction reverted: ${hash}`);
    if (totalFee > BigInt(tx.reservedFeeWei)) throw new Error(`Actual L1+L2 fee exceeded its pre-broadcast ceiling: ${hash}`);
    if (this.spentFee() > this.maxTotalFee) throw new Error(`Actual deployment fees exceeded ${this.maxTotalFee} wei`);
  }

  async request(args: RequestArguments): Promise<unknown> {
    if (args.method === "eth_sendRawTransaction") {
      if (!Array.isArray(args.params) || args.params.length !== 1 || typeof args.params[0] !== "string") {
        throw new Error("Expected exactly one signed transaction");
      }
      return this.sendRaw(args.params[0]);
    }
    const result = await this.wrapped.request(args);
    if (args.method === "eth_getTransactionReceipt" && Array.isArray(args.params) && typeof args.params[0] === "string") {
      await this.recordReceipt(args.params[0], result);
    }
    return result;
  }

  async send(method: string, params: unknown[] = []): Promise<unknown> {
    return this.request({ method, params });
  }

  sendAsync(payload: JsonRpcRequest, callback: (error: unknown, response: JsonRpcResponse) => void): void {
    void this.request(payload).then(
      (result) => callback(null, { jsonrpc: payload.jsonrpc, id: payload.id, result }),
      (error: unknown) =>
        callback(error, {
          jsonrpc: payload.jsonrpc,
          id: payload.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        })
    );
  }
}

const totalFeeGuards = new Map<string, TotalFeeGuard>();

export function registerTotalFeeGuard(guard: TotalFeeGuard): void {
  totalFeeGuards.set(guard.network, guard);
}

export function getTotalFeeGuard(network: string): TotalFeeGuard {
  const guard = totalFeeGuards.get(network);
  if (!guard) throw new Error(`The ${network} total-fee guard is not installed`);
  return guard;
}

export function encodeOracleQuote(value: bigint): string {
  return coder.encode(["uint256"], [value]);
}
