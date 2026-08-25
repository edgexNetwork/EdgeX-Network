



export type RawConf = Map<string, string[]>;

export function parseConf(text: string): RawConf {
  const map: RawConf = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "") continue;
    const arr = map.get(key) ?? [];
    arr.push(value);
    map.set(key, arr);
  }
  return map;
}

export function confGet(conf: RawConf, key: string): string | undefined {
  const arr = conf.get(key);
  return arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
}

export function confGetAll(conf: RawConf, key: string): string[] {
  return conf.get(key) ?? [];
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function confGetBool(conf: RawConf, key: string, def: boolean): boolean {
  const v = confGet(conf, key);
  if (v === undefined) return def;
  if (TRUE_VALUES.has(v.toLowerCase())) return true;
  if (FALSE_VALUES.has(v.toLowerCase())) return false;
  return def;
}

export function confGetInt(conf: RawConf, key: string, def: number): number {
  const v = confGet(conf, key);
  if (v === undefined) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}


export function confGetIntOpt(conf: RawConf, key: string): number | undefined {
  const v = confGet(conf, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}