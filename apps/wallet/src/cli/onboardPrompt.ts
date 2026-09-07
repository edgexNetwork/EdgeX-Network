import { createOrLoadKey, type WalletKey } from "../keys/walletKeyClean";
import { isValidMnemonic } from "../keys/mnemonic";
import { MIN_PASSWORD_LENGTH, promptLine, promptSecret, vaultFilePath } from "../keys/vaultLegacy";
import { t } from "../i18n";

/**
 * Text-mode first-run wallet onboarding for the console and daemon entry
 * points.
 *
 * The Ink onboarding screen is only available inside the TUI. When the wallet
 * starts without a TUI (the interactive line console, the headless daemon, or
 * a TUI that degraded to the console) and the data directory has no wallet
 * yet, this module walks the user through the same create/import steps in
 * plain text instead of failing with "run init first".
 *
 * Semantics match the TUI onboarding and `init`:
 * - create: a fresh random mnemonic is generated;
 * - import: an existing mnemonic is entered and restored.
 * Both paths set a new password and persist a binary-encrypted wallet.vault
 * (scrypt + AES-256-GCM). A freshly created mnemonic is printed exactly once,
 * on this screen, mirroring the backup step of the other entry points.
 *
 * The flow only runs on an interactive terminal (stdin and stdout both TTY);
 * on a non-TTY (pipe/script/service) it returns null and the caller keeps its
 * "run init first" error. When the user cancels (empty answer / EOF) an
 * OnboardCancelledError is thrown and the caller should exit with code 0,
 * matching the Ctrl+C behaviour of the TUI onboarding.
 */

/** Raised when the user abandons the onboarding flow (empty answer / EOF).
 *  Callers treat it as a clean exit, not a failure. */
export class OnboardCancelledError extends Error {
  constructor() {
    super("Onboarding cancelled");
    this.name = "OnboardCancelledError";
  }
}

/** Result of parsing the create/import choice line. */
export type OnboardChoice = "create" | "import" | "cancel" | "invalid";

/** Parse the mode-choice input: 1=create, 2=import, empty=cancel, anything else=invalid. */
export function parseOnboardChoice(input: string): OnboardChoice {
  const value = input.trim();
  if (value === "") return "cancel";
  if (value === "1") return "create";
  if (value === "2") return "import";
  return "invalid";
}

/** Injectable I/O boundary for the onboarding flow. The default binds the real
 *  terminal; tests substitute scripted answer queues. */
export interface OnboardHooks {
  /** Whether the flow is allowed to prompt interactively. */
  isTty: () => boolean;
  /** Print one informational/interface line (console.log style). */
  out: (line: string) => void;
  /** Read one visible line of input (choice / mnemonic / press-Enter). */
  line: (prompt: string) => Promise<string>;
  /** Read one hidden password input (both setup passes are looped here). */
  secret: (prompt: string) => Promise<string>;
}

/** Real-terminal hooks: TTY probe plus the vault prompt helpers. */
export function realOnboardHooks(): OnboardHooks {
  return {
    isTty: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (line) => console.log(line),
    line: (prompt) => promptLine(prompt),
    secret: (prompt) => promptSecret(prompt),
  };
}

export interface CliOnboardResult {
  key: WalletKey;
  /** The password chosen during onboarding, reused for the running session
   *  (same semantics as a password entered at load time). */
  password: string;
  created: boolean;
}

export interface CliOnboardOptions {
  datadir: string;
  hooks?: OnboardHooks;
}

/** Password setup loop: minimum length, then two matching entries; repeats on failure. */
async function promptNewPassword(hooks: OnboardHooks): Promise<string> {
  for (;;) {
    const first = await hooks.secret(t("prompt.newPassword", { min: MIN_PASSWORD_LENGTH }));
    if (first.length < MIN_PASSWORD_LENGTH) {
      hooks.out(`Password must be at least ${MIN_PASSWORD_LENGTH} characters; try again`);
      continue;
    }
    const second = await hooks.secret(t("prompt.confirmPassword"));
    if (first !== second) {
      hooks.out("Passwords do not match; try again");
      continue;
    }
    return first;
  }
}

/** Mnemonic entry loop for import: validates BIP39; an empty entry cancels. */
async function promptImportMnemonic(hooks: OnboardHooks): Promise<string> {
  for (;;) {
    const mnemonic = await hooks.line(t("prompt.mnemonic"));
    if (mnemonic.trim() === "") throw new OnboardCancelledError();
    if (isValidMnemonic(mnemonic)) return mnemonic;
    hooks.out("Invalid BIP39 mnemonic; check the words and spelling, try again");
  }
}

/** Print the summary shown after a successful create or import. */
function printSummary(hooks: OnboardHooks, datadir: string, key: WalletKey): void {
  hooks.out(`  ${t("ui.address")}: ${key.address}`);
  hooks.out(`${t("onboard.walletFile")}${vaultFilePath(datadir)}${t("onboard.binaryEncrypted")}`);
  hooks.out("");
}

/**
 * Run the text-mode first-run onboarding.
 * - Non-interactive terminal -> null (the caller keeps its init error).
 * - User cancels -> throws OnboardCancelledError (no wallet file is written).
 * - Success -> { key, password, created: true } (a new vault has been written).
 */
export async function runCliOnboarding(opts: CliOnboardOptions): Promise<CliOnboardResult | null> {
  const hooks = opts.hooks ?? realOnboardHooks();
  if (!hooks.isTty()) return null;

  hooks.out("");
  hooks.out(t("onboard.title"));
  hooks.out(t("onboard.datadir", { dir: opts.datadir }));
  hooks.out(t("ob.noWallet"));
  hooks.out("");
  hooks.out(`  1) ${t("onboard.create")}`);
  hooks.out(`  2) ${t("onboard.import")}`);

  let choice: OnboardChoice;
  for (;;) {
    const parsed = parseOnboardChoice(await hooks.line(t("ob.modeAsk")));
    if (parsed === "cancel") {
      hooks.out(t("ob.aborted"));
      throw new OnboardCancelledError();
    }
    if (parsed === "invalid") {
      hooks.out(t("ob.invalidChoice"));
      continue;
    }
    choice = parsed;
    break;
  }

  const password = await promptNewPassword(hooks);
  const result = createOrLoadKey(opts.datadir, {
    password,
    mnemonic: choice === "import" ? await promptImportMnemonic(hooks) : undefined,
  });
  hooks.out("");
  if (choice === "import") {
    hooks.out("Wallet restored");
    hooks.out("");
    printSummary(hooks, opts.datadir, result.key);
  } else {
    // Fresh create: the mnemonic is shown once for offline backup, then the
    // user presses Enter to continue into the wallet.
    hooks.out(t("onboard.backupTitle"));
    hooks.out(t("onboard.backupHint"));
    hooks.out(t("onboard.backupWarn"));
    hooks.out("");
    hooks.out(`  ${result.key.mnemonic}`);
    hooks.out("");
    printSummary(hooks, opts.datadir, result.key);
    hooks.out(t("onboard.enterToContinue"));
    await hooks.line("");
  }
  return { key: result.key, password, created: result.created };
}
