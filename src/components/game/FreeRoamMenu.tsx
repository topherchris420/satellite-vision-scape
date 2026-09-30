import { useRef, useState } from "react";
import { Bot, Car, Dices, FileUp, Play, Users } from "lucide-react";
import type { Game } from "@/game/Game";
import { CHALLENGES, DEFAULT_CHALLENGE, DEFAULT_SEED } from "@/game/freeroam/Scenario";
import { parseSeed, type FrController, type FrLaunch, type LaunchResult } from "@/lib/freeroam-ui";

/**
 * "GTA-Style Free Roam" on the briefing and pause cards: pick a challenge and
 * a seed, then play it yourself, let Jev play it, or play with Jev assisting.
 * The same seed gives the same world to whoever plays it.
 *
 * Only gameplay grammar is borrowed (third person, on foot and driving, a
 * crowd, traffic, a sidearm, attention). The site, the people, the vehicles
 * and the words are this project's own.
 */

const accent = "text-sky-300";

export function FreeRoamMenu({
  game,
  onLaunch,
  onReplayText,
  active,
}: {
  game: Game;
  onLaunch: (launch: FrLaunch) => Promise<LaunchResult>;
  /** Watch a trace file the person chose. */
  onReplayText: (text: string) => LaunchResult;
  /** A run is in progress: the card offers a fresh start rather than a first one. */
  active?: boolean;
}) {
  const [challenge, setChallenge] = useState(DEFAULT_CHALLENGE);
  const [seedText, setSeedText] = useState(String(DEFAULT_SEED));
  const [busy, setBusy] = useState<FrController | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const info = CHALLENGES.find((c) => c.id === challenge) ?? CHALLENGES[0];
  void game;

  const launch = async (controller: FrController) => {
    setBusy(controller);
    setMessage(null);
    const result = await onLaunch({ seed: parseSeed(seedText, DEFAULT_SEED), challenge, controller });
    setBusy(null);
    if (!result.ok) setMessage(result.detail);
  };

  const rollSeed = () => setSeedText(String(Math.floor(Math.random() * 2 ** 31)));

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    const result = onReplayText(await file.text());
    if (!result.ok) setMessage(result.detail);
  };

  const secondary =
    "flex items-center gap-1.5 rounded-lg border border-sky-300/30 px-3 py-2 text-[10px] font-bold uppercase tracking-[.16em] text-sky-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45";

  return (
    <div className="mt-4 rounded-xl border border-sky-400/40 bg-[#07121c]/75 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <div className={`flex items-center gap-2 font-mono text-[9px] font-bold uppercase tracking-[.24em] ${accent}`}>
            <Car size={12} /> GTA-Style Free Roam
            <span className="rounded-sm bg-sky-700 px-1 text-[7px] tracking-[.18em] text-white/90">Sandbox</span>
          </div>
          <p className="mt-1.5 font-sans text-[12px] leading-relaxed text-white/60">
            Walk, aim and shoot, take any vehicle and drive it, keep the crowd out of trouble and the site&apos;s
            attention down. You and Jev play the same game: the same avatar, vehicles, physics and rules. Hand over
            the controls at any moment; <kbd className="rounded border border-white/20 px-1 font-mono text-[10px]">H</kbd>{" "}
            takes them back.
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="flex flex-col gap-1 font-sans text-[10px] uppercase tracking-[.14em] text-white/45">
          Challenge
          <select
            value={challenge}
            onChange={(e) => setChallenge(e.target.value)}
            className="rounded-lg border border-white/15 bg-[#0a1822] px-2.5 py-2 text-[12px] normal-case tracking-normal text-white"
          >
            {CHALLENGES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-sans text-[10px] uppercase tracking-[.14em] text-white/45">
          Seed
          <span className="flex items-center gap-1.5">
            <input
              value={seedText}
              onChange={(e) => setSeedText(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
              inputMode="numeric"
              className="w-32 rounded-lg border border-white/15 bg-[#0a1822] px-2.5 py-2 font-mono text-[12px] tracking-normal text-white"
              aria-label="Scenario seed"
            />
            <button
              type="button"
              onClick={rollSeed}
              className="rounded-lg border border-white/15 p-2 text-white/60 transition hover:bg-white/10"
              title="Random seed"
              aria-label="Random seed"
            >
              <Dices size={14} />
            </button>
          </span>
        </label>
      </div>
      <p className="mt-2 font-sans text-[11px] text-white/45">{info.brief}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void launch("human")}
          disabled={busy !== null}
          className="flex items-center gap-2 rounded-xl bg-sky-500 px-5 py-3 text-[11px] font-bold uppercase tracking-[.18em] text-[#04121c] ring-1 ring-sky-200/40 transition hover:bg-sky-400 disabled:opacity-50"
        >
          <Play size={14} /> {active ? "Restart yourself" : "Play"}
        </button>
        <button
          onClick={() => void launch("jev")}
          disabled={busy !== null}
          className={secondary}
          title="Jev plays the same character with the same controls; press H to take over"
        >
          <Bot size={12} /> {busy === "jev" ? "Connecting to Jev…" : "Let Jev Play"}
        </button>
        <button
          onClick={() => void launch("assist")}
          disabled={busy !== null}
          className={secondary}
          title="You play; Jev helps with aim, route and warnings, within bounds"
        >
          <Users size={12} /> Play with Jev assist
        </button>
        <button
          onClick={() => void launch("baseline")}
          disabled={busy !== null}
          className="rounded-lg px-2 py-2 text-[9px] uppercase tracking-[.16em] text-white/35 underline-offset-2 transition hover:text-white/70 hover:underline disabled:opacity-40"
          title="A scripted player that needs no network: it is not Jev"
        >
          Scripted baseline (offline)
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-2 text-[9px] uppercase tracking-[.16em] text-white/35 transition hover:text-white/70"
          title="Replay a saved run; no decision service is called"
        >
          <FileUp size={11} /> Replay a trace
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            void chooseFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {message && (
        <p role="status" className="mt-2 font-sans text-[11px] text-amber-200/85">
          {message}
        </p>
      )}
    </div>
  );
}
