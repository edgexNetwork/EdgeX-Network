import { describe, expect, test } from "bun:test";
import { parseCliPaths } from "./config";

describe("parseCliPaths", () => {
  test("parses bitcoin-style path flags and strips them from the rest", () => {
    const { paths, rest } = parseCliPaths([
      "-datadir=/tmp/data",
      "-conf=/tmp/custom.conf",
      "daemon",
    ]);
    expect(paths).toEqual({ datadir: "/tmp/data", conf: "/tmp/custom.conf" });
    expect(rest).toEqual(["daemon"]);
  });

  test("parses -dev and --dev into the dev flag", () => {
    expect(parseCliPaths(["-dev"]).paths).toEqual({ dev: true });
    expect(parseCliPaths(["--dev"]).paths).toEqual({ dev: true });
  });

  test("parses -password=SECRET into paths.password without leaking into argv", () => {
    const { paths, rest } = parseCliPaths(["-password=correct-horse", "daemon"]);
    expect(paths.password).toBe("correct-horse");
    expect(rest).toEqual(["daemon"]);
  });

  test("treats the secret as data even when it contains '='", () => {
    const { paths } = parseCliPaths(["-password=a=b=c"]);
    expect(paths.password).toBe("a=b=c");
  });

  test("leaves unknown arguments in the rest for command dispatch", () => {
    const { paths, rest } = parseCliPaths(["balance", "-datadir=/x"]);
    expect(paths.datadir).toBe("/x");
    expect(rest).toEqual(["balance"]);
  });
});
