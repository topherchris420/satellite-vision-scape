import { useEffect, useRef, useState } from "react";
import type { CityCampaignLayer } from "@/game/campaign/CityCampaignLayer";
import { RESEARCH } from "@/game/campaign/cityResearchData";
import {
  MODES,
  recommend,
  researchScores,
  rigReading,
  type Audit,
  type ResearchCase,
} from "@/game/campaign/cityResearch";
import { EPISODES, verdicts } from "@/game/campaign/cityEpisodes";
import { CITY_BRIEFING_HREF } from "@/lib/chapters";

const auditLabels: Record<Audit, string> = {
  careful: "Careful",
  sloppy: "Right for the wrong reasons",
  retracted: "Retracted",
  cautious: "Too cautious",
};
const auditFeedback: Record<Audit, string> = {
  careful: "The independent observations and the experiment agree. This ruling stands.",
  sloppy:
    "You reached the right verdict, but the record needs a clean independent test and distinct sources.",
  retracted: "The evidence supports a different verdict. Reopen the file for another test.",
  cautious:
    "The record supports a decision if you weigh independent observations and run the useful control.",
};

export function CityResearchDesk({ mission: m }: { mission: CityCampaignLayer }) {
  const [tab, setTab] = useState<"story" | "research" | "rig">("story");
  const [selected, setSelected] = useState<ResearchCase | null>(null);
  function switchTo(next: typeof tab) {
    setSelected(null);
    setTab(next);
  }
  return (
    <>
      <div className="city-kicker">Harbor District / Fiction</div>
      <h2>Vers3Dynamics HQ</h2>
      <p>
        {m.record.news ??
          "Ines: Welcome to the lab, Christopher. The dispatch board has the next assignment."}
      </p>
      <p className="city-score">
        Research reputation {m.record.reputation} / 100 · Lab grants $
        {m.record.researchFunds.toLocaleString("en-US")}
      </p>
      <nav className="city-choices" aria-label="HQ stations">
        <button aria-pressed={tab === "story"} onClick={() => switchTo("story")}>
          Dispatch
        </button>
        <button aria-pressed={tab === "research"} onClick={() => switchTo("research")}>
          Research terminal
        </button>
        <button aria-pressed={tab === "rig"} onClick={() => switchTo("rig")}>
          Cymatics rig
        </button>
      </nav>
      {tab === "story" && (
        <section className="city-hq-content" aria-label="Story missions">
          <ol>
            {EPISODES.map((episode, i) => (
              <li key={episode.title}>
                <span>{episode.title}</span>
                <small>
                  {i < m.record.episode ? "Filed" : i > m.record.episode ? "Locked" : "Ready"}
                </small>
              </li>
            ))}
          </ol>
          {m.episode && (
            <>
              <p>{m.episode.description}</p>
              <button className="city-primary" disabled={m.busy} onClick={() => m.startEpisode()}>
                Start {m.episode.title}
              </button>
            </>
          )}
          {m.complete && (
            <>
              <h3>San Fierro dossier filed</h3>
              <p>Public hearing score {m.record.score} / 100. The field relay is ready.</p>
              {m.storageOK && (
                <a className="city-primary" href={CITY_BRIEFING_HREF}>
                  Continue to Pine Gap
                </a>
              )}
            </>
          )}
        </section>
      )}
      {tab === "research" &&
        (selected ? (
          <ResearchFile
            key={selected.id}
            mission={m}
            research={selected}
            close={() => setSelected(null)}
          />
        ) : (
          <section className="city-hq-content" aria-label="HQ assignments">
            <p>
              Weigh independent sources, choose one experiment and file a verdict. Careful rulings
              stand. Other rulings can be reopened.
            </p>
            {RESEARCH.map((c) => (
              <button
                key={c.id}
                className="hq-case"
                disabled={!m.researchAvailable(c)}
                onClick={() => setSelected(c)}
              >
                <span>{c.title}</span>
                <small>
                  {m.record.research[c.id]
                    ? auditLabels[m.record.research[c.id].audit]
                    : m.researchAvailable(c)
                      ? "Available"
                      : "Locked"}
                </small>
              </button>
            ))}
          </section>
        ))}
      {tab === "rig" && <CymaticsRig mission={m} />}
      <button
        className="city-back"
        onClick={() => {
          m.office = false;
        }}
      >
        Step outside
      </button>
    </>
  );
}

function ResearchFile({
  mission: m,
  research: c,
  close,
}: {
  mission: CityCampaignLayer;
  research: ResearchCase;
  close: () => void;
}) {
  const [cards, setCards] = useState<number[]>([]);
  const [trial, setTrial] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const audit = m.record.research[c.id]?.audit;
  const locked = audit === "careful" || submitted;
  const scores = researchScores(c, cards, trial);
  return (
    <section className="city-hq-content" aria-label={c.title}>
      <button className="city-back" onClick={close}>
        All assignments
      </button>
      <h3>{c.title}</h3>
      <p>{c.claim}</p>
      {audit && (
        <p role="status">
          <strong>{auditLabels[audit]}</strong> · {auditFeedback[audit]}
        </p>
      )}
      {(!locked || submitted) && (
        <>
          <fieldset disabled={locked}>
            <legend>Evidence cards</legend>
            {c.cards.map((card, i) => (
              <label key={i} className="hq-card">
                <input
                  type="checkbox"
                  checked={cards.includes(i)}
                  onChange={(e) =>
                    setCards(e.target.checked ? [...cards, i] : cards.filter((n) => n !== i))
                  }
                />
                <span>
                  {card.text}
                  <small>{card.source}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="hq-scores" aria-label="Three explanations">
            {c.hyp.map((name, i) => (
              <div key={name}>
                {name} <meter min={-15} max={25} value={scores[i]} aria-label={name} /> {scores[i]}
              </div>
            ))}
          </div>
          <p>
            <strong>R.A.I.N. reading</strong> · {recommend(c, scores)}
          </p>
          <div className="city-choices" aria-label="Choose one experiment">
            {c.tests.map((t, i) => (
              <button key={t.label} disabled={trial !== null || locked} onClick={() => setTrial(i)}>
                {t.label} · {t.hours} h
              </button>
            ))}
          </div>
          {trial !== null && <p role="status">{c.tests[trial].result}</p>}
          {!locked && (
            <div className="city-choices" aria-label="File research verdict">
              {verdicts.map((v) => (
                <button
                  key={v}
                  disabled={m.busy}
                  onClick={() => {
                    m.fileResearch(c, cards, trial, v);
                    setSubmitted(true);
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

const PLATE_MODES = [
  [1, 2],
  [1, 3],
  [2, 3],
  [1, 4],
  [3, 4],
  [2, 5],
] as const;

function SandPlate({ mode }: { mode: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = canvas.current?.getContext("2d");
    if (!g) return;
    const size = 192;
    g.fillStyle = "#121e1a";
    g.fillRect(0, 0, size, size);
    g.strokeStyle = "#29443b";
    g.strokeRect(7, 7, size - 14, size - 14);
    if (mode < 0) return;
    const [m, n] = PLATE_MODES[mode];
    g.fillStyle = "#e3c58b";
    for (let y = 8; y < size - 8; y += 2) {
      const ny = (y / size) * Math.PI;
      for (let x = 8; x < size - 8; x += 2) {
        const nx = (x / size) * Math.PI;
        const wave = Math.sin(m * nx) * Math.sin(n * ny) - Math.sin(n * nx) * Math.sin(m * ny);
        if (Math.abs(wave) < 0.045) g.fillRect(x, y, 1.5, 1.5);
      }
    }
  }, [mode]);
  return (
    <canvas
      className="hq-plate"
      ref={canvas}
      role="img"
      width={192}
      height={192}
      aria-label={mode >= 0 ? "Stable sand pattern on the plate" : "No stable sand pattern"}
    />
  );
}

function CymaticsRig({ mission: m }: { mission: CityCampaignLayer }) {
  const [hz, setHz] = useState(170);
  const [on, setOn] = useState(true);
  const [result, setResult] = useState("");
  const sample = rigReading(hz, on);
  const mode = sample.kind === "mode" ? MODES.indexOf(sample.hz) : -1;
  const response = Math.max(
    ...[...(on ? MODES : []), 60, 120, 180].map((f) => 1 / (1 + ((f - hz) / 4) ** 2)),
  );
  if (m.record.episode === 0) return <p>The rig opens after the public hearing returns to HQ.</p>;
  return (
    <section className="city-hq-content" aria-label="Cymatics plate">
      <p>
        Find the six resonances and log the wiring hum with the generator switched off. The response
        peaks around each real mode.
      </p>
      <SandPlate mode={mode} />
      <meter className="hq-dial" min={0} max={1} value={response} aria-label="Vibration response" />
      <label className="hq-card">
        Frequency (Hz){" "}
        <input
          aria-label="Frequency"
          type="number"
          min={50}
          max={1000}
          value={hz}
          onChange={(e) => setHz(e.target.valueAsNumber || 50)}
        />
      </label>
      <input
        className="hq-dial"
        aria-label="Frequency dial"
        type="range"
        min={50}
        max={1000}
        value={hz}
        onChange={(e) => setHz(e.target.valueAsNumber)}
      />
      <label className="hq-card">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Generator
        on
      </label>
      <p>
        Response:{" "}
        {sample.kind === "mode" ? "Stable pattern" : sample.kind === "flat" ? "Flat" : "Wiring hum"}
      </p>
      <button
        className="city-primary"
        disabled={m.busy}
        onClick={() => {
          m.logRig(hz, on);
          setResult(
            sample.kind === "mode"
              ? "Logged " + sample.hz + " Hz"
              : sample.kind === "control"
                ? "Control recorded"
                : sample.kind === "hum"
                  ? "Switch off the generator to test the hum."
                  : "No stable reading.",
          );
        }}
      >
        Log reading
      </button>
      {result && <p role="status">{result}</p>}
      <p>
        Atlas {m.record.modes.length} / {MODES.length} ·{" "}
        {m.record.modes.join(", ") || "No modes logged"}
      </p>
      {m.record.control && <p>Generator-off control on file.</p>}
    </section>
  );
}
