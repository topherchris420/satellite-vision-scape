import { createFileRoute } from "@tanstack/react-router";
import { handleJevRequest } from "../server/agent/jev.server";

/**
 * `GET /api/agent/jev/decision` — configuration probe (no model call).
 * `POST /api/agent/jev/decision` — one Jev decision for one observation.
 * All behaviour lives in `src/server/agent/handler.ts`.
 */
export const Route = createFileRoute("/api/agent/jev/decision")({
  server: {
    handlers: {
      GET: ({ request }) => handleJevRequest(request),
      HEAD: ({ request }) => handleJevRequest(request),
      POST: ({ request }) => handleJevRequest(request),
    },
  },
});
