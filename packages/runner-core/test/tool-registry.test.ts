import { describe, expect, it } from "vitest";

import {
  buildAgentCapabilityManifest,
  buildAgentToolDefinitions,
} from "../src/tool-registry.js";

describe("tool registry", () => {
  it("includes desktop launch primitives alongside workspace tools", () => {
    const toolNames = buildAgentToolDefinitions().map((tool) => tool.name);

    expect(toolNames).toContain("desktop_open_target");
    expect(toolNames).toContain("desktop_get_environment");
    expect(toolNames).toContain("desktop_capture_screen");
    expect(toolNames).toContain("desktop_move_pointer");
    expect(toolNames).toContain("desktop_click_point");
    expect(toolNames).toContain("desktop_type_text");
    expect(toolNames).toContain("desktop_press_keys");
    expect(toolNames).toContain("desktop_get_window_state");
    expect(toolNames).toContain("desktop_read_clipboard");
    expect(toolNames).toContain("desktop_write_clipboard");
    expect(toolNames).toContain("desktop_run_sequence");
    expect(toolNames).toContain("workspace_run_terminal");
  });

  it("describes the desktop capability as enabled by default", () => {
    const manifest = buildAgentCapabilityManifest({ workspacePath: "/tmp/workspace" });
    const desktopCapability = manifest.capabilities.find(
      (capability) => capability.category === "desktop",
    );

    expect(desktopCapability).toBeDefined();
    expect(desktopCapability?.enabled).toBeDefined();
    expect(desktopCapability?.notes.join(" ")).toContain("screen capture");
  });
});
