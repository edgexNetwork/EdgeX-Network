import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Version identity and optional update classification for the wallet.
 *
 * Version policy (kept intentionally simple for a local-first wallet):
 * - The wallet itself never phones home. Update checks are opt-in and run
 *   only in development (`-dev`) mode, where the "latest" version is read
 *   from a plain `version` file next to the working directory.
 * - A remote release source can be supplied by the caller (e.g. a packaged
 *   build that wants to point at its own distribution channel); the default
 *   is null so a stock build never performs any network request.
 */

/** The wallet's own version - the single source of truth for every surface
 *  that reports it (--version output, help header, RPC subversion, TUI
 *  settings page, console banner). */
export const VERSION = "2.0.0";

/** Remote release lookup is disabled by default: a stock build stays offline. */
export const GITHUB_REPO = "edgexNetwork/EdgeX-Network";

/** The release page URL used when the remote source reports a version. */
export const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

/** Local development version source file name (read from the working directory). */
export const LOCAL_VERSION_FILE = "version";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export type UpdateKind = "none" | "minor" | "major";

export interface LatestVersionResult {
  /** Latest version string (may carry a "v" prefix, e.g. "v1.2.0"). */
  version: string;
  /** Human-facing release page address. */
  url: string;
}

/** Parse a version string (optional "v" prefix) into numeric parts; null when unparseable. */
export function parseVersion(value: string): SemVer | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?![\d.])/.exec(value ?? "");
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Classify the update relationship of the current version against the latest:
 * - "none":  current is the same or newer;
 * - "minor": same major version, higher minor/patch (1.X.X style update);
 * - "major": higher major version (X.X.X style update).
 * A failed parse on either side yields "none".
 */
export function classifyUpdate(
  current: string,
  latest: string,
): { kind: UpdateKind; currentVer: SemVer | null; latestVer: SemVer | null } {
  const currentVer = parseVersion(current);
  const latestVer = parseVersion(latest);
  if (!currentVer || !latestVer) return { kind: "none", currentVer, latestVer };
  if (latestVer.major > currentVer.major) return { kind: "major", currentVer, latestVer };
  if (
    latestVer.major === currentVer.major &&
    (latestVer.minor > currentVer.minor || (latestVer.minor === currentVer.minor && latestVer.patch > currentVer.patch))
  ) {
    return { kind: "minor", currentVer, latestVer };
  }
  return { kind: "none", currentVer, latestVer };
}

/**
 * A remote latest-version source. Returns null when the latest version cannot
 * be determined (network failure, non-200 response, no release tag).
 */
export type LatestVersionSource = () => Promise<LatestVersionResult | null>;

/**
 * Default remote source: always unavailable. A stock build performs no network
 * request; distribution-specific builds pass their own source to
 * fetchLatestVersion.
 */
export const nullVersionSource: LatestVersionSource = async () => null;

/** Read the local development version file (cwd/version); null when missing, empty or unreadable. */
export function readLocalVersionFile(cwd: string = process.cwd()): string | null {
  try {
    const raw = readFileSync(path.join(cwd, LOCAL_VERSION_FILE), "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the latest version:
 * - dev is true: read the local `version` file (cwd); null when absent.
 * - otherwise: query the supplied remote source (default: none, staying offline).
 * Returns null when the latest version cannot be determined.
 */
export async function fetchLatestVersion(
  dev: boolean,
  source: LatestVersionSource = nullVersionSource,
  cwd: string = process.cwd(),
): Promise<LatestVersionResult | null> {
  if (dev) {
    const version = readLocalVersionFile(cwd);
    if (!version) return null;
    return { version, url: RELEASES_URL };
  }
  return source();
}
