import { createFileRoute } from "@tanstack/react-router";
import { DigitalTwinPiece } from "@/components/thesis/DigitalTwinPiece";

export const Route = createFileRoute("/thesis")({
  // ?chrome=0 hides the playback bar and tweaks panel (used by the
  // headless recorder that produces the README video).
  validateSearch: (search: Record<string, unknown>): { chrome?: number } => ({
    chrome: search.chrome === 0 || search.chrome === "0" ? 0 : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Digital Twin Thesis — GeoTwn" },
      {
        name: "description",
        content:
          "Animated thesis: commodity graphics pipelines plus publicly available imagery yield convincing, navigable digital twins of complex infrastructure.",
      },
      { property: "og:title", content: "Digital Twin Thesis — GeoTwn" },
      { property: "og:type", content: "website" },
    ],
    // Self-hosted JetBrains Mono (public/fonts) so the piece renders
    // identically with no external font dependency.
    links: [{ rel: "stylesheet", href: "/fonts/jetbrains-mono.css" }],
  }),
  component: ThesisPage,
});

function ThesisPage() {
  const { chrome } = Route.useSearch();
  return (
    <div style={{ position: "fixed", inset: 0, background: "#060a0d" }}>
      <DigitalTwinPiece chrome={chrome !== 0} />
    </div>
  );
}
