/**
 * The two playable chapters of 99.9% SURE, side by side, so a player can see
 * both exist and move between them from either one. Plain links: switching
 * chapter reloads the page, which unmounts the other chapter's scene entirely.
 */

import { CHAPTER_HREF, type Chapter } from "@/lib/chapters";

const CHAPTERS: { id: Chapter; number: string; name: string }[] = [
  { id: "san-fierro", number: "I", name: "San Fierro" },
  { id: "pine-gap", number: "II", name: "Pine Gap" },
];

export function ChapterSwitch({
  current,
  className = "",
}: {
  current: Chapter;
  className?: string;
}) {
  return (
    <nav
      aria-label="Choose a chapter"
      className={`inline-flex rounded-lg bg-black/60 p-0.5 ring-1 ring-white/15 ${className}`}
    >
      {CHAPTERS.map((c) =>
        c.id === current ? (
          <span
            key={c.id}
            aria-current="page"
            className="rounded-md bg-white/90 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.14em] text-black"
          >
            <span className="opacity-60">{c.number} ·</span> {c.name}
          </span>
        ) : (
          <a
            key={c.id}
            href={CHAPTER_HREF[c.id]}
            className="rounded-md px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.14em] text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/60"
          >
            <span className="opacity-60">{c.number} ·</span> {c.name}
          </a>
        ),
      )}
    </nav>
  );
}
