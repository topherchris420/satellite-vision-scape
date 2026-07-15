import { createFileRoute } from "@tanstack/react-router";
import { SiteScene } from "@/components/site/SiteScene";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Site Digital Twin — Interactive 3D Reconstruction" },
      {
        name: "description",
        content:
          "Explore an interactive 3D reconstruction of a site with free-fly and first-person camera modes.",
      },
      { property: "og:title", content: "Site Digital Twin — Interactive 3D Reconstruction" },
      {
        property: "og:description",
        content:
          "Explore an interactive 3D reconstruction of a site with free-fly and first-person camera modes.",
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
