import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import type { Game } from "@/game/Game";
import type { RaceSnapshot } from "@/game/freeroam/RaceTracker";
import { readBest, recordBest } from "@/lib/freeroam-ui";
import { formatDelta, formatRaceTime, gapAt, parseRaceLink, raceLink, raceVerdict } from "@/lib/freeroam/race";

const REPO = "https://github.com/topherchris420/satellite-vision-scape/blob/main/";
const AHEAD = "#6ee7b7";
const BEHIND = "#fda4af";
const LEVEL = "rgba(255,255,255,.75)";

function stageName(id: string | undefined, index: number): string {
  if (!id) return `Stage ${index + 1}`;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function deltaColor(seconds: number): string {
  if (Math.abs(seconds) < 0.05) return LEVEL;
  return seconds < 0 ? AHEAD : BEHIND;
}

/**
 * The race while it runs: the time to beat and the live gap. The gap is written
 * straight to the DOM four times a second, so racing never re-renders React.
 */
export function RaceStrip({ game, race, compact = false }: { game: Game; race: RaceSnapshot; compact?: boolean }) {
  const gapRef = useRef<HTMLSpanElement>(null);
  const { target, lastSplit, nextTargetS, splits } = race;

  useEffect(() => {
    let hint = 0;
    let lastT = 0;
    const tick = () => {
      const node = gapRef.current;
      if (!node) return;
      const t = game.freeRoam.simTime;
      if (t < lastT) hint = 0;
      lastT = t;
      const p = game.freeRoam.playerPosition();
      const gap = gapAt(target, p.x, p.z, t, hint);
      hint = gap.index;
      node.textContent = gap.gapS === null ? `off ${target.label}'s line` : formatDelta(gap.gapS);
      node.style.color = gap.gapS === null ? "rgba(255,255,255,.45)" : deltaColor(gap.gapS);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [game, target]);

  return (
    <div
      className="mt-1.5 rounded-xl border border-cyan-300/25 bg-[#06141c]/85 px-3 py-1.5 backdrop-blur-xl"
      aria-label={`Racing ${target.label}'s recorded run`}
    >
      <div className="flex items-center justify-between gap-3 font-sans text-[11px]">
        <span className="flex items-center gap-1.5 text-white/60">
          <span className="h-2 w-2 rounded-full bg-cyan-300" aria-hidden />
          {target.label} {formatRaceTime(target.elapsedS)}
        </span>
        <span ref={gapRef} className="font-mono text-[13px] font-semibold tabular-nums" aria-live="off" />
        {!compact && (
          <span className="tabular-nums text-white/50">
            {lastSplit ? (
              <>
                {stageName(target.stages[lastSplit.stage], lastSplit.stage)}{" "}
                <span style={{ color: deltaColor(lastSplit.deltaS) }}>{formatDelta(lastSplit.deltaS)}</span>
              </>
            ) : nextTargetS !== null ? (
              <>split at {formatRaceTime(nextTargetS)}</>
            ) : null}
          </span>
        )}
      </div>
      {!compact && splits.length === 0 && (
        <p className="mt-0.5 font-sans text-[10px] text-white/40">
          The cyan shape is {target.label}&apos;s recorded run, at its real pace. The number is how far ahead or behind you are.
        </p>
      )}
    </div>
  );
}

function CopyLink({ seconds }: { seconds: number }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const url = raceLink(window.location.origin, seconds);
  return (
    <>
      <button
        className="rounded-lg border border-white/15 px-2.5 py-1.5 font-sans text-[10px] font-bold uppercase tracking-[.14em] text-white/80 transition hover:bg-white/10"
        onClick={() => {
          navigator.clipboard
            .writeText(url)
            .then(() => setState("copied"))
            .catch(() => setState("failed"));
        }}
      >
        {state === "copied" ? <Check size={10} className="mr-1 inline" /> : <Copy size={10} className="mr-1 inline" />}
        {state === "copied" ? "Link copied" : "Copy challenge link"}
      </button>
      {state === "failed" && <span className="select-all font-mono text-[10px] text-white/60">{url}</span>}
    </>
  );
}

/** The result of a race: the two times, the gap, where it was won or lost, and where Jev's number comes from. */
export function RaceResult({
  race,
  won,
  /** Seconds Jev or the assist had the controls during this run. */
  helpedS,
}: {
  race: RaceSnapshot;
  won: boolean;
  helpedS: number;
}) {
  const { target, finish, splits } = race;
  const clean = helpedS === 0;
  const counted = won && finish !== null && clean;
  const [claimed] = useState(() => parseRaceLink(window.location.search)?.sharedS ?? null);
  // The best as it stood when this result appeared; recording is idempotent, the comparison is against this.
  const [previousBest] = useState(() => readBest(target.id));
  const timeS = finish?.timeS ?? null;
  const isNewBest = counted && timeS !== null && (previousBest === null || timeS < previousBest);
  useEffect(() => {
    if (counted && timeS !== null) recordBest(target.id, timeS);
  }, [counted, timeS, target.id]);

  return (
    <div className="mt-3 rounded-xl border border-cyan-300/20 bg-[#06141c]/70 p-4">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[.2em] text-white/45">You</div>
          <div className="font-mono text-xl tabular-nums text-white sm:text-3xl">{timeS === null ? "—" : formatRaceTime(timeS)}</div>
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[.2em] text-white/45">
            {target.label}
            <span className="hidden sm:inline">, recorded</span>
          </div>
          <div className="font-mono text-xl tabular-nums text-cyan-200 sm:text-3xl">{formatRaceTime(target.elapsedS)}</div>
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[.2em] text-white/45">Gap</div>
          <div className="font-mono text-xl tabular-nums sm:text-3xl" style={{ color: finish ? deltaColor(finish.deltaS) : LEVEL }}>
            {finish ? formatDelta(finish.deltaS).replace(" s", "") : "—"}
          </div>
        </div>
      </div>

      <p className="mt-2 font-sans text-[13px] text-white/85">
        {!won || timeS === null
          ? "No time: the objective was not completed."
          : !clean
            ? `Your run had help for ${helpedS.toFixed(1)} s, so it does not count as a time against ${target.label}.`
            : raceVerdict(timeS, target)}
        {isNewBest && <span className="ml-1 text-emerald-300">New personal best.</span>}
      </p>
      {counted && !isNewBest && previousBest !== null && (
        <p className="mt-0.5 font-sans text-[11px] text-white/50">Your best is {formatRaceTime(previousBest)}.</p>
      )}
      {counted && claimed !== null && timeS !== null && (
        <p className="mt-0.5 font-sans text-[11px] text-amber-200/80" title="Links carry only a number. Nothing checks it.">
          The link you followed claims {formatRaceTime(claimed)}, which would put you {formatDelta(timeS - claimed)}. Nothing verifies a linked time.
        </p>
      )}

      {splits.length > 0 && (
        <table className="mt-3 w-full font-sans text-[11px] tabular-nums">
          <thead>
            <tr className="text-left text-[9px] uppercase tracking-[.16em] text-white/40">
              <th className="pb-1 font-bold">Stage ends</th>
              <th className="pb-1 text-right font-bold">You</th>
              <th className="pb-1 text-right font-bold">{target.label}</th>
              <th className="pb-1 text-right font-bold">Gap</th>
            </tr>
          </thead>
          <tbody>
            {splits.map((split) => (
              <tr key={split.stage} className="border-t border-white/5">
                <td className="py-1 text-white/70">{stageName(target.stages[split.stage], split.stage)}</td>
                <td className="py-1 text-right text-white/90">{formatRaceTime(split.youS)}</td>
                <td className="py-1 text-right text-white/60">{formatRaceTime(split.targetS)}</td>
                <td className="py-1 text-right" style={{ color: deltaColor(split.deltaS) }}>
                  {formatDelta(split.deltaS)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {counted && timeS !== null && <CopyLink seconds={timeS} />}
        <a
          href={`${REPO}${target.trace}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg px-1 py-1.5 font-sans text-[10px] text-white/50 underline-offset-2 transition hover:text-white hover:underline"
        >
          <ExternalLink size={10} className="mr-1 inline" />
          {target.label}&apos;s trace
        </a>
      </div>
      <p className="mt-1 font-sans text-[10px] leading-relaxed text-white/40">
        One recorded run ({target.model ?? "model unknown"}, {target.recordedOn}), not a measure of the model: no model ran during your race.
        {target.alsoRecordedS.length > 0 &&
          ` Its other committed ${target.alsoRecordedS.length === 1 ? "run" : "runs"} of this seed took ${target.alsoRecordedS.map(formatRaceTime).join(", ")}.`}
      </p>
    </div>
  );
}
