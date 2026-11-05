import { useEffect, useRef, useState } from "react";
import type { Game } from "@/game/Game";
import { challengeInfo } from "@/game/freeroam/Scenario";
import { useFreeRoam } from "@/hooks/use-free-roam";
import { formatClock } from "@/lib/freeroam-ui";

/**
 * The beats of a run, given a moment on screen: the challenge's name as it
 * begins, each new stage as it opens, the outcome when it is decided, and the
 * name of a vehicle as you climb into it. Cards sweep in, hold and fade; they
 * never take input and never block the view for long.
 *
 * Presentation only: they listen to events and write nothing back.
 */

interface Card {
  key: number;
  tone: "intro" | "stage" | "success" | "failed";
  kicker: string;
  title: string;
  detail: string | null;
}

const CARD_MS = 2600;
const VEHICLE_MS = 2800;

const TONE: Record<Card["tone"], { kicker: string; title: string; rule: string }> = {
  intro: { kicker: "text-amber-200/80", title: "text-white", rule: "via-amber-200/70" },
  stage: { kicker: "text-sky-300", title: "text-white", rule: "via-sky-300/70" },
  success: { kicker: "text-emerald-300", title: "text-emerald-50", rule: "via-emerald-300/80" },
  failed: { kicker: "text-rose-300", title: "text-rose-50", rule: "via-rose-300/80" },
};

export function TitleCards({ game }: { game: Game }) {
  const fr = useFreeRoam(game);
  const [card, setCard] = useState<Card | null>(null);
  const [vehicle, setVehicle] = useState<{ key: number; model: string; callsign: string } | null>(
    null,
  );
  const [alert, setAlert] = useState<{
    key: number;
    title: string;
    detail: string;
    hot: boolean;
  } | null>(null);
  const alertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counter = useRef(0);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vehicleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = fr.active;

  // A run begins (or begins again): its name and the first thing to do.
  useEffect(() => {
    if (!active) return;
    const roam = game.freeRoam;
    const show = (next: Omit<Card, "key">) => {
      setCard({ ...next, key: ++counter.current });
      if (cardTimer.current) clearTimeout(cardTimer.current);
      cardTimer.current = setTimeout(() => setCard(null), CARD_MS);
    };
    const intro = () => {
      const info = challengeInfo(roam.challengeId);
      const stage = roam.challenge?.stage;
      show({
        tone: "intro",
        kicker: info?.kind === "free" ? "Free Roam" : `Free Roam · seed ${roam.seed}`,
        title: info?.title ?? "Free Roam",
        detail: stage?.title ?? info?.brief ?? null,
      });
    };
    intro();
    const offs = [
      roam.events.on("reset", intro),
      roam.events.on("stage", (e) => {
        if (e.index === 0) return;
        show({
          tone: "stage",
          kicker: `Stage ${e.index + 1} / ${e.total}`,
          title: roam.challenge?.stage?.title ?? "Next stage",
          detail: roam.challenge?.stage?.hint ?? null,
        });
      }),
      roam.events.on("challenge", (e) => {
        show(
          e.status === "success"
            ? {
                tone: "success",
                kicker: challengeInfo(roam.challengeId)?.title ?? "Challenge",
                title: "Challenge complete",
                detail: formatClock(Math.floor(roam.simTime)),
              }
            : {
                tone: "failed",
                kicker: challengeInfo(roam.challengeId)?.title ?? "Challenge",
                title: "Challenge failed",
                detail: e.reason || null,
              },
        );
      }),
      roam.events.on("pursuit", (e) => {
        const hot = e.phase === "started";
        setAlert({
          key: ++counter.current,
          hot,
          title: hot ? "Pursuit" : "Pursuit over",
          detail: hot
            ? "Response units are on their way"
            : "Out of sight long enough: they have stood down",
        });
        if (alertTimer.current) clearTimeout(alertTimer.current);
        alertTimer.current = setTimeout(() => setAlert(null), 3400);
      }),
      game.events.on("vehicleEnter", (e) => {
        const v = game.vehicles.vehicles.find((x) => x.id === e.vehicleId);
        if (!v) return;
        setVehicle({ key: ++counter.current, model: v.spec.model, callsign: v.id });
        if (vehicleTimer.current) clearTimeout(vehicleTimer.current);
        vehicleTimer.current = setTimeout(() => setVehicle(null), VEHICLE_MS);
      }),
    ];
    return () => {
      for (const off of offs) off();
      if (cardTimer.current) clearTimeout(cardTimer.current);
      if (vehicleTimer.current) clearTimeout(vehicleTimer.current);
      if (alertTimer.current) clearTimeout(alertTimer.current);
      setCard(null);
      setVehicle(null);
      setAlert(null);
    };
  }, [game, active, fr.seed, fr.challengeId]);

  if (!active) return null;
  const tone = card ? TONE[card.tone] : null;
  return (
    <>
      {card && tone && (
        <div
          key={card.key}
          className="fr-card pointer-events-none absolute left-1/2 top-[27%] z-[15] w-[min(44rem,92vw)] text-center"
          aria-live="polite"
        >
          <div
            className={`font-mono text-[10px] font-bold uppercase tracking-[.42em] ${tone.kicker}`}
          >
            {card.kicker}
          </div>
          <div
            className={`mt-2 font-sans text-3xl font-extralight uppercase tracking-[.14em] drop-shadow-[0_4px_28px_rgba(0,0,0,.85)] sm:text-5xl ${tone.title}`}
          >
            {card.title}
          </div>
          <div
            className={`fr-card-rule mx-auto mt-3 h-px w-3/4 bg-gradient-to-r from-transparent ${tone.rule} to-transparent`}
          />
          {card.detail && (
            <div className="mt-2 font-sans text-[13px] text-white/75 drop-shadow-[0_2px_12px_rgba(0,0,0,.9)]">
              {card.detail}
            </div>
          )}
        </div>
      )}
      {alert && (
        <div
          key={alert.key}
          className="fr-toast pointer-events-none absolute right-5 top-[42%] z-[15] text-right"
          role="status"
        >
          <div
            className={`font-sans text-2xl font-light uppercase tracking-[.22em] drop-shadow-[0_3px_18px_rgba(0,0,0,.9)] ${
              alert.hot ? "text-rose-200" : "text-emerald-200"
            }`}
          >
            {alert.title}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[.2em] text-white/65">
            {alert.detail}
          </div>
        </div>
      )}
      {vehicle && (
        <div
          key={vehicle.key}
          className="fr-toast pointer-events-none absolute bottom-48 right-5 z-[15] text-right sm:bottom-52"
        >
          <div className="font-sans text-2xl font-light italic tracking-wide text-white drop-shadow-[0_3px_18px_rgba(0,0,0,.9)] sm:text-3xl">
            {vehicle.model}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[.3em] text-amber-200/80">
            {vehicle.callsign}
          </div>
        </div>
      )}
    </>
  );
}
