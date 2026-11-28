import { describe, expect, test } from "bun:test";
import { Game } from "../src/game/Game";
import { CityCampaignLayer } from "../src/game/campaign/CityCampaignLayer";
import { CITY_DISTRICT } from "../src/game/world/buildCityWorld";
import {
  CITY_RECORD_KEY,
  addFirst,
  emptyCityRecord,
  parseCityRecord,
  postBread,
  readCityDossier,
  strongLog,
  type CityRecord,
} from "../src/game/campaign/cityRecord";
import { EPISODES, TRIAGE } from "../src/game/campaign/cityEpisodes";
import {
  canResearch,
  auditResearch,
  MODES,
  recommend,
  researchScores,
  rigReading,
} from "../src/game/campaign/cityResearch";
import { RESEARCH } from "../src/game/campaign/cityResearchData";
import { BAKERY_KEY } from "../src/game/campaign/bakery";
import { CASE_STORAGE_KEY } from "../src/game/hidden/caseFile";
import { STORAGE_KEY } from "../src/game/afterhours/progress";

const bread = { version: 1, checkpoint: "filed", cargo: "reject", delivery: "accept" } as const;
function setup(seed: CityRecord = emptyCityRecord(), saves = new Map<string, string>()) {
  if (!saves.has(CITY_RECORD_KEY)) saves.set(CITY_RECORD_KEY, JSON.stringify(seed));
  const storage = {
    getItem: (key: string) => saves.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saves.set(key, value);
    },
    removeItem: (key: string) => {
      saves.delete(key);
    },
  };
  const game = new Game({ visuals: false, district: CITY_DISTRICT, storage });
  const m = new CityCampaignLayer(game, storage);
  return {
    m,
    game,
    saves,
    storage,
    dispose: () => {
      m.dispose();
      game.dispose();
    },
  };
}
function stage(episode: number, title: string) {
  const r = emptyCityRecord();
  r.episode = episode;
  r.step = EPISODES[episode].tasks.findIndex((t) => t.title === title);
  if (r.step < 0) throw new Error(title);
  return r;
}
describe("San Fierro standalone campaign", () => {
  test("every stage survives loading at a valid on-foot spawn and cleans up", () => {
    for (const [episode, list] of EPISODES.entries()) {
      for (const [step, task] of list.tasks.entries()) {
        const record = { ...emptyCityRecord(), episode, step };
        const c = setup(record);
        expect(c.m.task).toBe(task);
        expect(c.m.record).toEqual(record);
        expect(c.game.ground.heightAt(c.game.player.position.x, c.game.player.position.z)).toBe(0);
        c.m.dispose();
        expect(c.game.vehicles.vehicles).toHaveLength(1);
        c.game.dispose();
      }
    }
    expect(parseCityRecord('{"version":3,"episode":5}')).toEqual(emptyCityRecord());
  });
  test("Daily Bread imports both choices once and leaves the older city, Pine Gap and After Hours files alone", () => {
    const initial = stage(0, "Daily Bread");
    const files = new Map([
      [BAKERY_KEY, JSON.stringify(bread)],
      [CASE_STORAGE_KEY, "field-state"],
      [STORAGE_KEY, "after-hours-state"],
      ["99sure.browser.campaign.v1", "prototype-state"],
    ]);
    const c = setup(initial, files);
    try {
      expect(c.m.record.first).toEqual({ "3": "reject", "4": "accept" });
      expect(c.m.record.score).toBe(20);
      expect(c.m.task?.title).toBe("Comparison readings");
      c.m.syncBread();
      expect(c.m.record.score).toBe(20);
      expect(files.get(CASE_STORAGE_KEY)).toBe("field-state");
      expect(files.get(STORAGE_KEY)).toBe("after-hours-state");
      expect(files.get("99sure.browser.campaign.v1")).toBe("prototype-state");
    } finally {
      c.dispose();
    }
  });
  test("teaching corrections keep the first response and do not re-score after reload", () => {
    const c = setup(stage(0, "Christopher's file"));
    c.m.choose("accept");
    expect(c.m.correction).toBe(true);
    expect(c.m.task?.title).toBe("Christopher's file");
    c.dispose();
    const reopened = setup(emptyCityRecord(), c.saves);
    try {
      reopened.m.choose("reject");
      expect(reopened.m.task?.title).toBe("The courtyard class");
      expect(reopened.m.record.first["0"]).toBe("accept");
      expect(reopened.m.record.score).toBe(0);
      const r = emptyCityRecord();
      addFirst(r, "0", "reject", "reject");
      postBread(r, bread);
      addFirst(r, "1", "reject", "reject");
      expect(strongLog(r)).toBe(false);
      addFirst(r, "2", "abstain", "abstain");
      expect(strongLog(r)).toBe(true);
    } finally {
      reopened.dispose();
    }
  });
  test("a first detention persists and a second restores the previous triage checkpoint", () => {
    const r = stage(2, "Investigate the three flags");
    r.outcomes.triage[0].left = 1;
    r.outcomes.triage[1].left = 6;
    r.outcomes.triage[2].observed = 1;
    const c = setup(r);
    try {
      c.m.fixedStep(2);
      expect(c.m.record.outcomes.triage[0].result).toBe("detained");
      expect(c.m.record.outcomes.triage[1].left).toBe(4);
      c.m.fixedStep(4.5);
      expect(c.m.failure).toContain("Two people");
      c.m.retry();
      expect(c.m.clocks[1]).toBe(4);
      expect(c.m.record.outcomes.triage[2].observed).toBe(1);
      expect(c.m.record.outcomes.triage[0].result).toBe("detained");
    } finally {
      c.dispose();
    }
  });
  test("late controls cannot regress a newer saved mission", () => {
    const first = setup();
    const stale = setup(emptyCityRecord(), first.saves);
    try {
      first.m.startEpisode();
      first.m.continueDialog();
      stale.m.startEpisode();
      expect(stale.m.task?.title).toBe("Drive clear of the patrol");
      expect(stale.m.record.revision).toBe(first.m.record.revision);
    } finally {
      stale.dispose();
      first.dispose();
    }
  });
  test("publication, broadcast and replication choices keep distinct results", () => {
    const relay = setup(stage(1, "The relay recording"));
    const quiet = setup(stage(3, "Meet Rex at the live broadcast"));
    const chase = setup({
      ...stage(3, "Meet Rex at the live broadcast"),
      first: { ice: "causes" },
    });
    const battery = setup({
      ...stage(4, "Recover the demonstration"),
      outcomes: { ...emptyCityRecord().outcomes, kits: 1 },
    });
    try {
      relay.m.choose("publish");
      expect(relay.m.record.outcomes.relay).toBe("published");
      for (const c of [quiet, chase]) {
        const offer = c.game.interaction.providers.at(-1)!(-5, 0, 106);
        expect(offer).not.toBeNull();
        offer?.act();
      }
      expect(quiet.m.record.outcomes.debate).toBe("quiet");
      expect(quiet.m.task?.title).toBe("Return to Vers3Dynamics");
      expect(chase.m.task?.title).toBe("Drive clear of the protest vans");
      battery.m.choose("battery");
      expect(battery.m.task?.title).toBe("Listen to the replication calls");
      battery.game.interaction.providers.at(-1)!(-5, 0, 125)?.act();
      battery.m.choose("abstain");
      battery.m.choose("refuse");
      expect(battery.m.record.first).toEqual({
        power: "battery",
        replication: "abstain",
        fee: "refuse",
      });
    } finally {
      for (const c of [relay, quiet, chase, battery]) c.dispose();
    }
  });
  test("a complete dossier is read-only and requires a completed city story and the bakery report", () => {
    const r = { ...emptyCityRecord(), episode: 5, first: { fee: "refuse" } } as const;
    const read = (key: string) =>
      key === CITY_RECORD_KEY
        ? JSON.stringify(r)
        : key === BAKERY_KEY
          ? JSON.stringify(bread)
          : null;
    expect(readCityDossier(read)?.city.first.fee).toBe("refuse");
    expect(readCityDossier((key) => (key === BAKERY_KEY ? null : read(key)))).toBeNull();
    expect(
      readCityDossier((key) =>
        key === CITY_RECORD_KEY ? JSON.stringify({ ...r, episode: 4 }) : read(key),
      ),
    ).toBeNull();
    expect(
      readCityDossier(() => {
        throw new Error("Blocked");
      }),
    ).toBeNull();
  });
});
describe("Vers3Dynamics laboratory", () => {
  test("the eight cases have a defensible result and duplicate sources make a correct result sloppy", () => {
    expect(RESEARCH).toHaveLength(8);
    expect(canResearch(RESEARCH[0], 0, 0)).toBe(false);
    expect(canResearch(RESEARCH[7], 5, 4)).toBe(false);
    expect(canResearch(RESEARCH[7], 5, 5)).toBe(true);
    for (const c of RESEARCH) {
      const src = new Set<number>();
      const cards = c.cards.flatMap((card, i) =>
        card.kind !== "evidence" || src.has(card.src) ? [] : (src.add(card.src), [i]),
      );
      const trial = c.tests.findIndex((t) => t.informative);
      expect(recommend(c, researchScores(c, cards, trial))).toBe(c.truth);
      expect(auditResearch(c, cards, trial, c.truth)).toBe("careful");
      expect(auditResearch(c, cards.concat(cards[0]), trial, c.truth)).toBe("sloppy");
    }
  });
  test("a retraction can be corrected, while a careful result and repeat rig logs cannot pay twice", () => {
    const c = setup({ ...emptyCityRecord(), episode: 1 });
    try {
      const research = RESEARCH[0];
      c.m.fileResearch(research, [], null, "accept");
      expect(c.m.record.research[1].audit).toBe("retracted");
      c.m.fileResearch(research, [0, 2], 0, "reject");
      expect(c.m.record.research[1].audit).toBe("careful");
      const reputation = c.m.record.reputation;
      c.m.fileResearch(research, [], null, "accept");
      expect(c.m.record.reputation).toBe(reputation);
      for (const hz of MODES) c.m.logRig(hz, true);
      c.m.logRig(170, true);
      c.m.logRig(180, true);
      expect(c.m.record.modes).toEqual([...MODES]);
      expect(c.m.record.control).toBe(false);
      c.m.logRig(180, false);
      expect(c.m.record.control).toBe(true);
      expect(rigReading(600, true).kind).toBe("flat");
    } finally {
      c.dispose();
    }
  });
});
