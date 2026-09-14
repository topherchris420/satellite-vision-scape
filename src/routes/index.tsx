import { createFileRoute } from "@tanstack/react-router";
import { SiteScene } from "@/components/site/SiteScene";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pine Gap — Public Reference Reconstruction" },
      {
        name: "description",
        content:
          "Explore Pine Gap in 3D: historical public antenna coordinates at real-world scale, with approximate terrain and architecture.",
      },
      { property: "og:title", content: "Pine Gap — Public Reference Reconstruction" },
      {
        property: "og:description",
        content:
          "A historically anchored Pine Gap exterior reconstruction with approximate contextual terrain and buildings.",
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
