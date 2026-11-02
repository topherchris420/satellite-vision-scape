import { createFileRoute } from "@tanstack/react-router";
import { SiteScene } from "@/components/site/SiteScene";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Beat the AI's time · Pine Gap, a playable reconstruction" },
      {
        name: "description",
        content:
          "Race an AI agent's recorded run through a playable 3D reconstruction of Pine Gap, in your browser, with no account or key. Then watch what the agent actually did.",
      },
      { property: "og:title", content: "Beat the AI's time" },
      {
        property: "og:description",
        content:
          "A browser game where you race an AI agent's recorded run through a reconstruction of Pine Gap, on the same seed, with the same controls.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return <SiteScene />;
}
