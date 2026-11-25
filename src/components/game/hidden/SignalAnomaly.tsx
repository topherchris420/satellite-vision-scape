import { useEffect, useRef, useState } from "react";
import { readGlimpse, signalRevealed, type CaseGlimpse } from "@/game/hidden/discovery";

/**
 * A line in the survey that shouldn't be there. It appears only after the
 * visitor has spent a while surveying (or inspected a couple of structures),
 * reads like one more instrument readout, and opens a short transmission
 * that asks whether to go and look. Once found it stays, quietly, as the way
 * back in. Everything it leads to is fiction, and the inspector says so.
 *
 * This component ships with every visit, so it holds no game code: the case
 * is fetched when the line first shows and started from the click that
 * accepts it.
 */

const TRANSMISSION = [
  "R.A.I.N. // field relay",
  "A classifier watching this valley flagged a carrier it can't place.",
  "It named a truck. It named the woman who signs it out.",
  "It says it is ninety-nine point nine percent sure.",
  "I need someone on the ground before anyone acts on it.",
  "How certain are you?",
] as const;

type View = "line" | "inspect" | "transmission";

export function SignalAnomaly({
  surveying,
  inspections,
  caseActive,
  onPrefetch,
  onAccept,
}: {
  /** The visitor is in a survey mode (Explore, Tour or Plan) right now. */
  surveying: boolean;
  /** Distinct structures inspected this visit. */
  inspections: number;
  /** The case is already running (paused behind the survey). */
  caseActive: boolean;
  /** Fetch the case code ahead of the click. */
  onPrefetch: () => void;
  /** Start or resume the case. Called from the click. */
  onAccept: () => void;
}) {
  const [glimpse, setGlimpse] = useState<CaseGlimpse>(() => ({ found: false, stage: "briefing" }));
  const [surveyed, setSurveyed] = useState(0);
  const [view, setView] = useState<View>("line");
  const [typed, setTyped] = useState(0);
  const prefetched = useRef(false);

  // localStorage is read after mount so the server render and the first client render agree.
  useEffect(() => setGlimpse(readGlimpse()), []);
  useEffect(() => {
    if (view === "line") setGlimpse(readGlimpse());
  }, [view, caseActive]);

  const revealed = signalRevealed(glimpse, surveyed, inspections);
  useEffect(() => {
    if (revealed || !surveying) return;
    const id = window.setInterval(() => setSurveyed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [revealed, surveying]);

  useEffect(() => {
    if (!revealed || prefetched.current) return;
    prefetched.current = true;
    onPrefetch();
  }, [revealed, onPrefetch]);

  // Type the transmission out a character at a time (all at once with reduced motion).
  const total = TRANSMISSION.reduce((n, l) => n + l.length, 0);
  useEffect(() => {
    if (view !== "transmission") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setTyped(total);
      return;
    }
    setTyped(0);
    const id = window.setInterval(() => {
      setTyped((t) => {
        if (t >= total) window.clearInterval(id);
        return Math.min(total, t + 2);
      });
    }, 30);
    return () => window.clearInterval(id);
  }, [view, total]);

  if (!revealed) return null;

  const accept = () => {
    setView("line");
    onAccept();
  };

  if (view === "line")
    return (
      <button
        onClick={() => setView("inspect")}
        aria-label="Unlisted carrier"
        className="signal-anomaly mt-2 flex items-center gap-2 rounded-md border border-transparent px-2 py-1 font-mono text-[8px] uppercase tracking-[.18em] text-[#7fd6d0]/60 transition hover:border-[#7fd6d0]/25 hover:bg-[#071014]/70 hover:text-[#7fd6d0]"
      >
        <span className="h-1 w-1 rounded-full bg-[#7fd6d0]/70" />
        Unlisted carrier · 1420.4 MHz · conf 99.9%
      </button>
    );

  const resume = glimpse.found || caseActive;
  if (view === "inspect")
    return (
      <section
        aria-label="Signal inspector"
        className="mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-[#7fd6d0]/20 bg-[#041517]/90 p-3 font-mono text-[9px] text-white/60 shadow-[0_16px_50px_rgba(0,0,0,.3)] backdrop-blur-xl"
      >
        <div className="flex items-center justify-between">
          <span className="uppercase tracking-[.2em] text-[#7fd6d0]">Unlisted carrier</span>
          <span className="rounded-sm bg-[#0B5D63] px-1 text-[7px] uppercase tracking-[.18em] text-white/90">
            Fiction
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-white/35">Frequency</dt>
          <dd>1420.4 MHz, narrow, keyed since 02:00</dd>
          <dt className="text-white/35">Classifier</dt>
          <dd>CERTAIN-PG · 99.9%</dd>
          <dt className="text-white/35">Attributed to</dt>
          <dd>Utility truck U-2</dd>
          <dt className="text-white/35">Status</dt>
          <dd className="text-amber-200/80">
            {glimpse.stage === "closed" ? "Verdict on file" : resume ? "Under review" : "Unreviewed"}
          </dd>
        </dl>
        <p className="mt-2 border-t border-white/10 pt-2 font-sans text-[10px] leading-relaxed text-white/40">
          Not part of the survey. This signal, and everything it leads to, is invented.
        </p>
        <div className="mt-2 flex items-center gap-2">
          {resume ? (
            <button
              onClick={accept}
              className="rounded-lg bg-[#0B5D63] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[.16em] text-white transition hover:bg-[#0e727a]"
            >
              {glimpse.stage === "closed" ? "Return to the case" : "Resume the case"}
            </button>
          ) : (
            <button
              onClick={() => setView("transmission")}
              className="rounded-lg bg-[#0B5D63] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[.16em] text-white transition hover:bg-[#0e727a]"
            >
              Open the transmission
            </button>
          )}
          <button
            onClick={() => setView("line")}
            className="rounded-lg px-2 py-1.5 text-[9px] uppercase tracking-[.16em] text-white/40 transition hover:text-white"
          >
            Close
          </button>
        </div>
      </section>
    );

  // The transmission, typed out.
  let left = typed;
  const shown = TRANSMISSION.map((line) => {
    const n = Math.max(0, Math.min(line.length, left));
    left -= line.length;
    return line.slice(0, n);
  });
  const done = typed >= total;
  return (
    <section
      aria-label="Transmission"
      aria-live="polite"
      className="mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-[#7fd6d0]/25 bg-[#020b0c]/95 p-4 font-mono text-[10px] leading-relaxed text-[#bfe9e5] shadow-[0_20px_60px_rgba(0,0,0,.45)] backdrop-blur-xl"
    >
      {shown.map((line, i) =>
        line ? (
          <p
            key={i}
            className={
              i === 0
                ? "mb-2 text-[8px] uppercase tracking-[.24em] text-[#7fd6d0]/70"
                : i === TRANSMISSION.length - 1
                  ? "mt-3 font-sans text-[15px] font-light tracking-tight text-white"
                  : ""
            }
          >
            {line}
          </p>
        ) : null,
      )}
      {done && (
        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={accept}
            autoFocus
            className="rounded-lg bg-[#7fd6d0] px-4 py-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#03201f] transition hover:bg-[#a5e6e1]"
          >
            Go and look
          </button>
          <button
            onClick={() => setView("line")}
            className="rounded-lg px-3 py-2 text-[10px] uppercase tracking-[.16em] text-white/45 transition hover:text-white"
          >
            Not now
          </button>
        </div>
      )}
    </section>
  );
}
