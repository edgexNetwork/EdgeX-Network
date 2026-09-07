import { VERSION } from "../updater/versionCheck";

/**
 * The --help / -h text, kept as a pure string function so unit tests can
 * assert its contents. The entry point prints it to stdout.
 *
 * Help is intentionally static English (system help/errors follow the project
 * rule of staying in English rather than going through the i18n layer).
 */
export function helpText(): string {
  return `EdgeX Network Wallet (EDX) v${VERSION}

Usage:
  edgex-wallet                       Start the full TUI. When the data directory has no wallet yet, an
                                       onboarding screen walks you through creating or importing one.
  edgex-wallet console | cli         Start the interactive line console (edx> ). An interactive first run
                                       with no wallet walks you through the same create/import steps in plain
                                       text; on a non-interactive terminal run \`init\` first instead.
  edgex-wallet daemon                Start headless (services stay active; no UI). An interactive first run
                                       with no wallet prompts in plain text; when stdin/stdout are not a
                                       terminal, or a startup password was supplied but no wallet exists, it
                                       exits and asks you to run \`init\` first.
  edgex-wallet init                  Create a wallet (interactive password setup; mnemonic shown at creation)
  edgex-wallet init --restore        Import a wallet (interactive mnemonic entry + password setup)
  edgex-wallet init --restore "mnemonic..."  Restore a wallet from a given mnemonic (set a new password)
  edgex-wallet <command> [args...]   Run one command (balance, send, history, ...)
  edgex-wallet update                Check for updates. When installed via the official install command the
                                       update is applied in the background and the wallet restarts; otherwise
                                       the release page is printed for a manual download.

Global options:
  -conf=FILE       Configuration path (default <datadir>/dexcoin.conf)
  -datadir=DIR     Data directory (default ./EDX_DATA)
  -password=SECRET Wallet password for this process only. Priority: -password= > EDX_WALLET_PASSWORD >
                   interactive prompt. It only decrypts wallet.vault at load time; it is never stored in
                   dexcoin.conf, never logged, and shows up in the process list / shell history, so only
                   use it in controlled/scripted scenarios. Sensitive commands (send, mnemonic, private-key
                   export) always require an interactive password confirmation and ignore this option.
  -dev / --dev     Development mode: update checks read a local \`version\` file next to the working
                   directory instead of a remote release source.
  --help / --version

Environment:
  EDX_WALLET_PASSWORD   Wallet password for unattended startup (daemon / one-shot). It decrypts
                        wallet.vault at load time only (lower priority than -password=); it is not a
                        substitute for the interactive confirmation required by sensitive commands.

Updates:
  Each launch mode performs one silent background update check after startup and reports a new version
  as a log line (daemon), a console message, or the TUI logs tab - it never interrupts you. Run
  \`edgex-wallet update\` to apply an update. Development mode (-dev) compares against the local
  \`version\` file; stock builds stay offline unless a distribution build supplies a release source.

Commands:
  help | info | balance | receive | history [count] [skip] | tx <txid>
  listaddresses [count] [skip] | listunspent [minconf] [maxconf] [count] [skip]
  send <address>:<amount> [...] [fee] [slow|normal|fast] [password]
  mnemonic [password] | dumpprivkey <address> [password]
  peers | addnode <http://host:port> | fees | sync | update | stop
  lang [zh|en|ru|ja]

Data directory:
  Default ./EDX_DATA. Wallet file wallet.vault (binary encrypted, scrypt + AES-256-GCM); the mnemonic
  requires the wallet password to view. dexcoin.conf holds RPC/P2P/game settings; chain.db is the local
  blockchain mirror; dexcoin.log holds the process log.
`;
}
