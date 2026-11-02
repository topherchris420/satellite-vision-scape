import { useState, type ReactNode } from "react";
import { ChevronDown, Compass, Flag, Footprints, MoonStar } from "lucide-react";
import { createRaceTarget } from "@/game/freeroam/RaceTracker";
import { readBest } from "@/lib/freeroam-ui";
import { formatRaceTime, parseRaceLink } from "@/lib/freeroam/race";

/**
 * The first thing a visitor sees once the site has loaded: one thing to do, the
 * number to beat, and everything else one click further in. The time on this
 * card is read from the committed trace (see `scripts/build-race-target.ts`).
 */

function Option({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-white/10 bg-white/[.03] px-3.5 py-3 text-left transition hover:border-white/25 hover:bg-white/[.07]"
    >
      <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.16em] text-white/85">
        {icon} {title}
      </span>
      <span className="mt-1 block font-sans text-[11px] leading-snug text-white/50">{detail}</span>
    </button>
  );
}

export function Landing({
  isMobile,
  returning,
  onRace,
  onWalk,
  onSurvey,
  onAfterHours,
  children,
}: {
  isMobile: boolean;
  returning: boolean;
  onRace: () => void;
  onWalk: () => void;
  onSurvey: () => void;
  onAfterHours: () => void;
  /** Every other way in: all challenges, Jev playing live, traces, characters, the full controls. */
  children: ReactNode;
}) {
  const [target] = useState(createRaceTarget);
  const [best] = useState(() => readBest(target.id));
  const [claimed] = useState(() => parseRaceLink(window.location.search)?.sharedS ?? null);
  // A link asking for a particular controller came for the agent controls that live in here.
  const [openMore] = useState(() => new URLSearchParams(window.location.search).has("controller"));

  return (
    <>
      <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.26em] text-sky-300">
        <Flag size={11} /> Pine Gap · an AI&apos;s recorded run
      </div>
      <h1 className="mt-2 font-sans text-4xl font-light tracking-[-.04em] sm:text-5xl">Beat the AI&apos;s time.</h1>
      <p className="mt-3 max-w-xl font-sans text-[13px] leading-relaxed text-white/65">
        Jev is an AI agent that plays this game with the same avatar, vehicles and rules you have. Take a vehicle,
        reach the checkpoint and shake the site&apos;s response, on the same seed, with its recorded run beside you.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-4">
        <button
          onClick={onRace}
          autoFocus
          className="flex items-center gap-2.5 rounded-xl bg-sky-400 px-7 py-4 text-[12px] font-bold uppercase tracking-[.2em] text-[#04121c] ring-1 ring-sky-100/50 transition hover:bg-sky-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-200"
        >
          <Flag size={15} /> Race Jev
        </button>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[.2em] text-white/40">Time to beat</div>
          <div className="font-mono text-2xl tabular-nums text-white">{formatRaceTime(target.elapsedS)}</div>
        </div>
        {best !== null && (
          <div>
            <div className="text-[9px] font-bold uppercase tracking-[.2em] text-white/40">Your best</div>
            <div className="font-mono text-2xl tabular-nums text-emerald-300">{formatRaceTime(best)}</div>
          </div>
        )}
        {claimed !== null && (
          <div title="A time carried in the link you followed. Nothing checks it.">
            <div className="text-[9px] font-bold uppercase tracking-[.2em] text-white/40">Your link claims</div>
            <div className="font-mono text-2xl tabular-nums text-amber-200">{formatRaceTime(claimed)}</div>
          </div>
        )}
      </div>
      <p className="mt-2 font-sans text-[10px] text-white/40">
        {isMobile ? "Thumbs to drive and look." : "WASD to move · F to take a vehicle · Esc frees the mouse."} No account or
        key needed; the ghost is a recording.
      </p>

      <div className="mt-5 grid gap-2 sm:grid-cols-3">
        <Option
          icon={<MoonStar size={12} className="text-[#7fd6d0]" />}
          title={returning ? "Continue After Hours" : "After Hours"}
          detail="An invented night shift: a coffee run, a radio, and something on 420."
          onClick={onAfterHours}
        />
        <Option
          icon={<Footprints size={12} className="text-amber-200" />}
          title="Walk the site"
          detail="On foot or at the wheel, in your own time, with no objective."
          onClick={onWalk}
        />
        <Option
          icon={<Compass size={12} className="text-white/70" />}
          title="Survey from above"
          detail="Orbit the reconstruction and read what each building is."
          onClick={onSurvey}
        />
      </div>

      <details className="group mt-4" open={openMore}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.16em] text-white/55 transition hover:text-white [&::-webkit-details-marker]:hidden">
          <ChevronDown size={12} className="transition group-open:rotate-180" /> More ways to play: all challenges, let Jev
          play live, replays, controls
        </summary>
        <div className="mt-1">{children}</div>
      </details>

      <p className="mt-5 border-t border-white/10 pt-3 font-sans text-[10px] leading-relaxed text-white/35">
        A fictionalised interpretation built from publicly observable exterior features. No interiors or operational
        detail.
      </p>
    </>
  );
}
