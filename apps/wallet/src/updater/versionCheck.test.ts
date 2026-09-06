import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  VERSION,
  parseVersion,
  classifyUpdate,
  readLocalVersionFile,
  fetchLatestVersion,
  nullVersionSource,
  LOCAL_VERSION_FILE,
} from "./versionCheck";

describe("parseVersion", () => {
  test("parses plain and v-prefixed versions", () => {
    expect(parseVersion("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion("v2.3.4")).toEqual({ major: 2, minor: 3, patch: 4 });
    expect(parseVersion("  v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("rejects unparseable input", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("1.2.3.4")).toBeNull();
  });
});

describe("classifyUpdate", () => {
  test("no update when current equals or exceeds latest", () => {
    expect(classifyUpdate("1.0.0", "1.0.0").kind).toBe("none");
    expect(classifyUpdate("1.0.1", "1.0.0").kind).toBe("none");
    expect(classifyUpdate("2.0.0", "1.9.9").kind).toBe("none");
  });

  test("minor update when the major matches and minor/patch is higher", () => {
    expect(classifyUpdate("1.0.0", "1.1.0").kind).toBe("minor");
    expect(classifyUpdate("1.0.0", "1.0.1").kind).toBe("minor");
  });

  test("major update when the latest major is higher", () => {
    expect(classifyUpdate("1.5.0", "2.0.0").kind).toBe("major");
  });

  test("failed parses never classify as an update", () => {
    expect(classifyUpdate("broken", "1.0.0").kind).toBe("none");
    expect(classifyUpdate("1.0.0", "broken").kind).toBe("none");
  });
});

describe("local version file", () => {
  test("reads a version file from the given directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "edgex-version-"));
    try {
      writeFileSync(join(dir, LOCAL_VERSION_FILE), "v9.9.9\n");
      expect(readLocalVersionFile(dir)).toBe("v9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the file is missing or empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "edgex-version-"));
    try {
      expect(readLocalVersionFile(dir)).toBeNull();
      writeFileSync(join(dir, LOCAL_VERSION_FILE), "   \n");
      expect(readLocalVersionFile(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fetchLatestVersion", () => {
  test("development mode reads the local version file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edgex-version-"));
    try {
      writeFileSync(join(dir, LOCAL_VERSION_FILE), "2.0.0");
      const latest = await fetchLatestVersion(true, nullVersionSource, dir);
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe("2.0.0");
      expect(latest!.url).toContain("github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("production mode stays offline and returns null without a source", async () => {
    expect(await fetchLatestVersion(false, nullVersionSource)).toBeNull();
  });

  test("production mode delegates to a supplied remote source", async () => {
    const source = async () => ({ version: "v3.0.0", url: "https://example.invalid/releases" });
    const latest = await fetchLatestVersion(false, source);
    expect(latest).toEqual({ version: "v3.0.0", url: "https://example.invalid/releases" });
  });
});

describe("VERSION constant", () => {
  test("is a parseable semantic version", () => {
    expect(parseVersion(VERSION)).not.toBeNull();
  });
});
