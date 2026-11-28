import { CLAIMS, type FiledBakery } from "@/game/campaign/bakery";
import type { Verdict } from "@/game/campaign/sanFierro";
import { CHAPTER_HREF } from "@/lib/chapters";

const verdictLabel: Record<Verdict, string> = {
  accept: "Accepted",
  reject: "Rejected",
  abstain: "Withheld judgment",
};

const cargoNote: Record<Verdict, string> = {
  reject:
    "You checked the load before rejecting CERTAIN's warning. Bring that same scrutiny to the carrier.",
  accept:
    "You accepted CERTAIN's cargo warning. This time, check what the classifier actually measured.",
  abstain:
    "You left the cargo claim open. Here, log what you can confirm and mark what still needs a field check.",
};

const deliveryNote: Record<Verdict, string> = {
  accept:
    "The signed receipt backed up your observation at Harbor Table. Look for a second source here too.",
  reject:
    "Your delivery verdict disagreed with Harbor Table's signed receipt. If two sources disagree here, check the original record.",
  abstain:
    "You left the arrival open despite a signed receipt. Ask what each source can confirm independently.",
};

export function DailyBreadBriefing({
  report,
  onAccept,
}: {
  report: FiledBakery;
  onAccept: () => void;
}) {
  return (
    <section aria-labelledby="daily-bread-relay-title">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-[.2em] text-teal-300">
          R.A.I.N. Field relay
        </p>
        <span className="rounded bg-teal-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-teal-100">
          Fiction
        </span>
      </div>
      <h1 id="daily-bread-relay-title" className="mt-2 font-sans text-3xl font-light sm:text-4xl">
        Pine Gap briefing
      </h1>
      <p className="mt-3 font-sans text-sm leading-relaxed text-white/80">
        Christopher, I have your Daily Bread report. CERTAIN has linked an unlisted signal to
        utility truck U-2. I need you on the ground before anyone acts on that claim.
      </p>
      <dl
        aria-label="Christopher's filed Daily Bread findings"
        className="mt-4 grid gap-2 sm:grid-cols-2"
      >
        {[report.cargo, report.delivery].map((verdict, i) => (
          <div
            key={CLAIMS[i].id}
            className="rounded-lg border border-teal-200/20 bg-teal-950/50 p-3"
          >
            <dt className="font-sans text-xs text-white/80">{CLAIMS[i].text}</dt>
            <dd className="mt-1 text-xs font-bold text-amber-200">{verdictLabel[verdict]}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 font-sans text-sm leading-relaxed text-white/80">
        {cargoNote[report.cargo]}
      </p>
      <p className="mt-2 font-sans text-sm leading-relaxed text-white/80">
        {deliveryNote[report.delivery]}
      </p>
      <p className="mt-2 text-xs text-teal-200">Ines Calder</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={onAccept}
          className="min-h-11 rounded-lg bg-teal-300 px-4 font-bold text-teal-950 hover:bg-teal-200"
        >
          Go and look
        </button>
        <a
          href={CHAPTER_HREF["pine-gap"]}
          className="inline-flex min-h-11 items-center px-2 text-xs text-white/75 underline hover:text-white"
        >
          Back to Pine Gap
        </a>
      </div>
    </section>
  );
}
