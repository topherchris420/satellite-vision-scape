import { resolveAssists } from "./assists";
import { clientKeyFrom, createJevDecisionHandler } from "./handler";

/**
 * Server entry for the Jev decision endpoint. The TypeSafe credential lives
 * in the server environment (`TYPESAFE_API_KEY`, optionally `TYPESAFE_MODEL`)
 * and is read here, on the server, only. It is not `VITE_`-prefixed, so Vite
 * never inlines it; browser code never imports this module. Without it the
 * endpoint answers 503 and the game shows Jev as unavailable.
 *
 * `JEV_ASSISTS` (optional, not secret) sets how much the question coaches:
 * `full` (default), `lean`, `none`, or a comma list of assist ids.
 */
const handle = createJevDecisionHandler({
  apiKey: process.env["TYPESAFE_API_KEY"],
  model: process.env["TYPESAFE_MODEL"],
  assists: resolveAssists(process.env["JEV_ASSISTS"]),
});

export function handleJevRequest(request: Request): Promise<Response> {
  return handle(request, { clientKey: clientKeyFrom(request.headers, "unknown") });
}
