import { describe, expect, it } from "vitest";

import { describeDesktopControlBackend } from "../src/desktop-control.js";

describe("desktop control backend", () => {
  it("reports the active backend descriptor", () => {
    const backend = describeDesktopControlBackend();

    expect(backend).toMatchObject({
      backend: expect.any(String),
      supported: expect.any(Boolean),
    });
  });
});
