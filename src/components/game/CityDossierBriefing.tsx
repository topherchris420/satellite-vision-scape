import type { readCityDossier } from "@/game/campaign/cityRecord";
import { RESEARCH } from "@/game/campaign/cityResearchData";
import { EPISODES, TRIAGE } from "@/game/campaign/cityEpisodes";
import { CHAPTER_HREF, CITY_CAMPAIGN_HREF } from "@/lib/chapters";

type Dossier = NonNullable<ReturnType<typeof readCityDossier>>;
function finding(value: string | undefined | null) {
  return value === "accept"
    ? "Accepted"
    : value === "reject"
      ? "Rejected"
      : value === "abstain"
        ? "Withheld judgment"
        : (value ?? "Open");
}
export function CityDossierBriefing({
  dossier,
  onAccept,
}: {
  dossier: Dossier;
  onAccept: () => void;
}) {
  const { city, bakery } = dossier;
  const { first, outcomes } = city;
  const rows = [
    ["Dangerous cargo", finding(bakery.cargo)],
    ["Arrival at Harbor Table", finding(bakery.delivery)],
    ["Ghost Frequency relay", finding(outcomes.relay)],
    ...TRIAGE.map((p, i) => [p.name, finding(outcomes.triage[i].result)]),
    ["Ice cream and crime", finding(first.ice)],
    ["Live broadcast", outcomes.debate === "pursuit" ? "Protest pursuit" : "Quiet return"],
    ["Independent replications", String(outcomes.kits)],
    ["Replication claim", finding(first.replication)],
    ["Demonstration power", first.power === "trace" ? "Recovered fuse" : "Wagon battery"],
    ["Private fee", first.fee === "take" ? "Accepted" : "Refused"],
  ];
  const decisions = EPISODES.flatMap((episode) =>
    episode.tasks.flatMap((task) =>
      task.kind === "choice" && first[task.id] ? [[task.title, finding(first[task.id])]] : [],
    ),
  );
  const research = RESEARCH.filter((c) => city.research[c.id]);
  return (
    <section aria-labelledby="city-dossier-title">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-[.2em] text-teal-300">
          R.A.I.N. Field relay
        </p>
        <span className="rounded bg-teal-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-teal-100">
          Fiction
        </span>
      </div>
      <h1 id="city-dossier-title" className="mt-2 font-sans text-3xl font-light sm:text-4xl">
        Pine Gap briefing
      </h1>
      <p className="mt-3 font-sans text-sm leading-relaxed text-white/85">
        Christopher, the San Fierro dossier is here.{" "}
        {first.fee === "take"
          ? "Since you took Bracket's fee, log who funds every reading and keep an independent copy."
          : "You kept the results in the public registry. Leave enough of a record here for someone else to check your work."}{" "}
        CERTAIN has linked an unlisted carrier to utility truck U-2. Meet me at the van and start a
        separate field record.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="min-h-11 rounded-lg bg-teal-300 px-4 font-bold text-teal-950 hover:bg-teal-200"
          onClick={onAccept}
        >
          Go and look
        </button>
        <a className="px-2 text-xs text-white/75 underline" href={CHAPTER_HREF["pine-gap"]}>
          Back to Pine Gap
        </a>
      </div>
      <dl
        aria-label="Filed San Fierro choices"
        className="mt-5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3"
      >
        {rows.map(([label, value]) => (
          <div className="rounded border border-teal-200/20 bg-teal-950/50 p-2" key={label}>
            <dt>{label}</dt>
            <dd className="mt-1 capitalize text-amber-200">{value}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-4 text-xs text-teal-100">
        <summary className="cursor-pointer">Christopher's first filed answers</summary>
        <ul className="mt-2 space-y-1">
          {decisions.map(([claim, result]) => (
            <li key={claim}>
              {claim} · {result}
            </li>
          ))}
        </ul>
      </details>
      {(research.length > 0 || city.modes.length > 0 || city.control) && (
        <details className="mt-4 text-xs text-teal-100">
          <summary className="cursor-pointer">
            HQ research · {research.length} filed · reputation {city.reputation} / 100
          </summary>
          <ul className="mt-2 space-y-1">
            {research.map((c) => (
              <li key={c.id}>
                {c.title} · {finding(city.research[c.id].verdict)} · {city.research[c.id].audit}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            Cymatics atlas {city.modes.length} / 6
            {city.control ? " · Generator-off control filed" : ""}
          </p>
        </details>
      )}
      <a
        href={CITY_CAMPAIGN_HREF}
        className="mt-3 inline-flex min-h-11 items-center text-xs text-white/60 underline"
      >
        Return to Vers3Dynamics HQ
      </a>
    </section>
  );
}
