import { expect } from "chai";
import { ethers } from "hardhat";
import { EIP1193Provider, RequestArguments } from "hardhat/types";
import { Transaction, Wallet } from "ethers";
import { EventEmitter } from "node:events";
import {
  CHIKYU_CHAIN_ID,
  DEFAULT_MAX_GAS_PRICE,
  MAX_L1_FEE_PER_BYTE,
  TotalFeeGuard,
  encodeOracleQuote,
  receiptTotalFee,
} from "../scripts/deployment/v2FeeGuard";

class MockProvider extends EventEmitter implements EIP1193Provider {
  oracleFee = 1_000_000_000_000n;
  gasUsed = 21_000n;
  gasPrice = 1_000_000n;
  broadcasts = 0;
  receiptAvailable = true;
  missingL1 = false;
  status = "0x1";
  hash = "";
  codeReads = 0;
  callBlockTags: unknown[] = [];

  async request(args: RequestArguments): Promise<unknown> {
    const params = Array.isArray(args.params) ? args.params : [];
    if (args.method === "eth_chainId") return ethers.toBeHex(CHIKYU_CHAIN_ID);
    if (args.method === "net_version") return CHIKYU_CHAIN_ID.toString();
    if (args.method === "eth_getTransactionCount") return "0x0";
    if (args.method === "eth_getCode") {
      this.codeReads++;
      return "0x6000";
    }
    if (args.method === "eth_call") {
      this.callBlockTags.push(params[1]);
      return encodeOracleQuote(this.oracleFee);
    }
    if (args.method === "eth_sendRawTransaction") {
      this.broadcasts++;
      this.hash = Transaction.from(String(params[0])).hash as string;
      return this.hash;
    }
    if (args.method === "eth_getTransactionReceipt") {
      if (!this.receiptAvailable || params[0] !== this.hash) return null;
      const receipt: Record<string, string | undefined> = {
        transactionHash: this.hash,
        gasUsed: ethers.toBeHex(this.gasUsed),
        effectiveGasPrice: ethers.toBeHex(this.gasPrice),
        l1Fee: ethers.toBeHex(this.oracleFee),
        blockNumber: "0x1",
        status: this.status,
      };
      if (this.missingL1) delete receipt.l1Fee;
      return receipt;
    }
    throw new Error(`Unexpected RPC method ${args.method}`);
  }
}

describe("V2 deployment total-fee guard", () => {
  let wallet: ReturnType<typeof Wallet.createRandom>;
  let provider: MockProvider;

  beforeEach(() => {
    wallet = Wallet.createRandom();
    provider = new MockProvider();
  });

  function guard(overrides: { maxTotalFee?: bigint; scope?: string; stateFile?: string | null } = {}): TotalFeeGuard {
    return new TotalFeeGuard(provider, {
      network: "chikyuV2",
      chainId: CHIKYU_CHAIN_ID,
      deployer: wallet.address,
      scope: "USD",
      stateFile: null,
      maxTotalFee: ethers.parseEther("1"),
      ...overrides,
    });
  }

  function signed(options: { nonce?: number; gasPrice?: bigint; chainId?: number; data?: string } = {}): Promise<string> {
    return wallet.signTransaction({
      to: wallet.address,
      data: options.data ?? "0x",
      value: 0,
      nonce: options.nonce ?? 0,
      gasLimit: 21_000,
      gasPrice: options.gasPrice ?? 1_000_000n,
      chainId: options.chainId ?? Number(CHIKYU_CHAIN_ID),
      type: 0,
    });
  }

  function send(instance: TotalFeeGuard, raw: string): Promise<unknown> {
    return instance.request({ method: "eth_sendRawTransaction", params: [raw] });
  }

  function receipt(instance: TotalFeeGuard, hash: string): Promise<unknown> {
    return instance.request({ method: "eth_getTransactionReceipt", params: [hash] });
  }

  it("quotes signed calldata and records L1 plus L2 fees exactly once", async () => {
    const instance = guard();
    const raw = await signed();
    const quote = await instance.quoteSerialized(raw);
    expect(quote.l1Fee).to.equal(provider.oracleFee);
    expect(quote.maxL2Fee).to.equal(21_000_000_000n);
    expect(quote.rawBytes).to.equal(BigInt((raw.length - 2) / 2));
    const hash = String(await send(instance, raw));
    await receipt(instance, hash);
    await receipt(instance, hash);
    await send(instance, raw);
    expect(provider.broadcasts).to.equal(1);
    expect(instance.spentFee()).to.equal(21_000_000_000n + provider.oracleFee);
    expect(instance.reservedFee()).to.equal(0n);
    expect(instance.snapshot().transactions[0].actualL1FeeWei).to.equal(provider.oracleFee.toString());
  });

  it("rejects excessive L1 data fees before broadcast", async () => {
    const instance = guard();
    const raw = await signed();
    provider.oracleFee = MAX_L1_FEE_PER_BYTE * BigInt((raw.length - 2) / 2) + 1n;
    await expect(send(instance, raw)).to.be.rejectedWith("L1 data-fee regime exceeds the configured per-byte rate ceiling");
    expect(provider.broadcasts).to.equal(0);
  });

  it("rejects excessive execution gas prices before broadcast", async () => {
    const instance = guard();
    await expect(send(instance, await signed({ gasPrice: DEFAULT_MAX_GAS_PRICE + 1n }))).to.be.rejectedWith(
      "gas-price ceiling"
    );
    expect(provider.broadcasts).to.equal(0);
  });

  it("rejects an exceeded total budget before broadcast", async () => {
    const instance = guard({ maxTotalFee: 1n });
    await expect(send(instance, await signed())).to.be.rejectedWith("Total deployment-fee budget");
    expect(provider.broadcasts).to.equal(0);
  });

  it("rejects a wrong chain, a wrong scope, and a duplicate nonce", async () => {
    const instance = guard();
    await expect(send(instance, await signed({ chainId: 1 }))).to.be.rejectedWith("wrong Chikyu chain ID");
    await expect(send(guard({ scope: "EUR" }), await signed())).to.be.rejectedWith("authorized USD");
    const raw = await signed();
    const hash = String(await send(instance, raw));
    await receipt(instance, hash);
    await expect(send(instance, await signed({ data: "0x01" }))).to.be.rejectedWith("nonce");
    expect(provider.broadcasts).to.equal(1);
  });

  it("stops before another broadcast when a receipt is unresolved", async () => {
    const instance = guard();
    await send(instance, await signed());
    provider.receiptAvailable = false;
    const next = await signed({ nonce: 1 });
    await expect(send(instance, next)).to.be.rejectedWith("Unresolved transaction");
    expect(provider.broadcasts).to.equal(1);
    provider.receiptAvailable = true;
    await send(instance, next);
    expect(provider.broadcasts).to.equal(2);
    expect(instance.snapshot().transactions).to.have.length(2);
  });

  it("does not silently treat a missing L1 receipt field as zero", async () => {
    const instance = guard();
    const hash = String(await send(instance, await signed()));
    provider.missingL1 = true;
    await expect(receipt(instance, hash)).to.be.rejectedWith("missing gasUsed");
    expect(instance.snapshot().transactions[0].status).to.equal("pending");
  });

  it("records the fee for a reverted transaction and stops", async () => {
    const instance = guard();
    provider.status = "0x0";
    const hash = String(await send(instance, await signed()));
    await expect(receipt(instance, hash)).to.be.rejectedWith("reverted");
    expect(instance.spentFee()).to.equal(21_000_000_000n + provider.oracleFee);
  });

  it("rejects incomplete fee receipts", () => {
    expect(() => receiptTotalFee({ gasUsed: "0x1", effectiveGasPrice: "0x1" })).to.throw("missing gasUsed");
  });

  it("quotes multiple payloads at one block with a single oracle code read", async () => {
    const instance = guard();
    await Promise.all([instance.quoteL1("0x01", "0x123"), instance.quoteL1("0x02", "0x123")]);
    expect(provider.codeReads).to.equal(1);
    expect(provider.callBlockTags).to.deep.equal(["0x123", "0x123"]);
  });

  it("intercepts the raw transaction produced by Hardhat's local-account signer", async () => {
    const instance = guard();
    const { LocalAccountsProvider } = require("hardhat/internal/core/providers/accounts");
    const signer = new LocalAccountsProvider(instance, [wallet.privateKey]);
    const hash = String(
      await signer.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: wallet.address,
            to: wallet.address,
            data: "0x",
            value: "0x0",
            nonce: "0x0",
            gas: "0x5208",
            gasPrice: "0xf4240",
          },
        ],
      })
    );
    expect(provider.broadcasts).to.equal(1);
    expect(hash).to.equal(provider.hash);
    await signer.request({ method: "eth_getTransactionReceipt", params: [hash] });
    expect(instance.spentFee()).to.equal(21_000_000_000n + provider.oracleFee);
  });

  it("preserves fee accounting and pending-transaction protection across restarts", async () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const directory = mkdtempSync(join(process.cwd(), "test", ".fee-guard-"));
    const stateFile = join(directory, "fees.json");
    const instances: TotalFeeGuard[] = [];
    try {
      const first = guard({ stateFile });
      instances.push(first);
      const initial = await signed();
      provider.receiptAvailable = false;
      await send(first, initial);
      first.close();

      const second = guard({ stateFile });
      instances.push(second);
      expect(second.reservedFee()).to.be.greaterThan(0n);
      await expect(send(second, await signed({ nonce: 1 }))).to.be.rejectedWith("Unresolved transaction");
      expect(provider.broadcasts).to.equal(1);
      second.close();

      provider.receiptAvailable = true;
      const third = guard({ stateFile });
      instances.push(third);
      const next = await signed({ nonce: 1 });
      await send(third, next);
      await receipt(third, provider.hash);
      expect(provider.broadcasts).to.equal(2);
      expect(third.spentFee()).to.equal(2n * (21_000_000_000n + provider.oracleFee));
      third.close();

      const fourth = guard({ stateFile, maxTotalFee: ethers.parseEther("2") });
      instances.push(fourth);
      expect(fourth.spentFee()).to.equal(2n * (21_000_000_000n + provider.oracleFee));
      await send(fourth, initial);
      await expect(send(fourth, await signed({ data: "0x01" }))).to.be.rejectedWith("nonce");
      expect(provider.broadcasts).to.equal(2);

      const fifth = guard({ stateFile });
      instances.push(fifth);
      expect(fifth.spentFee()).to.equal(2n * (21_000_000_000n + provider.oracleFee));
    } finally {
      for (const instance of instances) instance.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
