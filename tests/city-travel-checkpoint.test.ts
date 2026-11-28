import { describe, expect, test } from "bun:test";
import { confirmTravelCheckpoint } from "../src/game/campaign/travelCheckpoint";

const encode = JSON.stringify;
type Record = { revision: number; decision: string };
const parse = (raw: string | null): Record =>
  raw ? JSON.parse(raw) : { revision: 0, decision: "" };
const latest = { revision: 3, decision: "next mission" };

function storage(initial: Record | null, mode: "normal" | "throw" | "ignore" = "normal") {
  let raw = initial ? encode(initial) : null;
  return {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      if (mode === "throw") throw new Error("QuotaExceededError");
      if (mode === "normal") raw = value;
    },
    removeItem: () => {
      raw = null;
    },
  };
}

describe("cross-page city campaign checkpoint", () => {
  const verify = (disk: ReturnType<typeof storage> | null, active = latest) =>
    confirmTravelCheckpoint(disk, "city", active, parse, (r) => r.revision, encode);

  test("blocked storage, quota errors and silently dropped saves cannot navigate", () => {
    expect(verify(null)).toBe(false);
    expect(verify(storage(latest, "throw"))).toBe(false);
    expect(verify(storage({ revision: 2, decision: "before handoff" }, "ignore"))).toBe(false);
  });

  test("an optional exit can verify an existing exact save without writing", () => {
    const exit = (disk: ReturnType<typeof storage>) =>
      confirmTravelCheckpoint(disk, "city", latest, parse, (r) => r.revision, encode, false);
    expect(exit(storage(latest, "throw"))).toBe(true);
    expect(exit(storage({ revision: 2, decision: "old" }, "throw"))).toBe(false);
    expect(exit(storage({ revision: 3, decision: "different" }, "throw"))).toBe(false);
  });

  test("a retry saves the exact retained checkpoint once storage works", () => {
    const disk = storage({ revision: 2, decision: "before handoff" });
    expect(verify(disk)).toBe(true);
    expect(disk.getItem()).toBe(encode(latest));
    expect(verify(disk)).toBe(true);
  });

  test("navigation never overwrites a newer or conflicting checkpoint", () => {
    for (const resident of [
      { revision: 4, decision: "other tab" },
      { revision: 3, decision: "conflict" },
    ]) {
      const disk = storage(resident);
      expect(verify(disk)).toBe(false);
      expect(disk.getItem()).toBe(encode(resident));
    }
  });
});
