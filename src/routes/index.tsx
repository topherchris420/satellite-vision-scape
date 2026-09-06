import { createFileRoute } from "@tanstack/react-router";
import { SiteScene } from "@/components/site/SiteScene";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pine Veil — Interactive Digital Twin" },
      {
        name: "description",
        content:
          "Explore Pine Veil, an interactive synthetic 3D reconstruction in Australia's Red Centre.",
      },
      { property: "og:title", content: "Pine Veil — Interactive Digital Twin" },
      {
        property: "og:description",
        content: "An interactive geospatial intelligence platform",
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
