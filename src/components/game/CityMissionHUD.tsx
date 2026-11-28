import { SafeCityExit } from "./SafeCityExit";
import { useRef } from "react";
import { bakeryScore, CLAIMS } from "@/game/campaign/bakery";
import type { CityStoryLayer } from "@/game/campaign/CityStoryLayer";
import { StreetMap, CityInstruments } from "./CityInstruments";
import { GameplayState } from "@/game/core/GameState";
import { mobileInput } from "@/lib/mobile-input";
import { CHAPTER_HREF, CITY_CAMPAIGN_HREF, DAILY_BREAD_BRIEFING_HREF } from "@/lib/chapters";

const objectives = {
  meet: "Meet Ines outside the field lab.",
  briefing: "Ines Calder · Field dispatch",
  board: "Walk to the teal research wagon and get in.",
  tail: "Follow the gold delivery van. Keep 15–60 m back.",
  interview: "Park at Harbor Table. Walk over to the driver.",
  receipt: "Nico Vale · Dawn Bread",
  return: "Return to the field lab. Speak to Ines on foot.",
  report: "Review the two claims.",
  filed: "Findings filed.",
  failed: "Observation interrupted.",
};

export function DrivePad({ driving }: { driving: boolean }) {
  const held = useRef(new Map<number, string>());
  function axes() {
    const values = [...held.current.values()];
    mobileInput.x = Number(values.includes("right")) - Number(values.includes("left"));
    mobileInput.y = Number(values.includes("forward")) - Number(values.includes("back"));
    mobileInput.action = values.includes("brake");
  }
  function release(id: number) {
    held.current.delete(id);
    axes();
  }
  return (
    <div className="city-pad" aria-label="Touch movement">
      {[
        ["left", "←", "Left"],
        ["forward", "↑", driving ? "Accelerate" : "Forward"],
        ["right", "→", "Right"],
        ["back", "↓", driving ? "Brake or reverse" : "Back"],
        ...(driving ? [["brake", "■", "Handbrake"]] : []),
      ].map(([key, symbol, name]) => (
        <button
          key={key}
          className={"pad-" + key}
          aria-label={name}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            held.current.set(e.pointerId, key);
            axes();
          }}
          onLostPointerCapture={(e) => release(e.pointerId)}
          onPointerUp={(e) => release(e.pointerId)}
          onPointerCancel={(e) => release(e.pointerId)}
        >
          {symbol}
        </button>
      ))}
    </div>
  );
}

export function CityMissionHUD({
  mission: m,
  figure,
  paused,
  setPaused,
  refresh,
}: {
  mission: CityStoryLayer;
  figure: string;
  paused: boolean;
  setPaused: (p: boolean) => void;
  refresh: () => void;
}) {
  const g = m.game,
    phase = m.phase,
    r = m.record;
  const driving = g.interaction.state === GameplayState.Driving;
  const moving = g.interaction.driven?.physics;
  const panel = ["briefing", "receipt", "report", "filed", "failed"].includes(phase);
  const apply = (fn: () => void) => {
    fn();
    refresh();
  };
  const caption =
    phase === "briefing"
      ? "CERTAIN flagged the morning bread run as dangerous cargo. Take our wagon and follow Dawn Bread to Harbor Table. Get the driver’s account and the kitchen’s receipt before you file."
      : "Thirty sourdough loaves, six trays of rolls. I baked them before dawn. Ask the kitchen — they signed for every tray.";
  const prompt = g.interaction.prompt?.label;
  let objective = objectives[phase];
  if (phase === "tail") {
    if (!driving) objective = "Get back in the teal research wagon.";
    else if (m.arrived) objective = "Park within 30 m of the delivery van to finish the reading.";
    else if (m.gap < 15) objective = "Ease off. Give the van at least 15 m.";
    else if (m.gap > 60)
      objective =
        m.gap > 140
          ? "Losing sight of the van. Close the gap."
          : "Catch up to within 60 m of the van.";
  }
  const choiceId = r.checkpoint === "report" && r.cargo !== null ? 4 : 3;
  return (
    <div
      className="city-overlay"
      data-phase={phase}
      data-locomotion={g.interaction.state}
      data-figure={figure}
    >
      <CityInstruments mission={m} active={!paused && !panel} refresh={refresh} />
      {!paused && !panel && (
        <>
          <div className="city-objective">
            <header className="city-header">
              <h1>Daily Bread</h1>
              <button
                className="city-quiet"
                aria-label="Pause mission"
                onClick={() => setPaused(true)}
              >
                ⏸
              </button>
            </header>
            <p>{objective}</p>
            {phase === "tail" && (
              <>
                <progress max={100} value={m.tail.reading} aria-label="Observation progress" />
                <small>
                  {Math.floor(m.tail.reading)}% logged · {Math.round(m.gap)} m to van
                  {m.tail.lostSeconds > 0
                    ? " · " + Math.max(0, Math.ceil(9 - m.tail.lostSeconds)) + " s to recover"
                    : ""}
                </small>
              </>
            )}
          </div>
          <StreetMap mission={m} />
          {g.storySidearmDrawn && (
            <div
              className={"city-reticle" + (m.elapsed - m.lastShot < 0.18 ? " flash" : "")}
              aria-hidden="true"
            />
          )}
          <div className="city-bottom">
            <DrivePad driving={driving} />
            <div className="city-actions">
              {moving && (
                <div className="city-speed">
                  <b>{Math.round(moving.speed * 3.6)}</b> km/h
                </div>
              )}
              {g.storySidearmDrawn && (
                <button
                  className="city-trigger"
                  aria-label="Fire sidearm"
                  onClick={() => {
                    g.audio?.unlock();
                    mobileInput.firePulse = true;
                  }}
                >
                  Fire <kbd>Z</kbd>
                </button>
              )}
              <button
                className="city-primary"
                disabled={!prompt}
                onClick={() => {
                  g.audio?.unlock();
                  mobileInput.interact = true;
                }}
              >
                {prompt ?? "Approach objective"} <kbd>E</kbd>
              </button>
              <small className="city-keys">
                WASD / arrows · drag to look · {driving ? "Space brake" : "click item to equip"}
              </small>
            </div>
          </div>
        </>
      )}
      {(panel || paused) && (
        <section
          className="city-panel"
          role="dialog"
          aria-label={paused ? "Mission paused" : objectives[phase]}
        >
          {paused ? (
            <>
              <div className="city-kicker">FIELD LOG</div>
              <h2>Paused</h2>
              <button className="city-primary" onClick={() => setPaused(false)}>
                Continue mission
              </button>{" "}
              <button
                className="city-back"
                onClick={() =>
                  apply(() => {
                    g.audio?.toggleMute();
                  })
                }
              >
                {g.audio?.isMuted ? "Unmute audio" : "Mute audio"}
              </button>
            </>
          ) : phase === "briefing" || phase === "receipt" ? (
            <>
              <div className="city-kicker">{objectives[phase]}</div>
              <h2>{phase === "briefing" ? "The morning run" : "Signed at the shelter"}</h2>
              <p>{caption}</p>
              {phase === "briefing" && (
                <p>
                  <strong>Christopher</strong>
                  <br />A hot engine and a full van? That could be breakfast. I will follow the run.
                </p>
              )}
              {phase === "receipt" && (
                <blockquote>
                  Harbor Table · Receiving log
                  <br />
                  06:42 · 30 loaves and 6 trays received · E. Mora, kitchen lead
                </blockquote>
              )}
              <button
                className="city-primary"
                onClick={() =>
                  apply(() => {
                    g.audio?.unlock();
                    g.audio?.radioCall();
                    if (phase === "briefing") m.acceptBriefing();
                    else m.collectReceipt();
                  })
                }
              >
                {phase === "briefing" ? "Take the assignment" : "Collect signed receipt"}
              </button>
            </>
          ) : phase === "failed" ? (
            <>
              <div className="city-kicker">FIELD OBSERVATION</div>
              <h2>Observation interrupted</h2>
              <p>{m.failure}</p>
              <button className="city-primary" onClick={() => apply(() => m.retry())}>
                {r.checkpoint === "departure" ? "Retry from departure" : "Retry from checkpoint"}
              </button>
            </>
          ) : phase === "report" ? (
            <>
              <div className="city-kicker">R.A.I.N. / FINDING {choiceId === 3 ? 1 : 2} OF 2</div>
              <h2>{CLAIMS[choiceId - 3].text}</h2>
              <p>Weigh the route observation, Nico’s account and the signed kitchen receipt.</p>
              <div className="city-choices">
                {(["accept", "reject", "abstain"] as const).map((v) => (
                  <button key={v} onClick={() => apply(() => m.answer(choiceId, v))}>
                    {v}
                  </button>
                ))}
              </div>
            </>
          ) : (
            r.checkpoint === "filed" && (
              <>
                <div className="city-kicker">FIELD LOG / CLOSED</div>
                <h2>Delivery report</h2>
                {CLAIMS.map((c, i) => (
                  <p key={c.id}>
                    <strong>
                      {i === 0 ? "Cargo" : "Delivery"} · {i === 0 ? r.cargo : r.delivery}
                    </strong>
                    <br />
                    {c.finding}
                  </p>
                ))}
                <strong className="city-score">
                  {bakeryScore(r.cargo, r.delivery)} / 20 evidence points
                </strong>
                <p>Case filed · $50 field allowance received.</p>
                <div className="city-links">
                  <button
                    onClick={async () => {
                      if (await m.confirmTravel()) window.location.assign(CITY_CAMPAIGN_HREF);
                      refresh();
                    }}
                  >
                    Return to San Fierro story
                  </button>
                  <button
                    onClick={async () => {
                      if (await m.confirmTravel())
                        window.location.assign(DAILY_BREAD_BRIEFING_HREF);
                      refresh();
                    }}
                  >
                    Continue to Pine Gap briefing ↗
                  </button>
                </div>
              </>
            )
          )}
          {(paused || phase === "filed") && (
            <SafeCityExit
              href={CHAPTER_HREF["san-fierro"]}
              label="Return to the city case"
              save={() => m.confirmTravel(false)}
            />
          )}
        </section>
      )}
      {!m.storageOK && (
        <small className="city-storage">
          Save unavailable. Stay on this page, allow site storage, then try again.
        </small>
      )}
      {figure === "unavailable" && (
        <small className="city-model-note">
          Character asset unavailable · using the field stand-in
        </small>
      )}
    </div>
  );
}
