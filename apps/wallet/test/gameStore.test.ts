import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameStore } from "../src/game/gameStore";

function store(): GameStore {
  return new GameStore(mkdtempSync(join(tmpdir(), "edgex-game-")));
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    gameId: "snake",
    kind: "score",
    uploadId: "u1",
    name: "alice",
    score: 120,
    wave: 3,
    lives: 2,
    payload: null,
    txid: "tx1",
    createdAt: 1,
    ...overrides,
  };
}

describe("game store", () => {
  test("inserts idempotently and finds by (gameId, uploadId)", () => {
    const s = store();
    s.insert(record());
    s.insert(record({ name: "mallory" })); // same uploadId ignored, first row kept
    const found = s.findByUploadId("snake", "u1");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("alice");
    expect(found!.score).toBe(120);
    expect(found!.txid).toBe("tx1");
    expect(s.findByUploadId("snake", "other")).toBeNull();
    expect(s.findByUploadId("snake", "")).toBeNull();
    s.close();
  });

  test("leaderboard orders by score descending and excludes save records", () => {
    const s = store();
    s.insert(record({ uploadId: "a", name: "low", score: 10, createdAt: 1 }));
    s.insert(record({ uploadId: "b", name: "high", score: 300, createdAt: 2 }));
    s.insert(record({ uploadId: "c", name: "mid", score: 40, createdAt: 3 }));
    s.insert(
      record({
        uploadId: "s1",
        kind: "save",
        name: null,
        score: null,
        wave: null,
        lives: null,
        payload: "envelope",
        createdAt: 4,
      }),
    );
    const rows = s.leaderboard("snake", 10);
    expect(rows.map((row) => row.score)).toEqual([300, 40, 10]);
    expect(rows.map((row) => row.name)).toEqual(["high", "mid", "low"]);
    // Leaderboard must not leak save payloads
    expect((rows[0] as { payload?: unknown }).payload).toBeUndefined();
    s.close();
  });

  test("findSave returns the latest save for a game", () => {
    const s = store();
    s.insert(record({ uploadId: "old", kind: "save", payload: "old-envelope", createdAt: 5 }));
    s.insert(record({ uploadId: "new", kind: "save", payload: "new-envelope", createdAt: 9 }));
    const save = s.findSave("snake");
    expect(save).not.toBeNull();
    expect(save!.uploadId).toBe("new");
    expect(save!.payload).toBe("new-envelope");
    // Save records do not affect the leaderboard
    expect(s.leaderboard("snake", 10)).toEqual([]);
    expect(s.findSave("other-game")).toBeNull();
    s.close();
  });
});