import { describe, expect, test } from "bun:test";
import { helpText } from "./helpText";
import { VERSION } from "../updater/versionCheck";

const HELP = helpText();

describe("help text", () => {
  test("headers carry the version and the program identity", () => {
    expect(HELP).toContain(`EdgeX Network Wallet (EDX) v${VERSION}`);
    expect(HELP).toContain("Usage:");
  });

  test("documents the three launch modes and their first-run behaviour", () => {
    expect(HELP).toContain("edgex-wallet console | cli");
    expect(HELP).toContain("edgex-wallet daemon");
    expect(HELP).toContain("edgex-wallet init");
    expect(HELP).toContain("interactive first run");
    expect(HELP).toContain("run `init` first");
  });

  test("covers global options, password precedence and its caveats", () => {
    expect(HELP).toContain("-conf=");
    expect(HELP).toContain("-datadir=");
    expect(HELP).toContain("-password=SECRET");
    expect(HELP).toContain("EDX_WALLET_PASSWORD");
    expect(HELP).toContain("never stored in");
    expect(HELP).toContain("process list / shell history");
    expect(HELP).toContain("interactive password confirmation");
  });

  test("documents the update command and the updates policy", () => {
    expect(HELP).toContain("edgex-wallet update");
    expect(HELP).toContain("Updates:");
    expect(HELP).toContain("silent background update check");
    expect(HELP).toContain("-dev / --dev");
    expect(HELP).toContain("local `version` file");
  });

  test("documents the data directory layout", () => {
    expect(HELP).toContain("Data directory:");
    expect(HELP).toContain("EDX_DATA");
    expect(HELP).toContain("wallet.vault");
    expect(HELP).toContain("dexcoin.conf");
    expect(HELP).toContain("chain.db");
    expect(HELP).toContain("dexcoin.log");
  });

  test("contains no i18n placeholder leftovers", () => {
    // Help is intentionally English and static: a leftover {placeholder} from
    // a translation key would indicate a template slipped into the text.
    expect(HELP).not.toMatch(/\{[a-zA-Z.]+\}/);
  });
});
