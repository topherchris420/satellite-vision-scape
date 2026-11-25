import { describe, expect, test } from "bun:test";
import { CHAPTER_HREF } from "../src/lib/chapters";

describe("chapter links", () => {
  test("the San Fierro link opens the chapter the index route looks for", () => {
    const url = new URL(CHAPTER_HREF["san-fierro"], "https://example.test");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("chapter")).toBe("san-fierro");
  });
  test("the Pine Gap link opens the default scene", () => {
    const url = new URL(CHAPTER_HREF["pine-gap"], "https://example.test");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("chapter")).toBeNull();
  });
});
