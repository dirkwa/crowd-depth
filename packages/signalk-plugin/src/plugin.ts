import { ServerAPI, Plugin } from "@signalk/server-api";
import { schema, Config } from "./config.js";
import { createReporter } from "./reporters/index.js";
import { createSqliteSource } from "./sources/sqlite.js";
import { BATHY_HISTORY_WAIT, ENV } from "./constants.js";
import {
  createHistorySource,
  waitForHistorySource,
} from "./sources/history.js";
import { createDB } from "./storage.js";
import { join } from "path";
import { createCollector } from "./collector.js";
import { createStatus, Status } from "./status.js";
import { DatabaseSync } from "node:sqlite";
import { BathymetrySource } from "./types.js";

export default function createPlugin(app: ServerAPI): Plugin {
  let abortController: AbortController | undefined = undefined;

  /**
   * Records to SQLite while waiting for a history provider, then keeps
   * whichever source settles. Reporting starts only after that: a first report
   * read from a nearly empty SQLite would mark everything the provider holds
   * as already reported.
   */
  async function waitForHistory(
    config: Config,
    db: DatabaseSync,
    status: Status,
    signal: AbortSignal,
  ): Promise<BathymetrySource> {
    const sqlite = createSqliteSource(app, db);
    const recording = new AbortController();
    signal.addEventListener("abort", () => recording.abort(signal.reason), {
      once: true,
    });
    status.set({ collecting: true, waitingForHistory: true });
    createCollector({
      app,
      config,
      writer: sqlite.createWriter!(),
      signal: recording.signal,
    }).catch((err: unknown) => {
      if (!recording.signal.aborted) status.error(err as Error);
    });

    const history = await waitForHistorySource(
      () => createHistorySource(app, config),
      { timeout: BATHY_HISTORY_WAIT, signal },
    );
    status.set({ waitingForHistory: false });
    if (!history) {
      app.debug("No history provider appeared, recording to SQLite");
      return sqlite;
    }
    // The provider records the same stream itself.
    recording.abort("History provider found");
    status.set({ collecting: false, usingHistory: true });
    return history;
  }

  return {
    id: "crowd-depth",
    name: "Crowd Depth",
    description:
      "Collect and share depth data with crowd-sourced bathymetry programs",

    async start(config: Config) {
      app.debug("Starting (ENV=%s)", ENV);
      const status = createStatus(app);

      // A restart can replace abortController while this start still waits.
      const controller = new AbortController();
      abortController = controller;
      const db = createDB(join(app.getDataDirPath(), `bathymetry.sqlite`));

      let source = await createHistorySource(app, config);
      if (source) {
        status.set({ usingHistory: true });
      } else {
        source = await waitForHistory(config, db, status, controller.signal);
      }
      if (controller.signal.aborted) return;

      createReporter({
        app,
        config,
        source,
        db,
        status,
        signal: controller.signal,
      });
    },

    stop() {
      abortController?.abort("Stopping crowd-depth plugin");
    },

    schema() {
      return schema(app);
    },
  };
}
