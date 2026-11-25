import { describe, expect, test } from "bun:test";
import { buildings, canMove, collectEvidence, evidence, freshCampaign, parseCampaign, submitVerdict, HQ, CAR } from "../src/game/campaign/sanFierro";

describe("browser San Fierro campaign", () => {
  test("verdict requires all evidence, and collection is idempotent", () => {
    let state = freshCampaign();
    expect(submitVerdict(state, "accept").verdict).toBeNull();
    state = collectEvidence(state, "witness");
    expect(collectEvidence(state, "witness")).toBe(state);
    for (const e of evidence) state = collectEvidence(state, e.id);
    const completed = submitVerdict(state, "abstain");
    expect(completed.verdict).toBe("abstain");
    expect(submitVerdict(completed, "accept")).toBe(completed);
    expect(parseCampaign(JSON.stringify(completed))).toEqual(completed);
  });
  test("malformed and impossible saves cannot skip collection", () => {
    for (const value of [null, "{", "[]", '{"version":2}', '{"version":1,"collected":null}']) expect(parseCampaign(value)).toEqual(freshCampaign());
    expect(parseCampaign('{"version":1,"collected":["witness","witness","fake"],"verdict":"accept"}')).toEqual({ version: 1, collected: ["witness"], verdict: null });
  });
  test("every interaction is on a walkable street, buildings and boundary block motion", () => {
    for (const p of [...evidence, HQ, CAR]) {
      expect(canMove(p.x, p.z)).toBe(true);
      expect(canMove(p.x, p.z, 1.5)).toBe(true);
    }
    for (const b of buildings) expect(canMove(b.x, b.z)).toBe(false);
    expect(canMove(47, 0)).toBe(false);
  });
});
