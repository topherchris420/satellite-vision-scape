/** Where each playable chapter of 99.9% SURE starts. */
export type Chapter = "san-fierro" | "pine-gap";

export const CHAPTER_HREF: Record<Chapter, string> = {
  "san-fierro": "/?chapter=san-fierro",
  "pine-gap": "/",
};
