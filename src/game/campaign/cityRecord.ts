import { z } from "zod";
import { EPISODES, TRIAGE, verdicts, type Choice } from "./cityEpisodes";
import { MODES } from "./cityResearch";
import { BAKERY_KEY, readDailyBreadReport, type FiledBakery } from "./bakery";
import type { KeyValueStorage } from "../afterhours/progress";

export const CITY_RECORD_KEY = "99sure.city.campaign.v1";
const choice = z.enum([
  ...verdicts,
  "causes",
  "common cause",
  "coincidence",
  "can't tell",
  "verify",
  "publish",
  "battery",
  "trace",
  "refuse",
  "take",
]);
const triage = z.object({
  observed: z.number().int().min(0).max(2),
  left: z.number().min(0).max(100),
  result: z.enum([...verdicts, "detained"]).nullable(),
});
const schema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    episode: z.number().int().min(0).max(EPISODES.length),
    step: z.number().int().nonnegative().nullable(),
    first: z.record(z.string(), choice),
    score: z.number().int().min(0).max(100),
    notes: z.array(z.string()).max(80),
    outcomes: z.object({
      relay: z.enum(["verified", "published", "wiped"]).nullable(),
      triage: z.array(triage).length(3),
      debate: z.enum(["quiet", "pursuit"]).nullable(),
      kits: z.number().int().min(1).max(3),
    }),
    research: z.record(
      z.string(),
      z.object({
        verdict: z.enum(verdicts),
        audit: z.enum(["careful", "sloppy", "retracted", "cautious"]),
        grant: z.number().int().nonnegative().default(0),
      }),
    ),
    modes: z.array(z.number().refine((n) => MODES.some((hz) => hz === n))).max(6),
    control: z.boolean(),
    reputation: z.number().int().min(0).max(100),
    researchFunds: z.number().int().nonnegative().default(0),
    news: z.string().nullable(),
  })
  .refine((r) => r.step === null || r.step < (EPISODES[r.episode]?.tasks.length ?? 0));

export type CityRecord = z.infer<typeof schema>;

export function emptyCityRecord(): CityRecord {
  return {
    version: 1,
    revision: 0,
    episode: 0,
    step: null,
    first: {},
    score: 0,
    notes: [],
    outcomes: {
      relay: null,
      triage: TRIAGE.map((person) => ({ observed: 0, left: person.seconds, result: null })),
      debate: null,
      kits: 3,
    },
    research: {},
    modes: [],
    control: false,
    reputation: 50,
    researchFunds: 0,
    news: null,
  };
}

export function parseCityRecord(raw: string | null): CityRecord {
  try {
    const r = schema.safeParse(JSON.parse(raw ?? "null"));
    if (r.success) return r.data;
  } catch {
    // A missing or damaged save starts at the lab.
  }
  return emptyCityRecord();
}

export function addFirst(r: CityRecord, id: string, value: Choice, answer?: Choice) {
  if (Object.hasOwn(r.first, id)) return;
  r.first[id] = value;
  if (answer && /^\d$/.test(id)) r.score = Math.max(0, r.score + (value === answer ? 10 : -5));
}

export function postBread(r: CityRecord, b: FiledBakery) {
  addFirst(r, "3", b.cargo, "reject");
  addFirst(r, "4", b.delivery, "accept");
}

export function strongLog(r: CityRecord) {
  const supported = ["reject", "reject", "abstain", "reject", "accept", "reject", "abstain"];
  return supported.filter((answer, id) => r.first[String(id)] === answer).length >= 5;
}

export function changeReputation(r: CityRecord, amount: number) {
  r.reputation = Math.min(100, Math.max(0, r.reputation + amount));
}

export function readCityDossier(read: (key: string) => string | null) {
  try {
    const city = parseCityRecord(read(CITY_RECORD_KEY));
    const bakery = readDailyBreadReport(read);
    if (
      city.episode === EPISODES.length &&
      bakery &&
      (city.first.fee === "take" || city.first.fee === "refuse")
    )
      return { city, bakery };
  } catch {
    // Storage can be unavailable in private browsing.
  }
  return null;
}

export function loadCityRecord(storage: KeyValueStorage | null) {
  try {
    return parseCityRecord(storage?.getItem(CITY_RECORD_KEY) ?? null);
  } catch {
    return emptyCityRecord();
  }
}

export function usesCityStorage(key: string | null) {
  return key === CITY_RECORD_KEY || key === BAKERY_KEY || key === null;
}
