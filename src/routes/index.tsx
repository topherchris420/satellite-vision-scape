import { lazy, Suspense, useEffect, useState } from "react";
import { SanFierro } from "@/components/game/SanFierro";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { SiteScene } from "@/components/site/SiteScene";

const BakeryCity = lazy(() => import("@/components/game/BakeryCity").then(m => ({ default: m.BakeryCity })));

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
  const search = useLocation({ select: (location) => location.searchStr });
  const sanFierro = new URLSearchParams(search).get("chapter") === "san-fierro";
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (sanFierro && mounted && new URLSearchParams(search).get("mission") === "bakery")
    return <Suspense fallback={<main>Opening the waterfront...</main>}><BakeryCity /></Suspense>;
  if (sanFierro) return mounted ? <SanFierro /> : <main className="min-h-screen bg-black p-8 text-white">Loading San Fierro…</main>;
  return <SiteScene />;
}
