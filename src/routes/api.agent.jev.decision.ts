import { createFileRoute } from "@tanstack/react-router";
import { handleJev } from "../server/agent/jev.server";
export const Route = createFileRoute("/api/agent/jev/decision")({
  server: {
    handlers: {
      GET: ({ request }) => handleJev(request),
      POST: ({ request }) => handleJev(request),
    },
  },
});
