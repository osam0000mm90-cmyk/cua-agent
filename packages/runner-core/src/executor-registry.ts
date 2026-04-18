import { type RunDetail } from "@cua-sample/replay-schema";

import { createUnsupportedScenarioError, type RunExecutor } from "./scenario-runtime.js";
import { createBookingExecutor } from "./scenarios/booking.js";
import { createDesktopExecutor } from "./scenarios/desktop.js";
import { createKanbanExecutor } from "./scenarios/kanban.js";
import { createPaintExecutor } from "./scenarios/paint.js";

export function createDefaultRunExecutor(detail: RunDetail): RunExecutor {
  switch (detail.scenario.id) {
    case "kanban-reprioritize-sprint":
      return createKanbanExecutor(detail.run.mode);
    case "paint-draw-poster":
      return createPaintExecutor(detail.run.mode);
    case "booking-complete-reservation":
      return createBookingExecutor(detail.run.mode);
    case "desktop-control-console":
      return createDesktopExecutor(detail.run.mode);
    default:
      throw createUnsupportedScenarioError(detail.scenario.id);
  }
}
