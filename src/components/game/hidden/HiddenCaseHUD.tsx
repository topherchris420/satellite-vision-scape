import { EXPEDITIONS, availableStations, canFile, fieldEnding, instrumentFor, responseAt } from "@/game/hidden/expeditions";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { HiddenCase } from "@/game/hidden/HiddenCase";
import type { CaseSnapshot } from "@/game/hidden/caseHud";
import type { PlayStatus } from "@/hooks/use-play-session";
import {
  CLAIM,
  CONFIDENCE_CHOICES,
  ENDINGS,
  FIELD_NOTES,
  POSTS,
  RADIO,
  SPEAKERS,
  TITLE,
  independentLines,
  type Confidence,
  type Verdict,
} from "@/game/hidden/story";

/**
 * Everything the hidden case puts on screen: the title card, the objective
 * list, radio captions, the people's conversations, the evidence board, the
 * verdict and its ending, the field notes and the case file. Loaded with the
 * case, never on an ordinary visit.
 */

const glass =
  "border border-white/10 bg-[#041214]/82 text-white shadow-[0_16px_50px_rgba(0,0,0,.32)] backdrop-blur-xl";
const teal = "text-[#7fd6d0]";

const SPEAKER_TONE: Record<keyof typeof SPEAKERS, string> = {
  rain: "text-[#7fd6d0]",
  ines: "text-amber-200",
  mara: "text-sky-200",
  tobin: "text-orange-300",
  certain: "text-rose-300",
};

export interface HiddenCaseHUDProps {
  hiddenCase: HiddenCase;
  status: PlayStatus;
  isMobile: boolean;
  /** Back to play after the pause card (unlocked: leave the mouse free). */
  onResume: (unlocked: boolean) => void;
  /** Capture the mouse again after a panel closes (from the click). */
  onRecapture: () => void;
  onReturnToSurvey: () => void;
  onLeave: () => void;
}

export default function HiddenCaseHUD({
  hiddenCase,
  status,
  isMobile,
  onResume,
  onRecapture,
  onReturnToSurvey,
  onLeave,
}: HiddenCaseHUDProps) {
  const snap = useSyncExternalStore(hiddenCase.hud.subscribe, hiddenCase.hud.getSnapshot, hiddenCase.hud.getSnapshot);
  const running = status === "running";

  useEffect(() => {
    if (!snap.active || !running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyJ" && !e.repeat && !snap.panel && !snap.title) hiddenCase.openFile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hiddenCase, snap.active, snap.panel, snap.title, running]);

  useEffect(() => {
    if (!running) hiddenCase.suspendRover();
  }, [hiddenCase, running]);
  if (!snap.active) return null;
  const close = () => {
    hiddenCase.closePanel();
    onRecapture();
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-[24] font-mono text-white">
      {snap.title && <TitleCard />}

      {running && !snap.title && (
        <>
          <Objectives snap={snap} isMobile={isMobile} onFile={() => hiddenCase.openFile()} />
          {snap.toast && (
            <div
              key={snap.toast.id}
              className={`${glass} absolute left-1/2 top-16 -translate-x-1/2 rounded-lg px-3 py-2 text-[10px] tracking-[.08em] text-[#bfe9e5] sm:top-5`}
            >
              {snap.toast.text}
            </div>
          )}
          {snap.bearing && <BearingMeter snap={snap} />}
          {snap.caption && !snap.panel && (
            <div
              key={snap.caption.id}
              className={`${glass} absolute bottom-24 left-1/2 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl px-4 py-3 sm:bottom-16`}
              role="status"
            >
              <div className={`text-[8px] font-bold uppercase tracking-[.22em] ${SPEAKER_TONE[snap.caption.speaker]}`}>
                {SPEAKERS[snap.caption.speaker]}
              </div>
              <p className="mt-1 font-sans text-[13px] leading-snug text-white/85">{snap.caption.text}</p>
            </div>
          )}
        </>
      )}

      {running && snap.panel && (
        <Modal>
          {snap.panel.kind === "field" && <FieldDesk hiddenCase={hiddenCase} snap={snap} onClose={close} />}
          {snap.panel.kind === "receipt" && <Panel label="Field record" title={snap.panel.title} onClose={close}>
            <p className="font-sans text-sm text-white/85">{snap.panel.text}</p>
          </Panel>}
          {snap.panel.kind === "dialog" && (
            <Dialog snap={snap} onChoose={(id) => (id === "leave" ? close() : hiddenCase.choose(id))} />
          )}
          {snap.panel.kind === "note" && (
            <Panel label="Field note" title={snap.panel.title} onClose={close}>
              <p className="font-sans text-[14px] leading-relaxed text-white/80">{snap.panel.body}</p>
              <p className="mt-3 text-[9px] uppercase tracking-[.18em] text-white/35">
                {snap.documents.length}/{FIELD_NOTES.length} notes found · kept in the case file (J)
              </p>
            </Panel>
          )}
          {snap.panel.kind === "board" && <Board hiddenCase={hiddenCase} snap={snap} onClose={close} />}
          {snap.panel.kind === "ending" && (
            <EndingCard
              snap={snap}
              onClose={close}
              onReplay={() => {
                hiddenCase.replay();
                onRecapture();
              }}
              onNext={() => hiddenCase.nextTransmission()}
              onSurvey={onReturnToSurvey}
            />
          )}
          {snap.panel.kind === "file" && <CaseFilePanel hiddenCase={hiddenCase} snap={snap} onClose={close} />}
        </Modal>
      )}

      {status === "paused" && (
        <Modal>
          <Panel label="Paused · Fiction" title={snap.expeditions.length ? EXPEDITIONS[snap.expeditions.length - 1].title : "Case 01: 99.9% SURE"}>
            <p className="font-sans text-[12px] leading-relaxed text-white/60">
              Everything is saved as you go. Resume here, or step back out to the survey; the signal will still be there.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <PrimaryButton onClick={() => onResume(!!snap.panel || isMobile)}>Resume</PrimaryButton>
              <QuietButton
                onClick={() => {
                  onResume(true);
                  hiddenCase.openFile();
                }}
              >
                Case file
              </QuietButton>
              <QuietButton onClick={onReturnToSurvey}>Return to the survey</QuietButton>
              <QuietButton onClick={onLeave}>Leave the case, keep walking</QuietButton>
            </div>
            <Controls isMobile={isMobile} />
          </Panel>
        </Modal>
      )}
    </div>
  );
}

// --- Pieces ---------------------------------------------------------------------------

function TitleCard() {
  const [skip, setSkip] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setSkip(true), 1600);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div className="hidden-title absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-black/70 via-black/10 to-black/70 text-center">
      <div className="absolute inset-x-0 top-0 h-[11vh] bg-black" />
      <div className="absolute inset-x-0 bottom-0 h-[11vh] bg-black" />
      <h1 className="font-sans text-5xl font-light tracking-[-.05em] text-white sm:text-7xl">{TITLE.title}</h1>
      <p className="mt-4 max-w-md px-6 font-sans text-[14px] text-white/75 sm:text-base">{TITLE.subtitle}</p>
      <p className={`mt-8 text-[8px] uppercase tracking-[.3em] text-white/35 transition-opacity ${skip ? "opacity-100" : "opacity-0"}`}>
        A work of fiction · E to continue
      </p>
    </div>
  );
}

function Objectives({ snap, isMobile, onFile }: { snap: CaseSnapshot; isMobile: boolean; onFile: () => void }) {
  const run = snap.expeditions.at(-1);
  const mission = run && EXPEDITIONS[run.chapter];
  return (
    <section
      aria-label="Case objectives"
      className={`${glass} absolute right-3 top-16 w-[min(17rem,calc(100vw-1.5rem))] rounded-xl px-3 py-2.5 sm:right-5 sm:top-5`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-[8px] font-bold uppercase tracking-[.22em] ${teal}`}>{mission ? `Case 0${run!.chapter + 2} · ${mission.title}` : "Case 01 · 99.9% SURE"}</span>
        <span className="rounded-sm bg-[#0B5D63] px-1 text-[7px] uppercase tracking-[.18em] text-white/90">Fiction</span>
      </div>
      <ul className="mt-2 space-y-1">
        {run && mission ? (
          <li className="font-sans text-xs text-white/80">
            {run.verdict === null ? <>{canFile(run) ? "Return to the van to file your findings." : "Take a reading at the field benches."}
              <span className="mt-1 block text-amber-200">{snap.guidance}</span></>
              : run.chapter === 3 ? "All five cases filed." : "Next transmission at the van."}
          </li>
        ) : snap.objectives.map((o) => (
          <li key={o.id} className={`flex gap-2 font-sans text-[11px] leading-snug ${o.done ? "text-white/35 line-through" : "text-white/80"}`}>
            <span className={o.done ? "text-emerald-300" : teal}>{o.done ? "✓" : "·"}</span>
            <span>
              {o.label}
              {o.id === "crossing" && !o.done && snap.crossingDistance !== null && (
                <span className="ml-1 text-white/45">· {snap.crossingDistance} m</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <button
        onClick={onFile}
        className="pointer-events-auto mt-2 text-[8px] uppercase tracking-[.2em] text-white/40 transition hover:text-white"
      >
        {isMobile ? "Open case file" : "J · Case file"} · notes {snap.documents.length}/{FIELD_NOTES.length}
      </button>
    </section>
  );
}

function BearingMeter({ snap }: { snap: CaseSnapshot }) {
  const b = snap.bearing!;
  return (
    <div className={`${glass} absolute bottom-40 left-1/2 w-64 -translate-x-1/2 rounded-xl px-3 py-2.5 text-center sm:bottom-32`}>
      <div className={`text-[8px] font-bold uppercase tracking-[.22em] ${teal}`}>{POSTS[b.post].label}</div>
      <div className="mt-1 font-sans text-[11px] text-white/75">
        {b.moved && b.progress < 0.05 ? "The needle won't settle while you move." : "Hold still while the bearing settles…"}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded bg-white/10">
        <div className="h-full bg-[#7fd6d0] transition-[width] duration-100" style={{ width: `${Math.round(b.progress * 100)}%` }} />
      </div>
    </div>
  );
}

function Modal({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-3">
      <div className="pointer-events-auto max-h-[90vh] w-full max-w-2xl overflow-y-auto">{children}</div>
    </div>
  );
}

function Panel({
  label,
  title,
  children,
  onClose,
}: {
  label: string;
  title: string;
  children: ReactNode;
  onClose?: () => void;
}) {
  return (
    <section className={`${glass} rounded-2xl p-5`} aria-label={title}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-[8px] font-bold uppercase tracking-[.24em] ${teal}`}>{label}</div>
          <h2 className="mt-1 font-sans text-2xl font-light tracking-tight">{title}</h2>
        </div>
        {onClose && (
          <QuietButton onClick={onClose} autoFocus>
            Back to the field
          </QuietButton>
        )}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function PrimaryButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg bg-[#7fd6d0] px-4 py-2 text-[10px] font-bold uppercase tracking-[.16em] text-[#03201f] transition hover:bg-[#a5e6e1] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function QuietButton({ children, onClick, autoFocus }: { children: ReactNode; onClick: () => void; autoFocus?: boolean }) {
  return (
    <button
      onClick={onClick}
      autoFocus={autoFocus}
      className="rounded-lg border border-white/15 px-3 py-2 text-[10px] uppercase tracking-[.14em] text-white/65 transition hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}

function Dialog({ snap, onChoose }: { snap: CaseSnapshot; onChoose: (id: string) => void }) {
  const panel = snap.panel;
  if (panel?.kind !== "dialog") return null;
  return (
    <section className={`${glass} rounded-2xl p-5`} aria-label={`Talking to ${SPEAKERS[panel.speaker]}`}>
      <div className={`text-[9px] font-bold uppercase tracking-[.22em] ${SPEAKER_TONE[panel.speaker]}`}>
        {SPEAKERS[panel.speaker]}
      </div>
      <p className="mt-2 font-sans text-[15px] leading-relaxed text-white/90">“{panel.line}”</p>
      <div className="mt-4 grid gap-1.5">
        {panel.options.map((o, i) => (
          <button
            key={o.id}
            onClick={() => onChoose(o.id)}
            autoFocus={i === 0}
            className={`rounded-lg border px-3 py-2 text-left font-sans text-[12px] transition hover:bg-white/10 ${
              o.asked ? "border-white/5 text-white/40" : "border-white/15 text-white/80"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function Board({ hiddenCase, snap, onClose }: { hiddenCase: HiddenCase; snap: CaseSnapshot; onClose: () => void }) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const weighed = snap.board.filter((c) => c.weighed).map((c) => c.id);
  const lines = independentLines(weighed).length;
  return (
    <Panel label="Evidence board · the van" title="Does the evidence back the machine?" onClose={onClose}>
      <div className="rounded-xl border border-rose-300/25 bg-rose-400/[.06] p-3">
        <div className="text-[8px] font-bold uppercase tracking-[.2em] text-rose-300">The claim · {CLAIM.source}</div>
        <div className="mt-1 font-sans text-[13px] text-white/90">{CLAIM.title}</div>
        <p className="mt-1 font-sans text-[11px] leading-relaxed text-white/55">{CLAIM.summary}</p>
      </div>
      <p className="mt-3 font-sans text-[11.5px] leading-relaxed text-white/65">{RADIO.board}</p>
      {snap.board.length === 0 ? (
        <p className="mt-3 font-sans text-[12px] text-white/50">
          Nothing on the board yet. You can still hand in a verdict on the claim alone.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {snap.board.map((c) => (
            <li
              key={c.id}
              className={`rounded-xl border p-3 transition ${c.weighed ? "border-[#7fd6d0]/35 bg-[#0B5D63]/20" : "border-white/10 bg-white/[.02] opacity-70"}`}
            >
              <div className="text-[8px] uppercase tracking-[.18em] text-white/40">{c.source}</div>
              <div className="mt-1 font-sans text-[12.5px] text-white/90">{c.title}</div>
              <p className="mt-1 font-sans text-[11px] leading-relaxed text-white/55">{c.summary}</p>
              <button
                onClick={() => hiddenCase.toggleWeigh(c.id)}
                className={`mt-2 rounded-md px-2 py-1 text-[9px] uppercase tracking-[.16em] ${c.weighed ? "bg-[#7fd6d0] text-[#03201f]" : "border border-white/15 text-white/60"}`}
              >
                {c.weighed ? "Weighing it" : "Set aside"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 rounded-xl border border-white/10 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[8px] font-bold uppercase tracking-[.2em] text-white/50">Your verdict</span>
          <span className="font-sans text-[11px] text-white/45">
            Weighing {weighed.length} card{weighed.length === 1 ? "" : "s"} · {lines} independent line{lines === 1 ? "" : "s"}
          </span>
        </div>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
          {(
            [
              ["accept", "Accept the attribution"],
              ["reject", "Reject it"],
              ["abstain", "Abstain: not enough yet"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setVerdict(id)}
              aria-pressed={verdict === id}
              className={`rounded-lg border px-3 py-2 font-sans text-[12px] transition ${verdict === id ? "border-[#7fd6d0] bg-[#7fd6d0]/15 text-white" : "border-white/15 text-white/70 hover:bg-white/5"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-3 font-sans text-[12px] text-white/70">How certain are you?</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {CONFIDENCE_CHOICES.map((c) => (
            <button
              key={c}
              onClick={() => setConfidence(c)}
              aria-pressed={confidence === c}
              className={`rounded-md border px-3 py-1.5 text-[11px] tabular-nums transition ${confidence === c ? "border-[#7fd6d0] bg-[#7fd6d0]/15 text-white" : "border-white/15 text-white/60 hover:bg-white/5"}`}
            >
              {c}%
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <PrimaryButton
            disabled={!verdict || !confidence}
            onClick={() => verdict && confidence && hiddenCase.submit(verdict, confidence)}
          >
            Hand in the verdict
          </PrimaryButton>
          <span className="font-sans text-[10px] text-white/40">Once it's in, the case answers. You can replay it afterwards.</span>
        </div>
      </div>
    </Panel>
  );
}

function EndingCard({
  snap,
  onClose,
  onReplay,
  onSurvey,
  onNext,
}: {
  snap: CaseSnapshot;
  onClose: () => void;
  onReplay: () => void;
  onSurvey: () => void;
  onNext: () => void;
}) {
  const ending = snap.ending ? ENDINGS[snap.ending] : null;
  if (!ending) return null;
  return (
    <section className={`${glass} rounded-2xl p-6`} aria-label={ending.title}>
      <div className={`text-[8px] font-bold uppercase tracking-[.24em] ${teal}`}>
        Verdict · {snap.verdict} at {snap.confidence}%
      </div>
      <h2 className="mt-1 font-sans text-3xl font-light tracking-tight">{ending.title}</h2>
      <p className="mt-3 font-sans text-[13px] leading-relaxed text-white/75">{ending.epilogue}</p>
      <blockquote className="mt-4 border-l-2 border-[#7fd6d0]/50 pl-3 font-sans text-[13px] italic leading-relaxed text-[#bfe9e5]">
        {ending.rain}
        <footer className="mt-1 not-italic text-[9px] uppercase tracking-[.2em] text-[#7fd6d0]/70">R.A.I.N.</footer>
      </blockquote>
      {snap.auditNotes.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {snap.auditNotes.map((n) => (
            <li key={n} className="flex gap-2 font-sans text-[12px] leading-snug text-white/60">
              <span className={teal}>·</span>
              {n}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-[9px] uppercase tracking-[.2em] text-white/35">
        Endings found {snap.endingsSeen.length}/{Object.keys(ENDINGS).length}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <PrimaryButton onClick={onClose}>{ending.closes ? "Walk the site" : "Back to the field"}</PrimaryButton>
        {ending.closes && <PrimaryButton onClick={onNext}>Open the next transmission</PrimaryButton>}
        {ending.closes && <QuietButton onClick={onReplay}>Replay the case</QuietButton>}
        <QuietButton onClick={onSurvey}>Return to the survey</QuietButton>
      </div>
    </section>
  );
}

function FieldDesk({ hiddenCase, snap, onClose }: { hiddenCase: HiddenCase; snap: CaseSnapshot; onClose: () => void }) {
  const [dial, setDial] = useState<number | null>(null);
  const run = snap.expeditions.at(-1);
  if (!run || snap.panel?.kind !== "field") return null;
  const mission = EXPEDITIONS[run.chapter];
  const stationId = snap.panel.station;
  const station = mission.stations.find(s => s.id === stationId);
  const instrument = station && instrumentFor(station.id);
  const value = dial ?? instrument?.low ?? 0;
  const level = instrument ? responseAt(value, instrument.center) : 1;
  const verdict = run.verdict !== null;
  const choices = station ? station.choices : canFile(run) && !verdict ? mission.verdicts : [];
  return <Panel label={`Field transmission 0${run.chapter + 2} · Fiction`} title={station?.place ?? mission.title} onClose={onClose}>
    <p className="font-sans text-[15px] leading-relaxed text-white/90">
      {station ? station.prompt : verdict ? fieldEnding(snap.expeditions) : mission.briefing}
    </p>
    {instrument && <div className="my-3 rounded-lg border border-white/15 p-3">
      <label className="flex justify-between text-xs text-amber-200" htmlFor="field-dial">
        {instrument.label}<span>{value} {instrument.unit}</span>
      </label>
      <input id="field-dial" className="mt-3 w-full accent-[#7fd6d0]" type="range" min={instrument.low} max={instrument.high}
        onKeyDown={e => e.stopPropagation()} value={value} onChange={e => { const v = Number(e.target.value); setDial(v); hiddenCase.listenToDial(v); }} />
      <meter aria-label="Signal coherence" value={level} min={0} max={1} className="w-full" />
      <p className="mt-1 text-xs text-white/70">{level >= .88 ? "Stable trace · ready to record" : instrument.hint}</p>
    </div>}
    {!station && !verdict && <ul className="my-3 space-y-2 text-xs">{mission.stations.map(s =>
      <li key={s.id} className={Object.hasOwn(run.records, s.id) ? "text-[#7fd6d0]" : "text-white/65"}>
        {s.place}{s.optional ? " (optional)" : ""} · {s.choices[run.records[s.id]]?.result ??
          (availableStations(run).includes(s) ? "Awaiting field reading" : "Awaiting first reading")}</li>)}</ul>}
    {!station && canFile(run) && !verdict && <p className="my-3 text-sm text-amber-200">{mission.question}</p>}
    <div className="mt-4 flex flex-wrap gap-2">{choices.map((c, i) =>
      <PrimaryButton key={c.label} disabled={!!instrument && c.supported && level < .88} onClick={() => hiddenCase.recordFieldChoice(i, value)}>{c.label}</PrimaryButton>)}
      {verdict && run.chapter < EXPEDITIONS.length - 1 && <PrimaryButton onClick={() => hiddenCase.nextTransmission()}>Open the next transmission</PrimaryButton>}
      {verdict && run.chapter === EXPEDITIONS.length - 1 && <QuietButton onClick={() => hiddenCase.replay()}>Replay from case one</QuietButton>}
    </div>
  </Panel>;
}

function CaseFilePanel({ hiddenCase, snap, onClose }: { hiddenCase: HiddenCase; snap: CaseSnapshot; onClose: () => void }) {
  return (
    <Panel label="Case file · Fiction" title="99.9% SURE" onClose={onClose}>
      <div className="mb-4"><QuietButton onClick={() => hiddenCase.toggleRadio()}>
        {snap.radioEnabled ? "Mute field commentary" : "Hear R.A.I.N. on the field radio"}
      </QuietButton></div>
      <h3 className="text-[8px] font-bold uppercase tracking-[.2em] text-white/45">Evidence</h3>
      <ul className="mt-1.5 space-y-1 font-sans text-[12px] text-white/75">
        <li className="text-rose-200/80">{CLAIM.title}</li>
        {snap.board.map((c) => (
          <li key={c.id}>
            {c.title} <span className="text-white/35">· {c.source}</span>
          </li>
        ))}
      </ul>
      <h3 className="mt-4 text-[8px] font-bold uppercase tracking-[.2em] text-white/45">
        Field notes {snap.documents.length}/{FIELD_NOTES.length}
      </h3>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {FIELD_NOTES.map((n) =>
          snap.documents.includes(n.id) ? (
            <button
              key={n.id}
              onClick={() => hiddenCase.openNote(n.id)}
              className="rounded-md border border-white/15 px-2 py-1 font-sans text-[11px] text-white/75 transition hover:bg-white/10"
            >
              {n.title}
            </button>
          ) : (
            <span key={n.id} className="rounded-md border border-dashed border-white/10 px-2 py-1 font-sans text-[11px] text-white/25">
              Not found
            </span>
          ),
        )}
      </div>
      <h3 className="mt-4 text-[8px] font-bold uppercase tracking-[.2em] text-white/45">
        Endings {snap.endingsSeen.length}/{Object.keys(ENDINGS).length}
      </h3>
      <p className="mt-1 font-sans text-[12px] text-white/60">
        {snap.endingsSeen.length ? snap.endingsSeen.map((e) => ENDINGS[e].title).join(" · ") : "None yet."}
      </p>
      <section className="mt-4 border-t border-white/10 pt-3">
        <h3 className="text-sm text-amber-200">Optional · Blind calibration</h3>
        <p className="my-2 text-xs text-white/70">{snap.rover?.message ?? (snap.calibration
          ? "Notebook: both sealed pads measured 96 Hz. The pickup heard its own motor."
          : "Ines left a wheeled pickup on the short test strip beside the van. Measure both pads yourself or invite Jev to operate it.")}</p>
        <div className="flex flex-wrap gap-2">
          {!snap.rover && <QuietButton onClick={() => hiddenCase.activateRover()}>Unpack the rover</QuietButton>}
          {snap.rover && !snap.rover.complete && (snap.rover.autonomous
            ? <PrimaryButton onClick={() => hiddenCase.operateRover("human")}>Take control · H</PrimaryButton>
            : <>{snap.rover.choices.map(c => <QuietButton key={c.target} onClick={() => hiddenCase.operateRover(c.target)}>{c.label}</QuietButton>)}
              <QuietButton onClick={() => hiddenCase.operateRover("jev")}>Connect live Jev</QuietButton></>)}
          {snap.rover && <QuietButton onClick={() => {
            const trace = hiddenCase.roverTrace();
            if (!trace) return;
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([trace], {type: "application/json"}));
            link.download = "calibration-trace.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
          }}>Export rover trace</QuietButton>}
        </div>
      </section>
      {snap.expeditions.map((r) => {
        const m = EXPEDITIONS[r.chapter];
        return <section key={m.id} className="mt-4 border-t border-white/10 pt-3">
          <h3 className="text-sm text-amber-200">0{r.chapter + 2} · {m.title}</h3>
          <p className="mt-1 text-xs text-white/70">{m.briefing}</p>
          <ul className="mt-2 space-y-1 text-xs">{m.stations.map(station =>
            <li key={station.id}>{station.place}{station.optional ? " (optional)" : ""} · {station.choices[r.records[station.id]]?.result ?? "No reading yet"}</li>)}</ul>
          {r.verdict !== null && <p className="mt-2 text-xs text-[#7fd6d0]">{m.verdicts[r.verdict].label} · {fieldEnding(snap.expeditions.slice(0, r.chapter + 1))}</p>}
        </section>;
      })}
    </Panel>
  );
}

function Controls({ isMobile }: { isMobile: boolean }) {
  return (
    <p className="mt-4 border-t border-white/10 pt-3 font-sans text-[11px] leading-relaxed text-white/40">
      {isMobile
        ? "Left thumb to move, drag to look. Interact talks, reads, takes a bearing or a vehicle. Any utility truck is yours to drive."
        : "WASD to move, Shift to sprint, Space to jump. E (or F) talks, reads, takes a bearing or a vehicle. J opens the case file, Esc pauses."}
    </p>
  );
}
