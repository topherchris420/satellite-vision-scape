import { CityPlay } from "./CityPlay";
import { DrivePad } from "./CityMissionHUD";
import { CityRadar } from "./CityInstruments";
import { CityResearchDesk } from "./CityResearchDesk";
import { CityCampaignLayer } from "@/game/campaign/CityCampaignLayer";
import { TRIAGE, verdicts } from "@/game/campaign/cityEpisodes";
import { CITY_RECORD_KEY } from "@/game/campaign/cityRecord";
import { BAKERY_KEY } from "@/game/campaign/bakery";
import { CHAPTER_HREF, DAILY_BREAD_HREF } from "@/lib/chapters";
import { mobileInput } from "@/lib/mobile-input";
import "./city-campaign.css";

export function CityCampaign() {
  return (
    <CityPlay
      label="San Fierro story"
      makeMission={(game, storage) =>
        new CityCampaignLayer(game, storage, storage ? navigator.locks : undefined)
      }
      modal={(mission) => mission.modal}
      waypoint={(mission) => (!mission.modal ? mission.destination : null)}
      courtyard={(mission) => mission.courtyard && !mission.modal}
      subject={(mission) => (!mission.modal && !mission.courtyard ? mission.subject : null)}
      onStorage={(mission, key) => {
        if (key === CITY_RECORD_KEY || key === null) mission.sync();
        if (key === BAKERY_KEY || key === null) mission.syncBread();
      }}
      renderHUD={(props) => <CampaignHUD {...props} />}
    />
  );
}

function CampaignHUD({
  mission: m,
  figure,
  paused,
  setPaused,
  refresh,
}: {
  mission: CityCampaignLayer;
  figure: string;
  paused: boolean;
  setPaused: (value: boolean) => void;
  refresh: () => void;
}) {
  const task = m.task;
  const open = paused || m.modal;
  const title = m.episode?.title ?? "Vers3Dynamics HQ";
  const drive = m.game.interaction.driven?.physics;
  const resident = m.triageFile === null ? null : TRIAGE[m.triageFile];
  const notes = m.record.notes;
  const deadline = m.escapeDeadline;
  const taskName = task?.title ?? "Return to the lab";
  return (
    <div
      className="city-overlay city-campaign"
      data-episode={m.record.episode}
      data-step={m.record.step ?? "hq"}
      data-kind={task?.kind ?? "hq"}
      data-task={taskName}
      data-figure={figure}
      data-locomotion={m.game.interaction.state}
      data-target-x={m.destination.x}
      data-target-z={m.destination.z}
    >
      {!open && (
        <>
          <section className="city-objective" aria-label="Current assignment">
            <header className="city-header">
              <h1>{title}</h1>
              <button
                className="city-quiet"
                aria-label="Pause mission"
                onClick={() => setPaused(true)}
              >
                Ⅱ
              </button>
            </header>
            <p>{taskName}</p>
            <small>
              {Math.round(m.gap)} m{" "}
              {deadline !== null && "· Dispatch in " + Math.ceil(deadline) + " s"}
            </small>
            {task?.kind === "reading" && (
              <>
                <progress max={4} value={m.progress} aria-label="Stationary reading" />
                <small>Stay seated and hold the wagon still for four seconds.</small>
              </>
            )}
            {task?.kind === "photo" && (
              <>
                <progress
                  max={2.5}
                  value={m.progress}
                  aria-label={m.record.episode === 1 ? "Pattern lock" : "Framing progress"}
                />
                <small className="block">
                  {m.photoAimed
                    ? m.courtyard
                      ? "Class in frame. Record the observation when you’re ready."
                      : "Aligned. Hold steady or use at the marker."
                    : m.courtyard
                      ? "At the marker, turn toward the practice mats on the sidewalk."
                      : "At the marker, drag to face the subject to the north."}
                </small>
              </>
            )}
            {task?.kind === "road" && m.target && (
              <small className="block">
                {task.role === "escort"
                  ? "Maintain 5–35 m while the evidence uploads · " + m.progress.toFixed(0) + " s"
                  : task.role === "relay"
                    ? "Keep the technician in view until the stop"
                    : "Keep clear of the trailing vehicle."}
              </small>
            )}
            {task?.kind === "road" && !m.target && (
              <small className="block">Start in the research wagon at the marker.</small>
            )}
            {task?.kind === "drive" &&
              m.record.episode === 1 &&
              m.record.first.relay === "verify" && (
                <small className="block">
                  Live buffer · {Math.max(0, Math.ceil(240 - m.elapsed))} s
                </small>
              )}
            {m.courierActive && (
              <small className="block">
                Follow Dex to the drop. Stay 5–20 m from the courier until the stop.
              </small>
            )}
            {m.feedback && (
              <p className="city-field-note" role="status">
                {m.feedback}
              </p>
            )}
          </section>
          <CityRadar
            game={m.game}
            dest={m.destination}
            wagon={m.wagon.physics}
            traffic={m.target?.physics}
          />
          {task?.kind === "photo" && (
            <div
              className={m.photoAimed ? "city-reticle flash" : "city-reticle"}
              aria-hidden="true"
            />
          )}
          {task?.kind === "triage" && (
            <aside className="city-triage" aria-label="Alert clocks">
              {TRIAGE.map((person, i) => {
                const state = m.record.outcomes.triage[i];
                return (
                  <button
                    key={person.name}
                    onClick={() => {
                      m.selected = i;
                      refresh();
                    }}
                    aria-pressed={m.selected === i}
                    disabled={state.result !== null}
                  >
                    {person.name}
                    <b>{state.result ?? Math.ceil(m.clocks[i]) + " s"}</b>
                    <small>{state.observed} / 2 observed</small>
                  </button>
                );
              })}
            </aside>
          )}
          <div className="city-bottom">
            <DrivePad driving={m.driving} />
            <div className="city-actions">
              {drive && (
                <div className="city-speed">
                  <b>{Math.round(drive.speed * 3.6)}</b> km/h
                </div>
              )}
              <button
                className="city-primary"
                disabled={!m.prompt || m.busy}
                onClick={() => {
                  m.game.unlockAudio();
                  mobileInput.interact = true;
                }}
              >
                {m.prompt ?? "Approach objective"} <kbd>E</kbd>
              </button>
              <small className="city-keys">WASD / arrows · Space brake · drag to look</small>
            </div>
          </div>
        </>
      )}
      {open && (
        <section
          className="city-panel city-campaign-panel"
          role="dialog"
          aria-label={paused ? "Mission paused" : m.office ? "Vers3Dynamics HQ" : taskName}
        >
          {paused ? (
            <>
              <h2>Paused</h2>
              <button className="city-primary" onClick={() => setPaused(false)}>
                Continue mission
              </button>{" "}
              <button
                className="city-back"
                onClick={() => {
                  m.game.audio?.toggleMute();
                  refresh();
                }}
              >
                {m.game.audio?.isMuted ? "Unmute audio" : "Mute audio"}
              </button>
              <a className="city-back" href={CHAPTER_HREF["san-fierro"]}>
                Return to chapter menu
              </a>
            </>
          ) : m.failure ? (
            <>
              <h2>Checkpoint interrupted</h2>
              <p>{m.failure}</p>
              <button
                className="city-primary"
                onClick={() => {
                  m.retry();
                  refresh();
                }}
              >
                Retry checkpoint
              </button>
            </>
          ) : m.office ? (
            <CityResearchDesk mission={m} />
          ) : resident ? (
            <>
              <div className="city-kicker">SENTINEL field file</div>
              <h2>{resident.name}</h2>
              <p>{resident.claim}</p>
              {resident.evidence.map((e) => (
                <p key={e}>{e}</p>
              ))}
              <div className="city-choices">
                {verdicts.map((v) => (
                  <button key={v} disabled={m.busy} onClick={() => m.fileTriage(v)}>
                    {v}
                  </button>
                ))}
              </div>
            </>
          ) : task?.kind === "dialog" ? (
            <>
              <div className="city-kicker">{title} / Fiction</div>
              <h2>{task.title}</h2>
              <p>{task.text}</p>
              <button
                className="city-primary"
                disabled={m.busy}
                onClick={() => {
                  m.game.unlockAudio();
                  m.continueDialog();
                  refresh();
                }}
              >
                Continue
              </button>
            </>
          ) : task?.kind === "bakery" ? (
            <>
              <div className="city-kicker">CERTAIN field alert</div>
              <h2>Daily Bread</h2>
              <p>
                Follow Dawn Bread to Harbor Table and file both verdicts. Your investigation
                continues here after you file.
              </p>
              <button
                className="city-primary"
                disabled={m.busy}
                onClick={async () => {
                  if (await m.confirmTravel()) window.location.assign(DAILY_BREAD_HREF);
                  refresh();
                }}
              >
                Play Daily Bread
              </button>
            </>
          ) : task?.kind === "choice" ? (
            <>
              <div className="city-kicker">R.A.I.N. / Field decisions</div>
              <h2>{task.title}</h2>
              <p>{task.claim}</p>
              <ul className="city-evidence">
                {notes.slice(-4).map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
              {task.id === "replication" && (
                <p role="status">
                  {m.record.outcomes.kits} independent{" "}
                  {m.record.outcomes.kits === 1 ? "result" : "results"} reached the lab. R.A.I.N.
                  requires two to accept.
                </p>
              )}
              {m.correction && <p role="status">{m.feedback}</p>}
              <div className="city-choices">
                {task.choices.map((v) => (
                  <button key={v} disabled={m.busy} onClick={() => m.choose(v)}>
                    {v}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {!m.storageOK && (
            <p role="status">
              {m.record.revision === 0
                ? "This campaign needs browser storage to save progress between missions. Allow site storage, then reload to start."
                : "Your latest checkpoint couldn’t be saved. Stay on this page, allow site storage, then try again."}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
