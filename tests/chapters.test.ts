import { describe, expect, test } from "bun:test";
import { DAILY_BREAD_BRIEFING_HREF, CHAPTER_HREF } from "../src/lib/chapters";

describe("chapter links", () => {
  test("the San Fierro link opens the chapter the index route looks for", () => {
    const url = new URL(CHAPTER_HREF["san-fierro"], "https://example.test");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("chapter")).toBe("san-fierro");
  });
  test("the city handoff opts into the field briefing on the Pine Gap route", () => {
    const url = new URL(DAILY_BREAD_BRIEFING_HREF, "https://example.test");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("briefing")).toBe("daily-bread");
    expect(url.searchParams.has("chapter")).toBe(false);
    expect(CHAPTER_HREF["pine-gap"]).toBe("/");
  });
  test("the Pine Gap link opens the default scene", () => {
    const url = new URL(CHAPTER_HREF["pine-gap"], "https://example.test");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("chapter")).toBeNull();
  });
});
