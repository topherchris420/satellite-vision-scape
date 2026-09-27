import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Coffee,
  Play,
  Power,
  Radio,
  RotateCcw,
  SkipBack,
  SkipForward,
  Square,
  Volume1,
  Volume2,
  X,
} from "lucide-react";
import type { Game } from "@/game/Game";
import { useAfterHours } from "@/hooks/use-after-hours";
import type {
  AfterHoursHud as HudStore,
  AfterHoursSnapshot,
} from "@/game/afterhours/AfterHoursHud";
import {
  GREEN_MACHINE,
  PROCEDURAL_SCORE_CREDIT,
  SOUNDTRACK_CREDIT,
  formatDuration,
} from "@/game/afterhours/soundtrack";
import { LAYER_IDS, type CharacterKind, type LayerId } from "@/game/afterhours/progress";
import { LAYERS } from "@/game/afterhours/puzzle";
import { COFFEE_CART, TERMINAL_SITES } from "@/game/afterhours/sites";
import { STATIONS, type StationDef } from "@/game/afterhours/radio";

/** Deep spectral teal and warm amber: the After Hours instrument palette. */
const TEAL = "#0B5D63";
const panel =
  "border border-[#0B5D63]/70 bg-[#041517]/82 text-white shadow-[0_12px_40px_rgba(0,0,0,.3)] backdrop-blur-md";

/** Stable callback refs that bind DOM nodes to the HUD's direct readouts. */
function useBinder(hud: HudStore) {
  const cache = useRef(new Map<string, (el: HTMLElement | SVGElement | null) => void>());
  return useCallback(
    (key: string) => {
      let fn = cache.current.get(key);
      if (!fn) {
        fn = (el) => hud.bind(key, el);
        cache.current.set(key, fn);
      }
      return fn;
    },
    [hud],
  );
}

/** Buttons drop focus after a pointer press so Space never re-triggers them. */
function HudButton({
  label,
  onClick,
  children,
  className = "",
  pressed,
  hold,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  pressed?: boolean;
  /** Press-and-hold handler (−1/0/+1 style): called with true on press, false on release. */
  hold?: (down: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      onPointerDown={hold ? () => hold(true) : undefined}
      onPointerUp={(e) => {
        hold?.(false);
        e.currentTarget.blur();
      }}
      onPointerLeave={hold ? () => hold(false) : undefined}
      onPointerCancel={hold ? () => hold(false) : undefined}
      className={`pointer-events-auto flex min-h-8 min-w-8 touch-none select-none items-center justify-center rounded-md border border-white/10 bg-white/[.04] text-white/75 transition hover:bg-white/10 hover:text-white active:bg-white/20 ${className}`}
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-white/15 bg-white/[.06] px-1 font-mono text-[9px] text-white/70">
      {children}
    </kbd>
  );
}

// --- In-play overlay ---------------------------------------------------------------------

export function AfterHoursOverlay({ game, isMobile }: { game: Game; isMobile: boolean }) {
  const s = useAfterHours(game);
  const ah = game.afterHours;
  const bind = useBinder(ah.hud);
  if (!s.active) return null;
  return (
    <>
      {!s.concert.running && !(isMobile && s.tuning) && (
        <Objective s={s} bind={bind} isMobile={isMobile} />
      )}
      <Captions s={s} isMobile={isMobile} />
      {s.credit && <CreditToast key={s.credit.id} reason={s.credit.reason} />}
      <RadioPanel s={s} game={game} bind={bind} isMobile={isMobile} />
      {s.mission.state === "active" && <CoffeeMeter bind={bind} game={game} isMobile={isMobile} />}
      {s.mission.state === "failed" && <FailureCard s={s} game={game} />}
      {s.tuning && <TuningOverlay s={s} game={game} bind={bind} isMobile={isMobile} />}
      {s.concert.running && <ConcertBar s={s} game={game} bind={bind} isMobile={isMobile} />}
      {s.terminalsRevealed &&
        s.preferences.signalOverlay &&
        !s.concert.running &&
        s.stage !== "complete" && <SignalOverlay s={s} bind={bind} isMobile={isMobile} />}
    </>
  );
}

type Bind = ReturnType<typeof useBinder>;

function Objective({
  s,
  bind,
  isMobile,
}: {
  s: AfterHoursSnapshot;
  bind: Bind;
  isMobile: boolean;
}) {
  if (!s.objective) return null;
  return (
    <section
      aria-label="Objective"
      className={`${panel} absolute left-3 max-w-[min(22rem,calc(100vw-7rem))] rounded-lg px-3 py-2 sm:left-5 ${isMobile ? "top-[4.25rem]" : "top-[5.25rem]"}`}
    >
      <div className="flex items-center gap-2 text-[8px] font-bold uppercase tracking-[.22em] text-[#7fd6d0]">
        <span className="rounded-sm bg-[#0B5D63] px-1 py-px text-[7px] tracking-[.18em] text-white/90">
          Fiction
        </span>
        After Hours
      </div>
      <p className="mt-1 font-sans text-[12px] leading-snug text-white/90">{s.objective}</p>
      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-amber-200/80">
        {s.waypointLabel && (
          <>
            <span ref={bind("waypoint-arrow")} className="inline-block" aria-hidden>
              <ArrowUp size={11} />
            </span>
            <span ref={bind("waypoint-dist")} />
            <span className="truncate text-white/40">· {s.waypointLabel}</span>
          </>
        )}
      </div>
      {s.hint && <p className="mt-0.5 font-sans text-[10px] text-white/45">{s.hint}</p>}
    </section>
  );
}

const SPEAKER_STYLE: Record<string, string> = {
  story: "text-[#7fd6d0]",
  radio: "text-amber-300/90",
  numbers: "text-[#b9a4f0]",
  announcement: "text-amber-300/90",
  system: "text-white/55",
  final: "text-amber-200",
};

function Captions({ s, isMobile }: { s: AfterHoursSnapshot; isMobile: boolean }) {
  const c = s.caption;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none absolute left-1/2 -translate-x-1/2 text-center ${
        s.caption?.kind === "final"
          ? "w-[min(52rem,calc(100vw-2rem))]"
          : "w-[min(36rem,calc(100vw-2rem))]"
      } ${
        // While a terminal overlay is open, captions move above it.
        s.tuning
          ? isMobile
            ? "top-[26rem]"
            : "top-[4.5rem]"
          : isMobile
            ? "bottom-[10.5rem]"
            : "bottom-[15rem]"
      }`}
    >
      {c &&
        (c.kind === "final" ? (
          <div key={c.id} className="animate-in fade-in duration-1000">
            <p className="font-mono text-[14px] font-bold uppercase tracking-[.22em] text-amber-100 drop-shadow-[0_2px_10px_rgba(0,0,0,.8)] sm:text-[18px]">
              {c.text}
            </p>
          </div>
        ) : (
          <div
            key={c.id}
            className="inline-block rounded-md border border-[#0B5D63]/60 bg-[#031113]/85 px-3 py-1.5 text-left animate-in fade-in"
          >
            {c.speaker && (
              <span
                className={`mr-2 font-mono text-[9px] font-bold uppercase tracking-[.18em] ${SPEAKER_STYLE[c.kind]}`}
              >
                {c.speaker}
              </span>
            )}
            <span className="font-sans text-[13px] leading-snug text-white/92">{c.text}</span>
          </div>
        ))}
    </div>
  );
}

function CreditToast({ reason }: { reason: "opening" | "return" }) {
  return (
    <div
      role="note"
      aria-label="Soundtrack credit"
      className={`${panel} absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-3 rounded-lg px-3 py-2 animate-in fade-in slide-in-from-top-2 duration-700 sm:top-5`}
    >
      <img
        src={GREEN_MACHINE.artwork.thumbnail}
        alt="Green Machine cover art"
        className="h-10 w-10 rounded-sm object-cover"
      />
      <div>
        <div className="font-mono text-[8px] uppercase tracking-[.22em] text-[#7fd6d0]">
          {reason === "opening" ? "Soundtrack" : "Back on the radio"}
        </div>
        <div className="font-sans text-[12px] text-white/90">{SOUNDTRACK_CREDIT.line}</div>
        <div className="font-sans text-[11px] text-amber-200/85">{SOUNDTRACK_CREDIT.release}</div>
      </div>
    </div>
  );
}

// --- Radio -----------------------------------------------------------------------------

function RadioPanel({
  s,
  game,
  bind,
  isMobile,
}: {
  s: AfterHoursSnapshot;
  game: Game;
  bind: Bind;
  isMobile: boolean;
}) {
  const ah = game.afterHours;
  const [albumOpen, setAlbumOpen] = useState(false);
  const [dialOpen, setDialOpen] = useState(false);
  const r = s.radio;
  const showDial =
    dialOpen || r.holding || s.stage === "channel" || (r.power && r.stationId === null);
  const track = GREEN_MACHINE.tracks[r.trackIndex];
  const album = r.stationId === "indigo";
  const playing = album && r.power && r.status === "playing";
  const live = album && r.power;
  const presets = STATIONS.filter((st) => !st.hidden || (st.id === "f420" && r.f420Discovered));
  const cmd = (c: Parameters<typeof ah.radioCommand>[0]) => () => ah.radioCommand(c);
  const tuneHold = (dir: number) => (down: boolean) => {
    if (down) ah.tuneTap(dir);
    game.input.virtual.tune = down ? dir : 0;
  };
  const statusText =
    r.status === "buffering" || r.status === "loading"
      ? "Buffering…"
      : r.status === "blocked"
        ? "Blocked by the browser"
        : r.status === "error"
          ? "Signal lost"
          : null;
  const inVehicle = game.interaction.cameraMode === "vehicle";
  const position = isMobile
    ? "left-3 top-[10.5rem] w-[16rem]"
    : `right-5 w-[17.5rem] ${inVehicle ? "bottom-[10.5rem]" : "bottom-5"}`;

  if (!r.inReach) {
    return (
      <div
        className={`${panel} absolute ${isMobile ? "left-3 top-[10.5rem]" : `right-5 ${inVehicle ? "bottom-[10.5rem]" : "bottom-5"}`} flex items-center gap-2 rounded-md px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-white/50`}
      >
        <Radio size={11} className="text-amber-300/70" />
        {r.ownerLabel ? `Radio · ${r.ownerLabel}` : "Radio"} · {r.power ? r.stationLabel : "Off"}
      </div>
    );
  }

  return (
    <section
      aria-label="Vehicle radio"
      className={`${panel} absolute ${position} rounded-lg p-2.5 ${s.preferences.reducedMotion ? "ah-still" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => setAlbumOpen((v) => !v)}
          aria-expanded={albumOpen}
          aria-label="Album details and credits"
          className="pointer-events-auto relative h-11 w-11 shrink-0 overflow-hidden rounded-sm border border-white/10"
        >
          {album ? (
            <img
              src={GREEN_MACHINE.artwork.thumbnail}
              alt="Green Machine cover art"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-[#0B5D63]/40 text-[#7fd6d0]">
              <Radio size={16} />
            </span>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div
            className={`font-sans text-[12px] font-semibold leading-tight tracking-[.01em] ${r.power ? "text-[#9be3dd]" : "text-white/45"}`}
          >
            {r.power ? r.stationLabel : "Radio off"}
          </div>
          {album && r.power ? (
            <>
              <div className="mt-0.5 flex items-center gap-1.5">
                <Equaliser playing={playing} />
                <div
                  className="min-w-0 flex-1 truncate font-sans text-[12px] text-white/90"
                  aria-live="polite"
                >
                  {track.title}
                </div>
                <span
                  className="flex shrink-0 items-center gap-1 rounded-sm bg-red-500/15 px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-[.18em] text-red-300"
                  title="Live broadcast"
                >
                  <span className="ah-live-dot h-1.5 w-1.5 rounded-full bg-red-400" aria-hidden />
                  Live
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 font-sans text-[10px] text-white/50">
                <span className="truncate">
                  {GREEN_MACHINE.artist} · {track.number}/{GREEN_MACHINE.tracks.length}
                </span>
                <span ref={bind("radio-time")} className="font-mono tabular-nums text-white/40" />
              </div>
            </>
          ) : (
            <div className="mt-0.5 font-sans text-[11px] leading-snug text-white/55">
              {r.power
                ? r.stationId === "numbers"
                  ? "Fictional numbers transmission"
                  : r.stationId === "f420"
                    ? "Procedural signal · not part of the album"
                    : "Between stations · pick a preset below"
                : "Press R, or pick a station below"}
            </div>
          )}
        </div>
      </div>
      {album && r.power && (
        <div
          className="mt-2 h-[3px] overflow-hidden rounded-full bg-white/10"
          aria-label="Track progress"
        >
          <div
            ref={bind("radio-progress")}
            className="h-full origin-left rounded-full bg-gradient-to-r from-amber-300/70 to-amber-200 [transform:scaleX(0)]"
          />
        </div>
      )}
      {statusText && (
        <button
          type="button"
          onClick={cmd("retry")}
          className="pointer-events-auto mt-2 w-full rounded border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[.12em] text-amber-200"
        >
          {statusText}{" "}
          {r.status === "blocked" || r.status === "error" ? "· tap or press R to retry" : ""}
        </button>
      )}
      {/* One-tap presets (T still cycles them). */}
      <div className="mt-2 flex gap-1" role="radiogroup" aria-label="Stations">
        {presets.map((st) => {
          const on = r.power && r.stationId === st.id;
          return (
            <button
              key={st.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${st.label}, ${st.frequency.toFixed(1)}`}
              title={`${st.label} · ${st.frequency.toFixed(1)}`}
              onClick={() => ah.tuneToStation(st.id)}
              onPointerUp={(e) => e.currentTarget.blur()}
              className={`pointer-events-auto min-w-0 rounded-md border px-1.5 py-1 text-left transition ${
                st.kind === "album" ? "flex-[1.7]" : "flex-1"
              } ${
                on
                  ? "border-amber-300/60 bg-amber-300/15 text-amber-100 shadow-[0_0_12px_rgba(252,211,77,.15)]"
                  : "border-white/10 bg-white/[.03] text-white/60 hover:border-white/25 hover:bg-white/[.07] hover:text-white"
              }`}
            >
              <span className="block font-sans text-[10px] leading-tight">{shortLabel(st)}</span>
              <span
                className={`block font-mono text-[8px] tabular-nums ${on ? "text-amber-200/80" : "text-white/35"}`}
              >
                {st.frequency.toFixed(1)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-white/10" aria-hidden>
        <div
          ref={bind("radio-meter")}
          className="h-full origin-left bg-gradient-to-r from-[#0B5D63] to-amber-300/80 [transform:scaleX(0)]"
        />
      </div>
      {/* Receiver dial (shown while it matters, or on request) */}
      {showDial && (
        <div className="mt-2 flex items-center gap-2">
          <HudButton label="Tune down (hold, or [ key)" hold={tuneHold(-1)}>
            <ChevronLeft size={14} />
          </HudButton>
          <div
            className="relative h-7 flex-1 overflow-hidden rounded border border-white/10 bg-black/30"
            aria-label="Receiver dial"
          >
            <div className="absolute inset-x-1 top-1/2 h-px bg-white/10" />
            {[318, 367.5, ...(r.f420Discovered ? [420] : [])].map((f) => (
              <div
                key={f}
                className="absolute top-1 h-2 w-px bg-white/30"
                style={{ left: `${((f - 300) / 150) * 100}%` }}
              />
            ))}
            <div
              ref={bind("radio-needle")}
              className="absolute bottom-0 top-0 w-0.5 bg-amber-300"
              style={{ left: "45%" }}
            />
            <span
              ref={bind("radio-freq")}
              className="absolute bottom-0.5 right-1 font-mono text-[9px] tabular-nums text-amber-200"
            />
            <span
              ref={bind("radio-signal")}
              className="absolute bottom-0.5 left-1 font-mono text-[8px] tracking-[-.05em] text-[#7fd6d0]"
              aria-label="Signal strength"
            />
          </div>
          <HudButton label="Tune up (hold, or ] key)" hold={tuneHold(1)}>
            <ChevronRight size={14} />
          </HudButton>
        </div>
      )}
      {r.holding && (
        <div className="mt-1.5">
          <div className="flex justify-between font-mono text-[8px] uppercase tracking-[.16em] text-[#b9a4f0]">
            <span>Holding 420…</span>
            <span>keep still</span>
          </div>
          <div className="mt-0.5 h-1 overflow-hidden rounded bg-white/10">
            <div
              ref={bind("radio-hold")}
              className="h-full origin-left [transform:scaleX(0)] bg-[#b9a4f0]"
            />
          </div>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-0.5">
        <HudButton
          label={r.power ? "Radio off (R)" : "Radio on (R)"}
          onClick={cmd("power")}
          pressed={r.power}
        >
          <Power size={13} className={r.power ? "text-amber-300" : ""} />
        </HudButton>
        <HudButton label="Previous track (,)" onClick={cmd("previous")}>
          <SkipBack size={13} />
        </HudButton>
        <HudButton label="Next track (.)" onClick={cmd("next")}>
          <SkipForward size={13} />
        </HudButton>
        <HudButton label="Volume down (-)" onClick={cmd("volumeDown")}>
          <Volume1 size={13} />
        </HudButton>
        <span
          className="w-6 text-center font-mono text-[9px] tabular-nums text-white/50"
          aria-label="Music volume"
        >
          {Math.round(r.volume * 100)}
        </span>
        <HudButton label="Volume up (=)" onClick={cmd("volumeUp")}>
          <Volume2 size={13} />
        </HudButton>
        <HudButton
          label={showDial ? "Hide receiver dial" : "Show receiver dial ([ ] to tune)"}
          onClick={() => setDialOpen((v) => !v)}
          pressed={showDial}
        >
          <Radio size={13} className={showDial ? "text-[#7fd6d0]" : ""} />
        </HudButton>
      </div>
      {albumOpen && (
        <AlbumView
          onClose={() => setAlbumOpen(false)}
          current={album && r.power ? r.trackIndex : -1}
          playing={playing}
          onPlay={(i) => ah.playTrack(i)}
        />
      )}
    </section>
  );
}

function AlbumView({
  onClose,
  current,
  playing,
  onPlay,
}: {
  onClose: () => void;
  current: number;
  playing: boolean;
  onPlay: (index: number) => void;
}) {
  return (
    <div className="pointer-events-auto mt-2 rounded-md border border-white/10 bg-black/40 p-2.5">
      <div className="flex items-start gap-2.5">
        <img
          src={GREEN_MACHINE.artwork.display}
          alt="Green Machine cover art"
          className="h-20 w-20 rounded-sm object-cover shadow-[0_6px_20px_rgba(0,0,0,.45)]"
        />
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[13px] text-white">{GREEN_MACHINE.album}</div>
          <div className="font-sans text-[11px] text-amber-200/85">{GREEN_MACHINE.artist}</div>
          <p className="mt-1 font-sans text-[10px] leading-snug text-white/60">
            Music written by {GREEN_MACHINE.writtenBy}.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close album details"
          className="text-white/40 hover:text-white"
        >
          <X size={13} />
        </button>
      </div>
      <ol className="mt-2 space-y-px font-sans text-[10px]" aria-label="Tracks">
        {GREEN_MACHINE.tracks.map((t, i) => {
          const now = i === current;
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPlay(i)}
                onPointerUp={(e) => e.currentTarget.blur()}
                aria-current={now ? "true" : undefined}
                aria-label={`Play ${t.title}`}
                className={`group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition hover:bg-white/[.07] ${
                  now ? "bg-amber-300/10 text-amber-200" : "text-white/60 hover:text-white"
                }`}
              >
                <span className="flex w-3.5 shrink-0 justify-center font-mono tabular-nums text-white/35">
                  {now ? (
                    <Equaliser playing={playing} />
                  ) : (
                    <>
                      <span className="group-hover:hidden">{t.number}</span>
                      <Play size={9} className="hidden text-white group-hover:block" />
                    </>
                  )}
                </span>
                <span className="flex-1 truncate">{t.title}</span>
                <span className="font-mono tabular-nums text-white/35">
                  {formatDuration(t.durationSeconds)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Short chip name for a preset ("christopher woodyard (live)" stays readable). */
function shortLabel(st: StationDef): string {
  if (st.kind === "album") return st.label.replace(/\s*\(live\)\s*$/i, "");
  if (st.id === "numbers") return "Numbers";
  if (st.id === "f420") return "420";
  return st.label;
}

/** Three bouncing bars while the album plays; flat when paused or buffering. */
function Equaliser({ playing }: { playing: boolean }) {
  return (
    <span
      className={`ah-eq inline-flex h-2.5 shrink-0 items-end gap-[2px] ${playing ? "ah-eq--on" : ""}`}
      aria-hidden
    >
      <span />
      <span />
      <span />
    </span>
  );
}

// --- Coffee -------------------------------------------------------------------------------

function CoffeeMeter({ bind, game, isMobile }: { bind: Bind; game: Game; isMobile: boolean }) {
  const inVehicle = game.interaction.cameraMode === "vehicle";
  return (
    <section
      aria-label="Coffee integrity"
      className={`${panel} absolute w-44 rounded-lg px-3 py-2 ${isMobile ? "right-3 top-[11rem]" : "left-5 top-[12.5rem]"}`}
    >
      <div className="flex items-center justify-between font-mono text-[8px] uppercase tracking-[.2em] text-amber-300/90">
        <span className="flex items-center gap-1.5">
          <Coffee size={11} /> Coffee
        </span>
        <span
          ref={bind("coffee-timer")}
          className="tabular-nums text-white/70"
          aria-label="Time remaining"
        />
      </div>
      <div className="mt-1 flex items-end justify-between">
        <span
          ref={bind("coffee-pct")}
          className="font-mono text-lg font-light tabular-nums text-white"
        />
        <span className="font-sans text-[9px] text-white/40">
          {inVehicle ? "cup holder" : "in hand"}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          ref={bind("coffee-bar")}
          className="h-full origin-left bg-amber-300 data-[level=critical]:bg-rose-400 data-[level=low]:bg-amber-500"
        />
      </div>
    </section>
  );
}

function FailureCard({ s, game }: { s: AfterHoursSnapshot; game: Game }) {
  return (
    <section
      aria-label="Delivery failed"
      className={`${panel} pointer-events-auto absolute left-1/2 top-24 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg p-3 text-center`}
    >
      <div className="font-mono text-[9px] uppercase tracking-[.22em] text-rose-200">
        Delivery failed
      </div>
      <p className="mt-1 font-sans text-[12px] text-white/80">
        {s.mission.failReason === "spilled"
          ? "The coffee did not survive the journey."
          : "The coffee went cold."}
      </p>
      <button
        type="button"
        onClick={() => game.afterHours.retryMission()}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-300 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[.16em] text-[#16120a]"
      >
        <RotateCcw size={12} /> Retry <Kbd>Y</Kbd>
      </button>
      <p className="mt-1.5 font-sans text-[9px] text-white/40">
        Or collect a fresh cup at the {COFFEE_CART.label.toLowerCase()}.
      </p>
    </section>
  );
}

// --- Terminal tuning ---------------------------------------------------------------------

function TuningOverlay({
  s,
  game,
  bind,
  isMobile,
}: {
  s: AfterHoursSnapshot;
  game: Game;
  bind: Bind;
  isMobile: boolean;
}) {
  const t = s.tuning!;
  const hud = game.afterHours.hud;
  const dialHold = (dir: number) => (down: boolean) => {
    if (down) game.afterHours.dialTap(dir);
    game.input.virtual.dial = down ? dir : 0;
  };
  return (
    <section
      aria-label={`${t.label} tuning terminal`}
      className={`${panel} pointer-events-auto absolute left-1/2 w-[min(26rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-xl p-3 ${isMobile ? "top-[4.25rem]" : "bottom-24"}`}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[8px] uppercase tracking-[.22em] text-[#7fd6d0]">
            Fictional tuning terminal
          </div>
          <div className="font-sans text-[15px] text-white">{t.label} layer</div>
        </div>
        <span
          ref={bind("tuning-status")}
          className="rounded border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.14em] text-amber-200"
        />
      </div>
      <p className="mt-1 font-sans text-[11px] text-white/60">{t.instruction}</p>
      <canvas
        ref={(c) => {
          hud.canvas = c;
        }}
        width={400}
        height={56}
        className="mt-2 h-[56px] w-full rounded border border-white/10 bg-black/40"
        aria-label={
          t.kind === "pitch" ? "Reference wave and your wave" : "Reference pulse and your pulse"
        }
      />
      <div className="mt-1 flex gap-4 font-sans text-[9px] text-white/45">
        <span>━ reference</span>
        <span className="text-amber-200/80">╍ your signal</span>
      </div>
      {/* Dial track: target marked with ▼, your position with the amber bar. */}
      <div className="relative mt-2 h-6 rounded border border-white/10 bg-black/30" aria-hidden>
        <div
          ref={bind("tuning-target")}
          className="absolute -top-0.5 -translate-x-1/2 text-[10px] text-white/80"
        >
          ▼
        </div>
        <div
          ref={bind("tuning-dial")}
          className="absolute bottom-0 top-0 w-1 -translate-x-1/2 rounded bg-amber-300"
        />
      </div>
      <div className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <span className="font-mono text-[8px] uppercase tracking-[.16em] text-white/45">Match</span>
        <div className="h-1.5 overflow-hidden rounded bg-white/10">
          <div ref={bind("tuning-align")} className="h-full origin-left bg-[#7fd6d0]" />
        </div>
        <span
          ref={bind("tuning-align-pct")}
          className="w-8 text-right font-mono text-[9px] tabular-nums text-white/60"
        />
        <span className="font-mono text-[8px] uppercase tracking-[.16em] text-white/45">Lock</span>
        <div className="h-1.5 overflow-hidden rounded bg-white/10">
          <div ref={bind("tuning-lock")} className="h-full origin-left bg-amber-300" />
        </div>
        <span className="w-8" />
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <HudButton label="Turn dial left (A, ←)" hold={dialHold(-1)} className="h-10 w-14">
          <ChevronLeft size={18} />
        </HudButton>
        <span className="font-sans text-[10px] text-white/40">
          <Kbd>A</Kbd> <Kbd>D</Kbd> or stick · <Kbd>E</Kbd> leave
        </span>
        <HudButton label="Turn dial right (D, →)" hold={dialHold(1)} className="h-10 w-14">
          <ChevronRight size={18} />
        </HudButton>
      </div>
      <div className="mt-2 text-center">
        <button
          type="button"
          onClick={() => game.afterHours.leaveTerminal()}
          className="font-mono text-[9px] uppercase tracking-[.16em] text-white/45 hover:text-white"
        >
          Leave terminal
        </button>
      </div>
    </section>
  );
}

// --- Guidance and concert --------------------------------------------------------------

function SignalOverlay({
  s,
  bind,
  isMobile,
}: {
  s: AfterHoursSnapshot;
  bind: Bind;
  isMobile: boolean;
}) {
  const rows: { key: string; label: string; done: boolean }[] = TERMINAL_SITES.map((t) => ({
    key: t.layer,
    label: `${LAYERS[t.layer].label} · ${t.antenna}`,
    done: s.terminals[t.layer],
  }));
  return (
    <section
      aria-label="Signal guidance"
      className={`${panel} absolute w-44 rounded-lg px-2.5 py-2 ${isMobile ? "right-3 top-[11rem]" : "right-5 top-16"}`}
    >
      <div className="font-mono text-[8px] uppercase tracking-[.2em] text-[#b9a4f0]">
        Frequency 420 · {LAYER_IDS.filter((id) => s.terminals[id]).length}/4
      </div>
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-2 font-sans text-[10px]">
            <span className={r.done ? "text-white/35 line-through" : "text-white/80"}>
              {r.label}
            </span>
            <span className="flex items-center gap-1 font-mono text-[9px] tabular-nums text-white/55">
              {r.done ? (
                "✓ locked"
              ) : (
                <>
                  <span ref={bind(`signal-arrow-${r.key}`)} className="inline-block">
                    <ArrowUp size={9} />
                  </span>
                  <span ref={bind(`signal-${r.key}`)} />
                </>
              )}
            </span>
          </li>
        ))}
        {s.concert.unlocked && (
          <li className="flex items-center justify-between gap-2 font-sans text-[10px]">
            <span className="text-amber-200">Listening point</span>
            <span className="flex items-center gap-1 font-mono text-[9px] tabular-nums text-white/55">
              <span ref={bind("signal-arrow-listening")} className="inline-block">
                <ArrowUp size={9} />
              </span>
              <span ref={bind("signal-listening")} />
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}

function ConcertBar({
  s,
  game,
  bind,
  isMobile,
}: {
  s: AfterHoursSnapshot;
  game: Game;
  bind: Bind;
  isMobile: boolean;
}) {
  const ah = game.afterHours;
  return (
    <section
      aria-label="Midnight transmission"
      className={`${panel} pointer-events-auto absolute left-1/2 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg px-3 py-2 ${isMobile ? "top-[4.25rem]" : "top-20"}`}
    >
      <div className="flex items-center justify-between font-mono text-[8px] uppercase tracking-[.22em]">
        <span className="text-[#b9a4f0]">Midnight transmission</span>
        <span className="text-white/50">{s.concert.section}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded bg-white/10">
        <div
          ref={bind("concert-progress")}
          className="h-full origin-left [transform:scaleX(0)] bg-gradient-to-r from-[#0B5D63] via-[#b9a4f0] to-amber-300"
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <HudButton
          label="Cinematic view (V)"
          onClick={() => ah.toggleCinematic()}
          pressed={s.concert.cinematic}
          className="gap-1 px-2 font-mono text-[9px] uppercase tracking-[.12em]"
        >
          <Clapperboard size={12} /> {s.concert.cinematic ? "Exit view" : "Cinematic"} <Kbd>V</Kbd>
        </HudButton>
        <HudButton
          label="End the transmission (X)"
          onClick={() => ah.endConcert()}
          className="gap-1 px-2 font-mono text-[9px] uppercase tracking-[.12em]"
        >
          <Square size={11} /> End <Kbd>X</Kbd>
        </HudButton>
      </div>
      <p className="mt-1 font-sans text-[9px] text-white/35">
        Procedural score, generated in-game — not part of Green Machine.
      </p>
    </section>
  );
}

// --- Pause-card sections ------------------------------------------------------------------

function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left hover:bg-white/[.04]"
    >
      <span>
        <span className="block font-sans text-[11px] text-white/80">{label}</span>
        {hint && <span className="block font-sans text-[9px] text-white/40">{hint}</span>}
      </span>
      <span
        className={`relative h-4 w-8 shrink-0 rounded-full border transition ${value ? "border-amber-300/60 bg-amber-300/30" : "border-white/15 bg-white/5"}`}
      >
        <span
          className={`absolute top-0.5 h-2.5 w-2.5 rounded-full transition-all ${value ? "left-4 bg-amber-300" : "left-0.5 bg-white/40"}`}
        />
      </span>
      <span className="sr-only">{value ? "on" : "off"}</span>
    </button>
  );
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block px-1 py-1">
      <span className="flex justify-between font-sans text-[11px] text-white/80">
        {label}
        <span className="font-mono text-[10px] tabular-nums text-white/45">
          {Math.round(value * 100)}%
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="mt-1 w-full accent-amber-300"
      />
    </label>
  );
}

export function CharacterPicker({
  game,
  onChange,
}: {
  game: Game;
  onChange?: (k: CharacterKind) => void;
}) {
  const [kind, setKind] = useState<CharacterKind>(game.characterKind);
  const pick = (k: CharacterKind) => {
    setKind(k);
    game.setCharacterKind(k);
    game.afterHours.setPreference("character", k);
    onChange?.(k);
  };
  return (
    <div role="radiogroup" aria-label="Character" className="flex gap-1.5">
      {(
        [
          ["soldier", "Soldier"],
          ["technician", "Night-shift technician"],
        ] as const
      ).map(([k, label]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={kind === k}
          onClick={() => pick(k)}
          className={`rounded-md border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[.14em] transition ${kind === k ? "border-amber-300/60 bg-amber-300/15 text-amber-200" : "border-white/15 text-white/55 hover:text-white"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function AfterHoursMenu({ game, onLeave }: { game: Game; onLeave: () => void }) {
  const s = useAfterHours(game);
  const ah = game.afterHours;
  const [tab, setTab] = useState<"settings" | "progress" | "credits">("settings");
  const [confirmReset, setConfirmReset] = useState(false);
  const p = s.preferences;
  const set = ah.setPreference.bind(ah);
  const steps: [string, boolean][] = [
    ["Coffee delivered", s.stage !== "coffee"],
    ["Frequency 420 found", s.terminalsRevealed],
    ...LAYER_IDS.map((id): [string, boolean] => [
      `${LAYERS[id].label} terminal tuned`,
      s.terminals[id as LayerId],
    ]),
    ["Midnight transmission received", s.concert.completed],
  ];
  return (
    <div
      className="mt-5 rounded-xl border border-[#0B5D63]/60 bg-[#041517]/60 p-3"
      style={{ borderColor: `${TEAL}99` }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[9px] font-bold uppercase tracking-[.22em] text-[#7fd6d0]">
          After Hours
        </div>
        <div role="tablist" className="flex gap-1">
          {(["settings", "progress", "credits"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded px-2 py-1 font-mono text-[9px] uppercase tracking-[.14em] ${tab === t ? "bg-[#0B5D63] text-white" : "text-white/50 hover:text-white"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === "settings" && (
        <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div>
            <Slider
              label="Music volume"
              value={p.musicVolume}
              onChange={(v) => set("musicVolume", v)}
            />
            <Slider
              label="Effect intensity"
              value={p.effectIntensity}
              onChange={(v) => set("effectIntensity", v)}
            />
            <div className="px-1 pt-2">
              <div className="mb-1 font-sans text-[11px] text-white/80">Character</div>
              <CharacterPicker game={game} />
            </div>
          </div>
          <div>
            <Toggle
              label="Altered Signal"
              hint={
                s.altered.unlocked
                  ? "Presentation only · O toggles it anywhere"
                  : "Unlocks with Frequency 420"
              }
              value={p.alteredSignal}
              onChange={(v) => set("alteredSignal", v)}
            />
            <Toggle
              label="Reduced motion"
              hint="Freezes drifting colour, traces and orbits"
              value={p.reducedMotion}
              onChange={(v) => set("reducedMotion", v)}
            />
            <Toggle
              label="Clean audio"
              hint="No effect on the album; no ambient layer"
              value={p.cleanAudio}
              onChange={(v) => set("cleanAudio", v)}
            />
            <Toggle
              label="Signal guidance"
              hint="Distances and arrows to every signal"
              value={p.signalOverlay}
              onChange={(v) => set("signalOverlay", v)}
            />
          </div>
        </div>
      )}
      {tab === "progress" && (
        <div className="mt-2">
          <ul className="grid gap-1 sm:grid-cols-2">
            {steps.map(([label, done]) => (
              <li key={label} className="flex items-center gap-2 font-sans text-[11px]">
                <span
                  className={`font-mono text-[10px] ${done ? "text-amber-300" : "text-white/30"}`}
                >
                  {done ? "✓" : "○"}
                </span>
                <span className={done ? "text-white/85" : "text-white/45"}>{label}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 font-sans text-[10px] text-white/45">
            {s.mission.result
              ? `Last delivery: ${s.mission.result.percent}% · ${Math.round(s.mission.result.seconds)} s · score ${s.mission.result.score}. `
              : ""}
            {s.storage.persistent
              ? "Progress is saved in this browser."
              : "This browser is not saving progress; it lasts for this visit."}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {confirmReset ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    ah.resetProgress();
                    setConfirmReset(false);
                  }}
                  className="rounded-md border border-rose-300/50 bg-rose-300/10 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-rose-100"
                >
                  Confirm reset
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="font-mono text-[9px] uppercase tracking-[.14em] text-white/50"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="rounded-md border border-white/15 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-white/60 hover:text-white"
              >
                Reset progress
              </button>
            )}
            <button
              type="button"
              onClick={onLeave}
              className="ml-auto rounded-md border border-white/15 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-white/60 hover:text-white"
            >
              Leave After Hours · free roam
            </button>
          </div>
        </div>
      )}
      {tab === "credits" && <Credits />}
    </div>
  );
}

export function Credits() {
  return (
    <div className="mt-2 grid gap-4 sm:grid-cols-[9rem_1fr]">
      <img
        src={GREEN_MACHINE.artwork.display}
        alt="Green Machine album cover"
        className="w-36 rounded-md object-cover"
      />
      <div className="font-sans text-[11px] leading-relaxed text-white/70">
        <div className="font-mono text-[9px] uppercase tracking-[.2em] text-amber-300/90">
          Soundtrack
        </div>
        <p className="mt-1 text-[13px] text-white">
          {GREEN_MACHINE.artist} — {GREEN_MACHINE.album}
        </p>
        <p className="mt-1">{SOUNDTRACK_CREDIT.full}</p>
        <ol className="mt-1.5 text-white/55">
          {GREEN_MACHINE.tracks.map((t) => (
            <li key={t.id}>
              {t.number}. {t.title}{" "}
              <span className="font-mono text-[10px] text-white/35">
                {formatDuration(t.durationSeconds)}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-1.5 text-[10px] text-white/45">
          Recordings and artwork are used with the songwriter's permission and are not covered by
          this project's software licence.
        </p>
        <div className="mt-3 font-mono text-[9px] uppercase tracking-[.2em] text-[#b9a4f0]">
          Procedural score
        </div>
        <p className="mt-1 text-[10px]">{PROCEDURAL_SCORE_CREDIT}</p>
        <div className="mt-3 font-mono text-[9px] uppercase tracking-[.2em] text-[#7fd6d0]">
          Fiction
        </div>
        <p className="mt-1 text-[10px]">
          After Hours is invented: the technician, the coffee, the radio stations, Frequency 420,
          the tuning terminals, the signal traces and the concert. Antenna positions and the source
          dossiers in Explore remain the published 2016 survey data.
        </p>
      </div>
    </div>
  );
}
