import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Columns2,
  Download,
  Film,
  Heart,
  Hand,
  LogOut,
  Navigation,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Timer,
  TriangleAlert,
  User,
  Users,
  WifiOff,
} from "lucide-react";
import type { Game } from "@/game/Game";
import type { FreeRoamSnapshot } from "@/game/freeroam/FreeRoamHud";
import type { JevHudSnapshot } from "@/agent/freeroam/hud";
import type { RunEntry } from "@/agent/freeroam/session";
import { useFreeRoam, useJevControl, useRuns } from "@/hooks/use-free-roam";
import { downloadFreeRoamTrace, formatClock, formatValue } from "@/lib/freeroam-ui";

/**
 * Free Roam's screen furniture: the objective, health, ammunition and the
 * attention meter; the JEV CONTROL panel (what Jev is trying to do, what it
 * decided, how sure it was, what the local controllers do next, how long it
 * took); the switch that hands the avatar between the person, Jev and the
 * two together; and, when a run ends, the results, the comparison with the
 * other controller's run and the replay.
 *
 * Everything shown is a measurement or a phrase. Nothing here reads a
 * provider's reasoning, and nothing writes to the world: buttons call the
 * same session methods the keys do.
 */

const glass =
  "border border-white/10 bg-[#071014]/80 text-white shadow-[0_16px_50px_rgba(0,0,0,.28)] backdrop-blur-xl";
const chip =
  "rounded-md border border-white/15 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[.16em] text-white/80 transition hover:bg-white/10 disabled:opacity-40";

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.4rem] items-center justify-center rounded border border-white/15 bg-white/[.08] px-1 py-px font-mono text-[9px] text-white/80">
      {children}
    </kbd>
  );
}

// --- Objective ------------------------------------------------------------------------------------

function ObjectiveBanner({ fr }: { fr: FreeRoamSnapshot }) {
  const o = fr.objective;
  const [open, setOpen] = useState(false);
  if (!o) return null;
  const left = fr.timeLimitS === null ? null : Math.max(0, fr.timeLimitS - fr.elapsedS);
  const arrow = o.bearingDeg;
  return (
    <div className="pointer-events-auto absolute left-1/2 top-3 w-[min(30rem,92vw)] -translate-x-1/2 sm:top-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${glass} block w-full rounded-xl px-4 py-2.5 text-left`}
        aria-expanded={open}
        aria-label="Objective; press to show the success conditions"
      >
        <div className="flex items-center justify-between gap-3 text-[9px] font-bold uppercase tracking-[.2em] text-sky-300">
          <span className="truncate">
            {fr.challengeTitle}
            {o.stageCount > 1 && ` · stage ${Math.min(o.stageIndex + 1, o.stageCount)}/${o.stageCount}`}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-white/60">
            <Timer size={10} /> {formatClock(fr.elapsedS)}
            {left !== null && <span className="text-white/35">/ {formatClock(fr.timeLimitS ?? 0)}</span>}
          </span>
        </div>
        <div className="mt-1 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-sans text-[13px] font-medium text-white">{o.title}</div>
            <div className="line-clamp-2 font-sans text-[11px] leading-snug text-white/55">{o.hint}</div>
          </div>
          {o.distanceM !== null && (
            <div className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-amber-200">
              <Navigation
                size={14}
                style={{ transform: `rotate(${arrow ?? 0}deg)` }}
                aria-label={arrow === null ? undefined : `${arrow > 0 ? "right" : "left"} ${Math.abs(arrow)} degrees`}
              />
              {o.distanceM} m
            </div>
          )}
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-sky-400 transition-[width] duration-300" style={{ width: `${Math.round(o.progress * 100)}%` }} />
        </div>
      </button>
      {open && fr.criteria && (
        <div className={`${glass} mt-1.5 rounded-xl px-4 py-2.5 font-sans text-[11px]`}>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[.2em] text-white/40">Success</div>
          <ul className="space-y-0.5">
            {fr.criteria.success.map((c) => (
              <li key={c.id} className={c.met ? "text-emerald-300" : "text-white/70"}>
                {c.met ? "✓" : "○"} {c.label}
                <span className="ml-1 text-white/35">
                  ({formatValue(Math.round(c.actual * 10) / 10, "")} {c.op} {c.value})
                </span>
              </li>
            ))}
          </ul>
          {fr.criteria.failure.length > 0 && (
            <>
              <div className="mb-1 mt-2 text-[9px] font-bold uppercase tracking-[.2em] text-white/40">Fails if</div>
              <ul className="space-y-0.5">
                {fr.criteria.failure.map((c) => (
                  <li key={c.id} className={c.met ? "text-rose-300" : "text-white/55"}>
                    {c.label}
                  </li>
                ))}
              </ul>
            </>
          )}
          {fr.environment.length > 0 && <div className="mt-2 text-amber-200/80">{fr.environment.join(" · ")}</div>}
        </div>
      )}
    </div>
  );
}

// --- Vitals -----------------------------------------------------------------------------------------

const PIP = ["bg-emerald-400", "bg-lime-300", "bg-yellow-300", "bg-orange-400", "bg-red-500"];

function Vitals({ fr }: { fr: FreeRoamSnapshot }) {
  const pct = Math.max(0, Math.min(100, (fr.health / fr.maxHealth) * 100));
  const a = fr.attention;
  return (
    <div className={`${glass} pointer-events-none absolute left-3 top-[4.6rem] w-52 rounded-xl px-3 py-2.5 sm:left-5 sm:top-[5.4rem]`}>
      <div className="flex items-center gap-2">
        <Heart size={12} className={fr.alive ? "text-rose-300" : "text-white/30"} />
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <div className={`h-full transition-[width] duration-200 ${pct < 30 ? "bg-red-500" : "bg-rose-400"}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="w-7 text-right text-[10px] tabular-nums text-white/70">{fr.health}</span>
      </div>
      <div className="mt-2 flex items-center justify-between text-[9px] uppercase tracking-[.16em] text-white/45">
        <span>Sidearm</span>
        <span className={`tabular-nums ${fr.weapon.ammo === 0 ? "text-rose-300" : "text-white/80"}`}>
          {fr.weapon.reloading ? "reloading…" : `${fr.weapon.ammo} / ${fr.weapon.reserve}`}
        </span>
      </div>
      <div className="mt-2">
        <div className="flex items-center justify-between text-[9px] uppercase tracking-[.16em] text-white/45">
          <span className="flex items-center gap-1">
            <ShieldAlert size={10} /> Attention
          </span>
          <span className={a.level >= 3 ? "text-red-300" : "text-white/80"}>
            {a.name}
            {a.pursuing && " · pursuit"}
          </span>
        </div>
        <div className="mt-1 flex gap-1" role="meter" aria-valuemin={0} aria-valuemax={5} aria-valuenow={a.level} aria-label="Attention">
          {PIP.map((color, i) => (
            <span
              key={color}
              className={`h-1.5 flex-1 rounded-sm ${i < a.level ? color : "bg-white/10"} ${a.pursuing && i < a.level ? "animate-pulse" : ""}`}
            />
          ))}
        </div>
      </div>
      {fr.collected.total > 0 && (
        <div className="mt-2 flex items-center justify-between text-[9px] uppercase tracking-[.16em] text-white/45">
          <span>Signal shards</span>
          <span className="tabular-nums text-teal-200">
            {fr.collected.count} / {fr.collected.total}
          </span>
        </div>
      )}
    </div>
  );
}

function Crosshair({ fr }: { fr: FreeRoamSnapshot }) {
  if (!fr.aiming) return null;
  const tone =
    fr.crosshair === "hostile"
      ? "bg-red-400"
      : fr.crosshair === "person"
        ? "bg-amber-300"
        : fr.crosshair === "vehicle"
          ? "bg-sky-300"
          : "bg-white/90";
  const tick = `absolute ${tone} rounded-full`;
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2" aria-hidden>
      <span className={`${tick} left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2`} />
      <span className={`${tick} left-1/2 top-0 h-2.5 w-px -translate-x-1/2`} />
      <span className={`${tick} bottom-0 left-1/2 h-2.5 w-px -translate-x-1/2`} />
      <span className={`${tick} left-0 top-1/2 h-px w-2.5 -translate-y-1/2`} />
      <span className={`${tick} right-0 top-1/2 h-px w-2.5 -translate-y-1/2`} />
    </div>
  );
}

/** A red edge on damage: a cue, not a mechanic. */
function DamageFlash({ health }: { health: number }) {
  const [on, setOn] = useState(false);
  const last = useRef(health);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (health < last.current) {
      setOn(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), 320);
    }
    last.current = health;
  }, [health]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div
      className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${on ? "opacity-100" : "opacity-0"}`}
      style={{ boxShadow: "inset 0 0 120px 20px rgba(220,38,38,.45)" }}
      aria-hidden
    />
  );
}

// --- JEV CONTROL --------------------------------------------------------------------------------------

const STATE_TEXT: Record<JevHudSnapshot["state"], string> = {
  OFF: "Off",
  HUMAN_CONTROL: "Human control",
  ASSISTING: "Assisting",
  OBSERVING: "Observing",
  THINKING: "Deciding",
  ACTING: "Acting",
  HOLD: "Holding",
  OFFLINE: "Offline",
  COMPLETE: "Complete",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.6rem_1fr] gap-2 py-0.5">
      <span className="pt-px text-[8px] font-bold uppercase tracking-[.2em] text-white/35">{label}</span>
      <span className="min-w-0 font-sans text-[10.5px] leading-snug text-white/85">{children}</span>
    </div>
  );
}

const STEPS: { id: JevHudSnapshot["stage"]; label: string }[] = [
  { id: "observe", label: "Observe" },
  { id: "decide", label: "Decide" },
  { id: "act", label: "Act" },
];

function JevPanel({ jev, onTakeControl }: { jev: JevHudSnapshot; onTakeControl: () => void }) {
  if (jev.mode === "HUMAN" || jev.replaying) return null;
  const assisting = jev.mode === "ASSIST";
  const offline = jev.state === "OFFLINE" || jev.state === "HOLD";
  const tone = offline ? "text-amber-300" : "text-[#7fd6d0]";
  const conf = jev.confidence === null ? null : Math.round(jev.confidence * 100);
  return (
    <section
      className={`${glass} pointer-events-auto absolute right-3 top-[4.6rem] w-72 rounded-xl p-3 sm:right-5 sm:top-[5.4rem]`}
      aria-label={assisting ? "Jev assist" : "Jev control"}
    >
      <div className="flex items-center justify-between gap-2">
        <div className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.24em] ${tone}`}>
          {offline ? <WifiOff size={12} /> : <Bot size={12} />}
          {assisting ? "Jev assist" : "Jev control"}
        </div>
        <span
          className={`rounded-sm px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[.16em] ${
            offline ? "bg-amber-400/20 text-amber-200" : "bg-[#0B5D63]/70 text-[#c6efec]"
          }`}
        >
          {STATE_TEXT[jev.state]}
        </span>
      </div>
      {jev.provider && jev.provider.id === "baseline" && (
        <div className="mt-1 text-[9px] uppercase tracking-[.16em] text-white/40">Scripted baseline · not Jev</div>
      )}

      {jev.hold && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300/30 bg-amber-300/10 px-2.5 py-2 font-sans text-[11px] leading-snug text-amber-100">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>
            {jev.hold}
            {jev.failure && <span className="block text-[10px] text-amber-200/60">{jev.failure.kind.replace(/_/g, " ")}</span>}
          </span>
        </div>
      )}
      {jev.notice?.kind === "recovered" && jev.notice.ageMs < 4000 && (
        <div className="mt-2 rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-2.5 py-1.5 font-sans text-[11px] text-emerald-100">
          Jev is back.
        </div>
      )}

      {assisting ? (
        <div className="mt-2">
          <Row label="Advice">{jev.advice ? jev.advice.phrase : "Watching"}</Row>
          <Row label="Warning">{jev.assist.warning ?? "—"}</Row>
          <Row label="Hint">{jev.assist.hint ?? "—"}</Row>
          <Row label="Target">{jev.assist.target ?? "—"}</Row>
          <Row label="Helped">
            {jev.assist.nudges} nudge{jev.assist.nudges === 1 ? "" : "s"}
            {jev.assist.active && <span className="ml-1 text-sky-300">· now</span>}
          </Row>
          <Row label="Latency">{jev.latencyMs === null ? "—" : `${jev.latencyMs} ms`}</Row>
        </div>
      ) : (
        <div className="mt-2">
          <Row label="Goal">{jev.goal ?? "—"}</Row>
          <Row label="Decision">
            {jev.decision ?? "Waiting for the first decision"}
            {jev.disposition === "rejected" && <span className="ml-1 text-rose-300">· refused</span>}
          </Row>
          <Row label="Confidence">
            {conf === null ? (
              "—"
            ) : (
              <span className="flex items-center gap-2">
                <span className="h-1 w-24 overflow-hidden rounded-full bg-white/10">
                  <span className="block h-full bg-[#7fd6d0]" style={{ width: `${conf}%` }} />
                </span>
                <span className="tabular-nums">{conf}%</span>
              </span>
            )}
          </Row>
          <Row label="Next">{jev.next ?? "—"}</Row>
          <Row label="Latency">
            {jev.latencyMs === null ? "—" : `${jev.latencyMs} ms`}
            <span className="ml-1 text-white/40">· every {(jev.cadenceMs / 1000).toFixed(1)} s</span>
          </Row>
          {jev.outcome && <Row label="Before">{jev.outcome}</Row>}
          <div className="mt-2 flex items-center gap-1 text-[8px] font-bold uppercase tracking-[.16em]" aria-label="Observe, decide, act">
            {STEPS.map((s, i) => (
              <span key={s.id} className="flex items-center gap-1">
                {i > 0 && <span className="text-white/25">→</span>}
                <span
                  className={`rounded px-1.5 py-0.5 ${jev.stage === s.id ? "bg-[#7fd6d0] text-[#04191b]" : "bg-white/5 text-white/35"}`}
                >
                  {s.label}
                </span>
              </span>
            ))}
            <span className="ml-auto tabular-nums text-white/35">{jev.decisions} decisions</span>
          </div>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="font-sans text-[10px] text-white/40">
          <Kbd>H</Kbd> take control
        </span>
        <button className={chip} onClick={onTakeControl}>
          <Hand size={10} className="mr-1 inline" /> Take control
        </button>
      </div>
    </section>
  );
}

// --- Who is playing ------------------------------------------------------------------------------------

function ControllerBar({
  game,
  jev,
  onLeave,
  onTakeControl,
  onLetJev,
  onAssist,
}: {
  game: Game;
  jev: JevHudSnapshot;
  onLeave: () => void;
  onTakeControl: () => void;
  onLetJev: () => void;
  onAssist: () => void;
}) {
  if (jev.replaying) return null;
  const item = (active: boolean) =>
    `flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[.16em] transition ${
      active ? "bg-sky-400 text-[#04121c]" : "text-white/70 hover:bg-white/10"
    }`;
  return (
    <div className="pointer-events-auto absolute bottom-12 left-1/2 flex -translate-x-1/2 items-center gap-2 sm:bottom-14">
      <div className={`${glass} flex overflow-hidden rounded-xl`} role="group" aria-label="Who is playing">
        <button className={item(jev.mode === "HUMAN")} onClick={onTakeControl} aria-pressed={jev.mode === "HUMAN"}>
          <User size={12} /> You
        </button>
        <button className={item(jev.mode === "JEV")} onClick={onLetJev} aria-pressed={jev.mode === "JEV"} title="Let Jev play (J)">
          <Bot size={12} /> Jev
        </button>
        <button className={item(jev.mode === "ASSIST")} onClick={onAssist} aria-pressed={jev.mode === "ASSIST"} title="Jev assists you (K)">
          <Users size={12} /> Assist
        </button>
      </div>
      <button
        className={`${glass} rounded-xl px-3 py-2 text-[9px] font-bold uppercase tracking-[.16em] text-white/75 transition hover:bg-white/10`}
        onClick={() => game.roam.restart()}
        title="Start the same scenario again, in your hands"
      >
        <RotateCcw size={11} className="mr-1 inline" /> Reset
      </button>
      <button
        className={`${glass} rounded-xl px-3 py-2 text-[9px] font-bold uppercase tracking-[.16em] text-white/55 transition hover:bg-white/10`}
        onClick={onLeave}
        title="Leave Free Roam"
      >
        <LogOut size={11} className="mr-1 inline" /> Leave
      </button>
    </div>
  );
}

// --- Replay -----------------------------------------------------------------------------------------------

function ReplayBar({ game, jev }: { game: Game; jev: JevHudSnapshot }) {
  const r = jev.replay;
  if (!jev.replaying || !r) return null;
  const replayer = game.roam.replay;
  const setSpeed = (s: number) => {
    if (replayer) replayer.speed = s;
  };
  return (
    <div className={`${glass} pointer-events-auto absolute bottom-12 left-1/2 w-[min(34rem,94vw)] -translate-x-1/2 rounded-xl px-4 py-3 sm:bottom-14`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-violet-300">
          <Film size={12} /> Replay · {r.label}
        </div>
        <span className="font-sans text-[10px] text-white/40">No decision service is called</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full bg-violet-400" style={{ width: `${Math.round(r.progress * 100)}%` }} />
      </div>
      {r.drifted && (
        <p className="mt-1.5 font-sans text-[10px] text-amber-200/80">
          This replay no longer matches the recording exactly (the game changed since it was made).
        </p>
      )}
      {game.freeRoam.visuals?.ghostLabel && (
        <p className="mt-1.5 font-sans text-[10px] text-cyan-200/80">Ghost: {game.freeRoam.visuals.ghostLabel}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button className={chip} onClick={() => replayer && (replayer.paused = !replayer.paused)}>
          {r.paused ? <Play size={10} className="mr-1 inline" /> : <Pause size={10} className="mr-1 inline" />}
          {r.paused ? "Play" : "Pause"}
        </button>
        {[0.5, 1, 2, 4].map((s) => (
          <button key={s} className={`${chip} ${r.speed === s ? "bg-white/15" : ""}`} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
        <button className={`${chip} ml-auto`} onClick={() => game.roam.leaveReplay()}>
          Back to play
        </button>
      </div>
    </div>
  );
}

// --- Results --------------------------------------------------------------------------------------------------

function runName(r: RunEntry): string {
  return `${r.label} · ${r.status === "success" ? "done" : r.status} · ${Math.round(r.summary.outcome.elapsedS)} s`;
}

function CompareTable({ game, aId, bId }: { game: Game; aId: string; bId: string }) {
  const table = useMemo(() => game.roam.compare(aId, bId), [game, aId, bId]);
  if (!table) return null;
  const nameOf = (id: string) => (table.a.id === id ? table.a : table.b).label.replace(/ run$/, "");
  let group = "";
  return (
    <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-white/10">
      <table className="w-full border-collapse text-left font-sans text-[11px]">
        <thead className="sticky top-0 bg-[#0b1a24] text-[9px] uppercase tracking-[.16em] text-white/45">
          <tr>
            <th className="px-2 py-1.5 font-bold">Measure</th>
            <th className="px-2 py-1.5 font-bold">{nameOf(aId)} · A</th>
            <th className="px-2 py-1.5 font-bold">{nameOf(bId)} · B</th>
            <th className="px-2 py-1.5 text-right font-bold">B − A</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => {
            const header = row.group !== group;
            group = row.group;
            return (
              <Fragment key={`${row.group}-${row.label}`}>
                {header && (
                  <tr>
                    <td colSpan={4} className="bg-white/[.04] px-2 py-1 text-[8px] font-bold uppercase tracking-[.2em] text-sky-300/80">
                      {row.group}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-white/5">
                  <td className="px-2 py-1 text-white/70">{row.label}</td>
                  <td className="px-2 py-1 tabular-nums text-white/90">{formatValue(row.a, row.unit)}</td>
                  <td className="px-2 py-1 tabular-nums text-white/90">{formatValue(row.b, row.unit)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-white/45">
                    {row.delta === null ? "" : `${row.delta > 0 ? "+" : ""}${Math.round(row.delta * 100) / 100}`}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-white/5 px-2 py-1.5 font-sans text-[10px] text-white/35">
        Measurements side by side. Nothing here says which run was better: that depends on what you value.
      </p>
    </div>
  );
}

function Results({
  game,
  fr,
  runs,
  onLeave,
}: {
  game: Game;
  fr: FreeRoamSnapshot;
  runs: readonly RunEntry[];
  onLeave: () => void;
}) {
  const o = fr.objective;
  const finished = o !== null && (o.status === "success" || o.status === "failed");
  const here = runs.filter((r) => r.seed === fr.seed && r.challenge === fr.challengeId);
  const latest = here[0] ?? null;
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const [showCompare, setShowCompare] = useState(false);

  // Default the comparison to the newest run of two different controllers on this scenario.
  const defaults = useMemo(() => {
    const first = here[0];
    if (!first) return null;
    const other = here.find((r) => r.controller !== first.controller) ?? here[1];
    return other ? { a: other.id, b: first.id } : null;
  }, [here]);
  useEffect(() => {
    if (!defaults) return;
    if (!here.some((r) => r.id === a)) setA(defaults.a);
    if (!here.some((r) => r.id === b)) setB(defaults.b);
  }, [defaults, here, a, b]);

  if (!finished || !o) return null;
  const won = o.status === "success";
  const s = latest?.summary;
  const line = (label: string, value: string) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/5 py-1 font-sans text-[11px]">
      <span className="text-white/50">{label}</span>
      <span className="tabular-nums text-white/90">{value}</span>
    </div>
  );
  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4">
      <section className={`${glass} max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl`} aria-label="Run results">
        <div className={`h-px bg-gradient-to-r from-transparent ${won ? "via-emerald-300/80" : "via-rose-300/80"} to-transparent`} />
        <div className="p-5 sm:p-6">
          <div className={`text-[9px] font-bold uppercase tracking-[.26em] ${won ? "text-emerald-300" : "text-rose-300"}`}>
            {won ? "Objective complete" : "Objective failed"} · {fr.challengeTitle} · seed {fr.seed}
          </div>
          <h2 className="mt-1 font-sans text-2xl font-light tracking-tight">
            {latest ? latest.label : "Run"} · {formatClock(fr.elapsedS)}
          </h2>
          {!won && o.failReason && <p className="mt-1 font-sans text-[12px] text-rose-200/80">{o.failReason}</p>}

          {s && (
            <div className="mt-4 grid gap-x-8 sm:grid-cols-2">
              <div>
                {line("Distance on foot", formatValue(s.navigation.distanceOnFootM, "m"))}
                {line("Distance driven", formatValue(s.navigation.distanceDrivenM, "m"))}
                {line("Route efficiency", formatValue(s.navigation.routeEfficiency, ""))}
                {line("Vehicle / pedestrian / world hits", `${s.driving.vehicleCollisions} / ${s.driving.pedestrianCollisions} / ${s.driving.worldCollisions}`)}
                {line("Average speed", formatValue(s.driving.avgSpeedMps, "m/s"))}
                {line("Braking efficiency", formatValue(s.driving.brakingEfficiency, ""))}
              </div>
              <div>
                {line("Shots fired / hit", `${s.shooting.shotsFired} / ${s.shooting.shotsHit}`)}
                {line("Accuracy", formatValue(s.shooting.accuracy, ""))}
                {line("Damage caused / received", `${Math.round(s.combat.damageDealt)} / ${Math.round(s.combat.damageReceived)}`)}
                {line("Attention peak", `${s.attention.peakLevel} / 5`)}
                {line("Decisions · interventions", `${s.control.decisions} · ${s.control.interventions}`)}
                {line("Mean decision latency", formatValue(s.control.meanLatencyMs, "ms"))}
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button className={`${chip} bg-sky-400 text-[#04121c] hover:bg-sky-300`} onClick={() => game.roam.restart()}>
              <RotateCcw size={10} className="mr-1 inline" /> Run it yourself
            </button>
            <button
              className={chip}
              onClick={() => {
                game.roam.restart();
                game.roam.setController("JEV", "jev");
              }}
            >
              <Bot size={10} className="mr-1 inline" /> Let Jev play this seed
            </button>
            {latest && (
              <button className={chip} onClick={() => game.roam.replayRun(latest.id)}>
                <Film size={10} className="mr-1 inline" /> Watch replay
              </button>
            )}
            <button className={chip} onClick={() => setShowCompare((v) => !v)} disabled={here.length < 2}>
              <Columns2 size={10} className="mr-1 inline" /> Compare
            </button>
            {latest && (
              <button className={chip} onClick={() => downloadFreeRoamTrace(game, latest.id)}>
                <Download size={10} className="mr-1 inline" /> Trace
              </button>
            )}
            <button className={`${chip} ml-auto text-white/55`} onClick={onLeave}>
              Leave
            </button>
          </div>
          {here.length < 2 && (
            <p className="mt-2 font-sans text-[11px] text-white/40">
              Play this seed again as someone else (you, Jev or both) to compare the two runs.
            </p>
          )}

          {showCompare && here.length >= 2 && (
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-2 font-sans text-[11px] text-white/55">
                <label className="flex items-center gap-1.5">
                  A
                  <select value={a} onChange={(e) => setA(e.target.value)} className="rounded border border-white/15 bg-[#0a1822] px-1.5 py-1 text-white">
                    {here.map((r) => (
                      <option key={r.id} value={r.id}>
                        {runName(r)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5">
                  B
                  <select value={b} onChange={(e) => setB(e.target.value)} className="rounded border border-white/15 bg-[#0a1822] px-1.5 py-1 text-white">
                    {here.map((r) => (
                      <option key={r.id} value={r.id}>
                        {runName(r)}
                      </option>
                    ))}
                  </select>
                </label>
                <button className={chip} onClick={() => game.roam.replayRun(a, b)} disabled={!a || !b || a === b} title="Watch A with B's path drawn as a ghost">
                  <Film size={10} className="mr-1 inline" /> Watch A with B as ghost
                </button>
              </div>
              {a && b && <CompareTable game={game} aId={a} bId={b} />}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// --- Assembly ----------------------------------------------------------------------------------------------

export function FreeRoamOverlay({
  game,
  isMobile,
  locked,
  onLeave,
  onReleasePointer,
  onCapture,
}: {
  game: Game;
  isMobile: boolean;
  /** The mouse is captured by the game. */
  locked: boolean;
  onLeave: () => void;
  onReleasePointer: () => void;
  onCapture: () => void;
}) {
  const fr = useFreeRoam(game);
  const jev = useJevControl(game);
  const runs = useRuns(game);
  if (!fr.active) return null;

  const takeControl = () => {
    game.roam.takeControl();
    onCapture();
  };
  const letJev = () => {
    onReleasePointer();
    game.roam.setController("JEV", "jev");
  };
  const assist = () => game.roam.setController("ASSIST", "jev");

  return (
    <>
      <DamageFlash health={fr.health} />
      <Crosshair fr={fr} />
      <ObjectiveBanner fr={fr} />
      <Vitals fr={fr} />
      <JevPanel jev={jev} onTakeControl={takeControl} />
      <ReplayBar game={game} jev={jev} />
      {fr.message && (
        <div className="pointer-events-none absolute left-1/2 top-[8.6rem] -translate-x-1/2 animate-in fade-in rounded-lg border border-sky-300/30 bg-[#06121a]/85 px-4 py-2 text-[11px] uppercase tracking-[.14em] text-sky-100">
          {fr.message}
        </div>
      )}
      {!fr.alive && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/55 px-6 py-3 text-[12px] font-bold uppercase tracking-[.3em] text-rose-200">
          Down · respawning
        </div>
      )}
      {!isMobile && jev.mode === "HUMAN" && !jev.replaying && !locked && (
        <button
          onClick={onCapture}
          className={`${glass} pointer-events-auto absolute bottom-28 left-1/2 -translate-x-1/2 rounded-lg px-3 py-1.5 text-[10px] uppercase tracking-[.16em] text-white/70 hover:bg-white/10`}
        >
          Click to capture the mouse
        </button>
      )}
      <ControllerBar game={game} jev={jev} onLeave={onLeave} onTakeControl={takeControl} onLetJev={letJev} onAssist={assist} />
      <Results game={game} fr={fr} runs={runs} onLeave={onLeave} />
    </>
  );
}
