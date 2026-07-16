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
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap",
      },
    ],
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
