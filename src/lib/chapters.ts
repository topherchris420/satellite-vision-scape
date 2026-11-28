/** Where each playable chapter of 99.9% SURE starts. */
export type Chapter = "san-fierro" | "pine-gap";

export const CHAPTER_HREF: Record<Chapter, string> = {
  "san-fierro": "/?chapter=san-fierro",
  "pine-gap": "/",
};

/** Explicit entry to the field transmission from a filed city report. */
export const DAILY_BREAD_BRIEFING_HREF = "/?briefing=daily-bread";

export const DAILY_BREAD_HREF = "/?chapter=san-fierro&mission=bakery";
export const CITY_CAMPAIGN_HREF = "/?chapter=san-fierro&story=full";
export const CITY_BRIEFING_HREF = "/?briefing=san-fierro";
