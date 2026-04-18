import { describe, expect, it } from "vitest";

import { buildAgentCapabilityManifest, buildAgentToolDefinitions } from "./tool-registry.js";

describe("runner-core tool registry", () => {
  it("exposes the desktop window management layer", () => {
    const toolNames = buildAgentToolDefinitions().map((tool) => tool.name);

    expect(toolNames).toContain("desktop_list_windows");
    expect(toolNames).toContain("desktop_focus_window");
    expect(toolNames).toContain("desktop_capture_screen");
    expect(toolNames).toContain("desktop_context_snapshot");
  });

  it("describes desktop focus and listing in the capability manifest", () => {
    const manifest = buildAgentCapabilityManifest({
      workspacePath: "C:/tmp/cua-workspace",
    });

    const desktopCapability = manifest.capabilities.find(
      (capability) => capability.category === "desktop",
    );

    expect(desktopCapability?.enabled).toBe(true);
    expect(desktopCapability?.notes?.join(" ")).toContain("window listing");
    expect(desktopCapability?.notes?.join(" ")).toContain("focus control");
    expect(desktopCapability?.notes?.join(" ")).toContain("desktop snapshot");
  });
});
