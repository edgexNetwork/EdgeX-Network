import { trimEDX, formatEDX, parseEDX } from "../utils/amount";
import { formatNumber, padCJK, truncateMiddle, txConfirmText, txMaturityLine, txStatusLabel, txTypeLabel } from "../utils/display";
import { COIN_TICKER, MINING_MATURITY_CONFIRMATIONS } from "../utils/constants";
import { FEE_TIER_NAMES, isFeeTierName, type FeeTierName } from "../core/fee";
import { promptSecret } from "../keys/vaultLegacy";
import { parseCount, parseSkip } from "../core/paging";
import type { FeeTiers } from "../api/types";
import type { AskOption, Command, CommandContext } from "./registry";
import { currentLocale, getLang, LANG_BUTTON_LABEL, LANG_ORDER, saveLang, setLang, t, type Lang } from "../i18n";



const AMOUNT_LIKE = /^\d*\.?\d+$/;

/** Maximum password confirmation attempts for sensitive commands. */
export const PASSWORD_RETRY_LIMIT = 3;

function fmtTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString(currentLocale(), { hour12: false });
}


async function resolvePassword(ctx: CommandContext): Promise<string | null> {
  if (ctx.password !== undefined) return ctx.password;
  if (process.env.EDX_WALLET_PASSWORD) return process.env.EDX_WALLET_PASSWORD;
  if (ctx.askSecret) return ctx.askSecret(t("dialog.walletPassword"));
  if (ctx.interactive) return promptSecret(t("dialog.walletPassword"));
  return null;
}

/**
 * Re-verify the wallet password for a sensitive operation.
 * - Wallets without a vault skip verification entirely.
 * - Every attempt prompts interactively (askSecret); an empty answer cancels.
 * - Only "wrong password" failures retry, up to PASSWORD_RETRY_LIMIT; any
 *   other error (insufficient funds, invalid address, ...) aborts immediately.
 * - The password is never taken from ctx.password or the environment: each
 *   sensitive invocation requires a fresh interactive confirmation.
 */
export async function withPasswordConfirm<T>(ctx: CommandContext, onVerify: (password: string) => T | Promise<T>, description: string): Promise<T | null> {
  if (!ctx.core.requirePassword()) return onVerify("");
  if (!ctx.askSecret && !ctx.interactive) {
    throw new Error(`${description} requires interactive wallet-password confirmation (run this command inside the console)`);
  }
  const ask = ctx.askSecret ?? ((prompt: string) => promptSecret(prompt));
  let lastError: unknown;
  for (let attempt = 0; attempt < PASSWORD_RETRY_LIMIT; attempt += 1) {
    const password = await ask(t("dialog.walletPassword"));
    if (password === null || password === "") return null;
    try {
      return await onVerify(password);
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.includes("Wrong wallet password")) throw error;
      ctx.log.warn(`${description}: wrong password (attempt ${attempt + 1}/${PASSWORD_RETRY_LIMIT})`);
    }
  }
  throw lastError ?? new Error(`${description}: password confirmation failed`);
}

export function builtinCommands(): Command[] {
  return [
    {
      name: "help",
      summary: () => t("cmd.summary.help"),
      usage: "help",
      run: (_args, ctx) => ctx.registry?.helpText() ?? t("cmd.helpUnavailable"),
    },
    {
      name: "info",
      aliases: ["getblockchaininfo", "chaininfo"],
      summary: () => t("cmd.summary.info"),
      usage: "info",
      run: async (_args, ctx) => {
        const info = await ctx.core.getChainInfo();
        return [
          t("cmd.info.network", { ticker: COIN_TICKER, connected: info.connectedNodes, total: ctx.core.getPeers().length }),
          t("cmd.info.height", { blocks: formatNumber(info.blocks), backend: formatNumber(info.backendHeight), pct: (info.syncProgress * 100).toFixed(1) }),
          t("cmd.info.phase", { phase: info.phase, reward: trimEDX(info.blockReward), ticker: COIN_TICKER, supply: trimEDX(info.supply) }),
          t("cmd.info.hashrate", { hashrate: formatNumber(info.networkPower) }),
        ].join("\n");
      },
    },
    {
      name: "balance",
      aliases: ["getbalance"],
      summary: () => t("cmd.summary.balance"),
      usage: "balance",
      run: async (_args, ctx) => {
        const detail = await ctx.core.getBalanceDetail();
        const balance = detail ? trimEDX(detail.available) : "--";
        const chainPart =
          detail && detail.reserved !== "0.00000000"
            ? t("cmd.balance.chain", { chain: trimEDX(detail.chain), reserved: trimEDX(detail.reserved) })
            : "";
        const immaturePart =
          detail && detail.immature !== "0.00000000"
            ? t("cmd.balance.immature", { amount: trimEDX(detail.immature), ticker: COIN_TICKER })
            : "";
        return `${t("cmd.balance.address", { address: ctx.core.getAddress() })}\n${t("cmd.balance.available", { balance, ticker: COIN_TICKER })}${chainPart}${immaturePart}\n${t("cmd.balance.peers", { connected: ctx.core.chain.connectedNodes, total: ctx.core.getPeers().length })}`;
      },
    },
    {
      name: "receive",
      aliases: ["address", "getnewaddress"],
      summary: () => t("cmd.summary.receive"),
      usage: "receive",
      run: (_args, ctx) => ctx.core.getAddress(),
    },
    {
      name: "newaddress",
      aliases: ["getnewaddress", "new"],
      summary: () => t("cmd.summary.newaddress"),
      usage: "newaddress",
      run: (_args, ctx) => ctx.core.getNewAddress(),
    },
    {
      name: "listaddresses",
      aliases: ["addresses", "getaddresses"],
      summary: () => t("cmd.summary.listaddresses"),
      usage: "listaddresses [count] [skip]",
      run: (_args, ctx) => {
        const all = ctx.core.walletAddresses();
        const count = _args[0] !== undefined ? parseCount(_args[0]) : 100;
        const skip = _args[1] !== undefined ? parseSkip(_args[1]) : 0;
        const page = all.slice(skip, skip + count);
        if (page.length === 0) return t("history.empty");
        const tail =
          skip + page.length < all.length
            ? `${t("cmd.listPaging", { start: skip + 1, end: skip + page.length, total: all.length })}`
            : "";
        return [...page, ...(tail ? [tail] : [])].join("\n");
      },
    },
    {
      name: "listunspent",
      aliases: ["utxos"],
      summary: () => t("cmd.summary.listunspent"),
      usage: "listunspent [minconf] [maxconf] [count] [skip]",
      run: async (args, ctx) => {
        const minconf = args[0] !== undefined && /^\d+$/.test(args[0]) ? Number(args[0]) : 0;
        const maxconf = args[1] !== undefined && /^\d+$/.test(args[1]) ? Number(args[1]) : 9999999;
        const count = args[2] !== undefined ? parseCount(args[2]) : 100;
        const skip = args[3] !== undefined ? parseSkip(args[3]) : 0;
        const all = await ctx.core.listUnspent(minconf, maxconf);
        if (all.length === 0) return t("history.empty");
        const utxos = all.slice(skip, skip + count);
        const lines = utxos
          .map((u) => `${truncateMiddle(u.txid, 16)}:${u.index}  ${trimEDX(u.amount)} ${COIN_TICKER} (${u.address})`);
        const tail =
          skip + utxos.length < all.length
            ? `${t("cmd.listPaging", { start: skip + 1, end: skip + utxos.length, total: all.length })}`
            : "";
        return [...lines, ...(tail ? [tail] : [])].join("\n");
      },
    },
    {
      name: "getwalletinfo",
      aliases: ["walletinfo"],
      summary: () => t("cmd.summary.getwalletinfo"),
      usage: "getwalletinfo",
      run: async (_args, ctx) => {
        const info = await ctx.core.getWalletInfo();
        const count = ctx.core.walletAddresses().length;
        return `${t("cmd.walletinfo.walletname", { name: info.walletname })}\n${t("cmd.walletinfo.addresses", { count })}\n${t("cmd.balance.available", { balance: trimEDX(info.balance), ticker: COIN_TICKER })}`;
      },
    },
    {
      name: "getbalances",
      aliases: ["balances"],
      summary: () => t("cmd.summary.getbalances"),
      usage: "getbalances",
      run: async (_args, ctx) => {
        const balances = await ctx.core.getBalances();
        return [
          t("cmd.balances.trusted", { amount: trimEDX(balances.mine.trusted), ticker: COIN_TICKER }),
          t("cmd.balances.pending", { amount: trimEDX(balances.mine.untrusted_pending), ticker: COIN_TICKER }),
          t("cmd.balances.immature", { amount: trimEDX(balances.mine.immature), ticker: COIN_TICKER }),
        ].join("\n");
      },
    },
    {
      name: "send",
      aliases: ["sendtoaddress"],
      summary: () => t("cmd.summary.send"),
      usage: () => t("cmd.usage.send"),
      run: async (args, ctx) => {
        if (args.length < 1) return t("cmd.usage", { usage: "send <address>:<amount> [<address>:<amount> ...]" });
        let payments: Array<{ address: string; amount: string }> = [];
        let extras: string[];
        if (!args[0].includes(":") && args.length >= 2 && AMOUNT_LIKE.test(args[1])) {
          payments = [{ address: args[0], amount: args[1] }];
          extras = args.slice(2);
        } else {
          extras = [];
          for (const arg of args) {
            const colon = arg.indexOf(":");
            if (colon <= 0 || colon === arg.length - 1) {
              extras.push(arg);
              continue;
            }
            payments.push({ address: arg.slice(0, colon), amount: arg.slice(colon + 1) });
          }
          if (payments.length === 0) {
            return t("cmd.usage", { usage: "send <address>:<amount> [<address>:<amount> ...]" });
          }
        }

        let password: string | undefined;
        const last = extras[extras.length - 1];
        if (last !== undefined && !isFeeTierName(last) && !AMOUNT_LIKE.test(last)) {
          password = last;
          extras = extras.slice(0, -1);
        }
        if (extras.length > 2) return "Too many arguments. Usage: send <address>:<amount> [<address>:<amount> ...] [fee] [slow|normal|fast] [password]";
        let explicitFee: string | null = null;
        let tier: string | null = null;
        const [feeArg, tierArg] = extras;
        if (feeArg !== undefined) {
          if (isFeeTierName(feeArg)) tier = feeArg;
          else explicitFee = feeArg;
        }
        if (tierArg !== undefined) tier = tierArg;


        const feeMissing = explicitFee === null && tier === null;
        const fees: FeeTiers | null = ctx.ask ? await ctx.core.getFees().catch(() => null) : null;
        if (feeMissing && ctx.ask) {
          const options: AskOption[] = FEE_TIER_NAMES.map((tierName) => ({
            value: tierName,
            label: fees ? t("cmd.send.tierOption", { tier: tierName, amount: trimEDX(fees[tierName]), ticker: COIN_TICKER }) : tierName,
          }));
          options.push({ value: "__custom__", label: t("cmd.send.customLabel") });
          const choice = await ctx.ask({
            type: "choice",
            prompt: t("cmd.send.feePrompt"),
            options,
            default: "normal",
          });
          if (choice === "") return t("cmd.send.cancelled");
          if (isFeeTierName(choice)) {
            tier = choice;
          } else if (choice === "__custom__") {
            explicitFee = await ctx.ask({ type: "text", prompt: t("cmd.send.feeAmountPrompt") });
            if (explicitFee === "") return t("cmd.send.cancelled");
            if (!AMOUNT_LIKE.test(explicitFee)) return `Invalid fee amount: ${explicitFee} (enter a number, e.g. 0.001)`;
          }
        }


        if (ctx.core.requirePassword() && password === undefined) {
          if (ctx.ask) {
            const totalSat = payments.reduce((sum, p) => sum + parseEDX(p.amount), 0n);
            const feeDesc =
              explicitFee !== null
                ? `${explicitFee} ${COIN_TICKER}`
                : tier !== null
                  ? t("dialog.tierLine", { tier, amount: trimEDX(fees?.[tier as FeeTierName] ?? ""), ticker: COIN_TICKER })
                  : t("cmd.send.feeDescAuto");
            const lines = [
              ...payments.map((r, i) =>
                t("dialog.recipientLine", {
                  n: i + 1,
                  addr: truncateMiddle(r.address, 40),
                  amount: trimEDX(r.amount),
                  ticker: COIN_TICKER,
                }),
              ),
              t("dialog.totalN", { n: payments.length, total: trimEDX(formatEDX(totalSat)), ticker: COIN_TICKER }),
              t("dialog.feeLine", { desc: feeDesc }),
            ];
            password = await ctx.ask({
              type: "password",
              prompt: t("cmd.send.passwordPrompt"),
              lines,
            });
            if (password === "") return t("cmd.send.cancelled");
          } else {
            const resolved = await resolvePassword(ctx);
            if (resolved === null) {
              return "Wallet locked: send requires a password (pass a <password> argument or set EDX_WALLET_PASSWORD)";
            }
            password = resolved;
          }
        }

        const txid = await ctx.core.send(payments, { explicitFee, tier }, password);
        const totalSat = payments.reduce((sum, p) => sum + parseEDX(p.amount), 0n);
        return t("cmd.send.submitted", { n: payments.length, total: trimEDX(formatEDX(totalSat)), ticker: COIN_TICKER, txid });
      },
    },
    {
      name: "mnemonic",
      aliases: ["showmnemonic", "seed"],
      summary: () => t("cmd.summary.mnemonic"),
      usage: () => t("cmd.usage.mnemonic"),
      run: async (args, ctx) => {
        if (!ctx.core.requirePassword()) {
          const mnemonic = ctx.core.getMnemonic("");
          return `${t("cmd.balance.address", { address: ctx.core.getAddress() })}\n${t("cmd.mnemonic.title")}\n  ${mnemonic}`;
        }
        const explicit = args[0];
        if (explicit !== undefined) {
          const mnemonic = ctx.core.getMnemonic(explicit);
          return `${t("cmd.balance.address", { address: ctx.core.getAddress() })}\n${t("cmd.mnemonic.title")}\n  ${mnemonic}`;
        }
        if (ctx.password !== undefined) {
          const mnemonic = ctx.core.getMnemonic(ctx.password);
          return `${t("cmd.balance.address", { address: ctx.core.getAddress() })}\n${t("cmd.mnemonic.title")}\n  ${mnemonic}`;
        }
        const result = await withPasswordConfirm(ctx, (password) => ctx.core.getMnemonic(password), "mnemonic export");
        if (result === null) return t("cmd.send.cancelled");
        return `${t("cmd.balance.address", { address: ctx.core.getAddress() })}\n${t("cmd.mnemonic.title")}\n  ${result}`;
      },
    },
    {
      name: "dumpprivkey",
      aliases: ["privkey"],
      summary: () => t("cmd.summary.dumpprivkey"),
      usage: "dumpprivkey <address>",
      run: async (args, ctx) => {
        const address = args[0]?.trim();
        if (!address) return t("cmd.usage", { usage: "dumpprivkey <address>" });
        if (!ctx.core.requirePassword()) return ctx.core.dumpPrivKey(address, "");
        if (args[1] !== undefined) return ctx.core.dumpPrivKey(address, args[1]);
        if (ctx.password !== undefined) return ctx.core.dumpPrivKey(address, ctx.password);
        const result = await withPasswordConfirm(ctx, (password) => ctx.core.dumpPrivKey(address, password), `private key export for ${truncateMiddle(address, 16)}`);
        if (result === null) return t("cmd.send.cancelled");
        return result;
      },
    },
    {
      name: "history",
      aliases: ["listtransactions", "txs"],
      summary: () => t("cmd.summary.history"),
      usage: () => t("cmd.usage.history"),
      run: async (args, ctx) => {
        const count = args[0] !== undefined ? parseCount(args[0], 20) : 20;
        const skip = args[1] !== undefined ? parseSkip(args[1]) : 0;
        const txs = await ctx.core.listTransactions(count, skip);
        if (txs.length === 0) return t("history.empty");
        const header = padCJK(t("history.colTime"), 20) + padCJK(t("history.colType"), 4) + padCJK(t("history.colAmount"), 12) + padCJK(t("history.colFee"), 10) + padCJK(t("history.colStatus"), 7) + padCJK(t("history.colConfirm"), 4) + "txid";
        const lines = txs.map((tx) => {
          const amount = `${tx.category === "send" ? "-" : "+"}${trimEDX(tx.amount)}`;
          return (
            padCJK(fmtTime(tx.time), 20) +
            padCJK(txTypeLabel(tx), 4) +
            padCJK(amount, 12) +
            padCJK(trimEDX(tx.fee), 10) +
            padCJK(txStatusLabel(tx), 7) +
            padCJK(txConfirmText(tx), 4) +
            truncateMiddle(tx.txid, 12)
          );
        });
        const hint = txs.some((tx) => tx.matureAtHeight !== null)
          ? t("history.maturityHint", { n: MINING_MATURITY_CONFIRMATIONS })
          : null;
        const more = txs.length === count ? t("cmd.historyMore", { count, skip: skip + count }) : null;
        return [header, ...lines, ...(hint ? [hint] : []), ...(more ? [more] : [])].join("\n");
      },
    },
    {
      name: "tx",
      aliases: ["gettransaction"],
      summary: () => t("cmd.summary.tx"),
      usage: "tx <txid>",
      run: async (args, ctx) => {
        if (args.length < 1) return t("cmd.usage", { usage: "tx <txid>" });
        const tx = await ctx.core.getTransaction(args[0]);
        if (!tx) return t("history.empty");
        const inputLines = tx.inputs.map(
          (input) => `  ${input.txid}:${input.index} ${trimEDX(input.amount)} ${COIN_TICKER}`,
        );
        const outputLines = tx.outputs.map((output) => {
          const label = output.isChange
            ? t("dialog.change")
            : tx.type === "mining"
              ? t("dialog.miningReward")
              : t("dialog.receive");
          return t("dialog.outputLine", {
            label,
            address: output.address,
            sign: output.isChange ? "" : "+",
            amount: trimEDX(output.amount),
            ticker: COIN_TICKER,
          });
        });
        return [
          `txid: ${tx.txid}`,
          `${t("dialog.txType", { label: txTypeLabel(tx) })} | ${t("dialog.txAmount", {
            sign: tx.category === "send" ? "-" : "+",
            amount: trimEDX(tx.amount),
            ticker: COIN_TICKER,
          })} | ${t("cmd.tx.fee", { fee: trimEDX(tx.fee), ticker: COIN_TICKER })}`,
          t("cmd.tx.status", { status: txStatusLabel(tx), confirm: txConfirmText(tx), height: tx.height ?? "-" }),
          ...(txMaturityLine(tx) ? [txMaturityLine(tx)!] : []),
          t("dialog.txTime", { time: fmtTime(tx.time) }),
          ...(inputLines.length > 0 ? [t("cmd.tx.inputs"), ...inputLines] : []),
          t("cmd.tx.outputs"),
          ...outputLines,
        ].join("\n");
      },
    },
    {
      name: "peers",
      aliases: ["getpeerinfo", "network"],
      summary: () => t("cmd.summary.peers"),
      usage: "peers",
      run: async (_args, ctx) => {
        const peers = ctx.core.getPeers();
        const connected = peers.filter((p) => p.connected).length;
        const lines = [t("cmd.peers.title", { connected, total: peers.length })];
        for (const p of peers) {
          const source = p.source === "config" ? "" : p.source === "runtime" ? t("cmd.peer.runtime") : t("cmd.peer.discovered");
          const status = p.connected ? t("peer.connected") : t("peer.disconnected");
          const latency = p.latencyMs !== null ? t("cmd.peer.latency", { ms: p.latencyMs }) : "";
          lines.push(`${p.id} ${p.addr} ${source}${status}${latency}`);
        }
        return lines.join("\n");
      },
    },
    {
      name: "addnode",
      aliases: ["connect"],
      summary: () => t("cmd.summary.addnode"),
      usage: "addnode <host:port>",
      run: async (args, ctx) => {
        const addr = args[0]?.trim();
        if (!addr) return t("cmd.usage", { usage: "addnode <host:port> (e.g. 127.0.0.1:28333)" });
        const view = ctx.core.conn.addNode(addr);
        return t("cmd.addnode.added", { addr: view.addr, status: view.connected ? t("peer.connected") : t("peer.disconnected") });
      },
    },
    {
      name: "fees",
      aliases: ["estimatesmartfee"],
      summary: () => t("cmd.summary.fees"),
      usage: "fees",
      run: async (_args, ctx) => {
        const fees = await ctx.core.getFees(true);
        const recommended = isFeeTierName(fees.recommended) ? fees.recommended : "normal";
        const congestion = typeof fees.pendingCount === "number" ? String(fees.pendingCount) : "-";
        return `${t("cmd.fees.line", { slow: trimEDX(fees.slow), normal: trimEDX(fees.normal), fast: trimEDX(fees.fast), ticker: COIN_TICKER })}\n${t("cmd.fees.recommended", { recommended, congestion })}`;
      },
    },
    {
      name: "sync",
      summary: () => t("cmd.summary.sync"),
      usage: "sync",
      run: async (_args, ctx) => {
        await ctx.core.refreshAll();
        const info = ctx.core.chain.toView();
        const statusLabel =
          info.syncStatus === "synced"
            ? t("sync.synced")
            : info.syncStatus === "error"
              ? t("sync.error")
              : t("sync.syncing");
        return t("cmd.sync.done", {
          status: statusLabel,
          local: formatNumber(info.localHeight),
          backend: formatNumber(info.backendHeight),
          pct: (info.syncProgress * 100).toFixed(1),
          balance: trimEDX(await ctx.core.getBalance()),
          ticker: COIN_TICKER,
          connected: info.connectedNodes,
        });
      },
    },
    {
      name: "resync",
      aliases: ["reindex"],
      summary: () => t("cmd.summary.resync"),
      usage: "resync",
      run: async (_args, ctx) => {
        if (ctx.ask) {
          const confirm = await ctx.ask({
            type: "choice",
            prompt: t("cmd.resync.confirmPrompt"),
            options: [
              { value: "yes", label: t("cmd.resync.confirmYes") },
              { value: "no", label: t("cmd.resync.confirmNo") },
            ],
            default: "no",
          });
          if (confirm !== "yes") return t("cmd.resync.cancelled");
        }
        await ctx.core.resync();
        return t("cmd.resync.done");
      },
    },
    {
      name: "stop",
      aliases: ["quit"],
      summary: () => t("cmd.summary.stop"),
      usage: "stop",
      run: (_args, ctx) => {
        ctx.core.requestStop();
        return t("cmd.stop.stopping");
      },
    },
    {
      name: "lang",
      aliases: ["language"],
      summary: () => t("cmd.lang.summary"),
      usage: "lang [zh|en|ru|ja]",
      run: (args, ctx) => {
        const current = getLang();
        if (args.length === 0) {
          return t("cmd.lang.current", { label: LANG_BUTTON_LABEL[current], lang: current });
        }
        const want = args[0].toLowerCase();
        const next: Lang | null = LANG_ORDER.includes(want as Lang) ? (want as Lang) : null;
        if (next === null) {
          return t("cmd.lang.invalid", { want: args[0], langs: LANG_ORDER.join("|") });
        }
        setLang(next);
        if (ctx.datadir) saveLang(ctx.datadir, next);
        return t("cmd.lang.switched", { label: LANG_BUTTON_LABEL[next] });
      },
    },
  ];
}
