import { createDecisionHandler } from "./handler";
// TanStack server route only. Never imported by the client runtime.
export const handleJev = createDecisionHandler({
  key: process.env.TYPESAFE_API_KEY,
  model: process.env.TYPESAFE_MODEL,
});
