export const CAMPAIGN_KEY = "99sure.browser.campaign.v1";
export const evidence = [
  { id: "witness", title: "Witness statement", x: -24, z: 0, detail: "The van belongs to a family. A witness describes a routine school pickup." },
  { id: "record", title: "Independent record", x: 24, z: -24, detail: "The timestamp conflicts with CERTAIN's claim. The matching location is not proof of wrongdoing." },
  { id: "sensor", title: "Sensor audit", x: 0, z: 24, detail: "Two alerts share one source. The confidence score treats them as independent." },
] as const;
export type EvidenceId = (typeof evidence)[number]["id"];
export type Verdict = "accept" | "reject" | "abstain";
export type Campaign = { version: 1; collected: EvidenceId[]; verdict: Verdict | null };
export const freshCampaign = (): Campaign => ({ version: 1, collected: [], verdict: null });
export function parseCampaign(raw: string | null): Campaign {
  try {
    const v = JSON.parse(raw ?? "null");
    if (!v || v.version !== 1 || !Array.isArray(v.collected)) return freshCampaign();
    const collected = evidence.filter((e) => v.collected.includes(e.id)).map((e) => e.id);
    const verdict = collected.length === evidence.length && ["accept", "reject", "abstain"].includes(v.verdict)
      ? v.verdict as Verdict : null;
    return { version: 1, collected, verdict };
  } catch { return freshCampaign(); }
}
export function collectEvidence(state: Campaign, id: EvidenceId): Campaign {
  if (!evidence.some((e) => e.id === id) || state.collected.includes(id)) return state;
  return { ...state, collected: [...state.collected, id] };
}
export function submitVerdict(state: Campaign, verdict: Verdict): Campaign {
  return evidence.every((e) => state.collected.includes(e.id)) && state.verdict === null
    ? { ...state, verdict } : state;
}
export function readCampaign(): Campaign {
  try { return parseCampaign(window.localStorage.getItem(CAMPAIGN_KEY)); }
  catch { return freshCampaign(); }
}
export function saveCampaign(state: Campaign): boolean {
  try { window.localStorage.setItem(CAMPAIGN_KEY, JSON.stringify(state)); return true; }
  catch { return false; }
}
export const HQ = { x: 0, z: 0 };
export const CAR = { x: 0, z: 8 };
// Original fictional district: blocks separated by an accessible street grid.
export const buildings = Array.from({ length: 16 }, (_, i) => {
  const x = (i % 4 - 1.5) * 24;
  const z = (Math.floor(i / 4) - 1.5) * 24;
  return { x, z, w: 15, d: 15, h: 5 + (i * 7 % 13) };
});
export function canMove(x: number, z: number, radius = 0.65): boolean {
  return Math.abs(x) <= 46 - radius && Math.abs(z) <= 46 - radius &&
    buildings.every((b) => Math.abs(x - b.x) >= b.w / 2 + radius || Math.abs(z - b.z) >= b.d / 2 + radius);
}
