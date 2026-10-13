import { afterEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import schema from "../../../docs/CSB-schema-3_1_0-2024-04.json" with { type: "json" };
import type { Config } from "../src/config.js";

/**
 * Runs the built plugin inside a real Signal K server and checks what it
 * uploads to a stand-in trusted node: that the server can load the package,
 * that soundings reach it through the real delta and History API paths, and
 * that the submission is valid CSB with the depth reference it claims.
 *
 * Needs a signalk-server install: point SIGNALK_SERVER_DIR at its package
 * directory (e.g. node_modules/signalk-server). Skipped without one.
 */
const SERVER_DIR = process.env.SIGNALK_SERVER_DIR;
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PROVIDER = join(PLUGIN_DIR, "e2e/fixtures/history-provider");

// Transducer 0.5 m below the waterline; the depth path is below the transducer.
const config: Config = {
  path: "belowTransducer",
  sounder: { x: 0, y: 3, z: 0.5, make: "Airmar", model: "DST800" },
  gnss: { x: 0, y: 9, z: 2, make: "Garmin", model: "GPS 24xd" },
  sharing: { anonymous: false },
};

type Upload = {
  properties: {
    trustedNode: Record<string, unknown>;
    platform: Record<string, unknown>;
  };
  features: {
    geometry: { coordinates: [number, number] };
    properties: { depth: number; time: string };
  }[];
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A trusted node that hands out an identity and keeps every upload. */
async function startTrustedNode() {
  const uploads: Upload[] = [];
  const waiters: (() => void)[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    if (req.url?.endsWith("/identify")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          uuid: "e2e00000-0000-4000-8000-000000000000",
          token: "e2e",
        }),
      );
      return;
    }
    if (req.url?.endsWith("/geojson")) {
      const form = await new Request("http://node/geojson", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "" },
        body,
      }).formData();
      uploads.push(JSON.parse(await (form.get("file") as Blob).text()));
      waiters.splice(0).forEach((w) => w());
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ success: true, message: "ok", submissionIds: [] }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0);
  await once(server, "listening");
  cleanups.push(() => new Promise((r) => server.close(r)));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}/`,
    uploads,
    async next(timeoutMs = 30_000): Promise<Upload> {
      if (uploads.length) return uploads.shift()!;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("No upload reached the trusted node")),
          timeoutMs,
        );
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return uploads.shift()!;
    },
    /** Uploads until they hold at least `soundings` soundings between them. */
    async collect(soundings: number): Promise<Upload[]> {
      const collected: Upload[] = [];
      while (collected.reduce((n, u) => n + u.features.length, 0) < soundings) {
        collected.push(await this.next());
      }
      return collected;
    },
  };
}

interface ServerOptions {
  trustedNodeUrl: string;
  /** crowd-depth is enabled at boot, or later through the admin API. */
  enableAtBoot: boolean;
  historyRows?: object[];
}

async function startSignalK({
  trustedNodeUrl,
  enableAtBoot,
  historyRows,
}: ServerOptions) {
  const configDir = await mkdtemp(join(tmpdir(), "crowd-depth-e2e-"));
  cleanups.push(() => rm(configDir, { recursive: true, force: true }));
  const modules = join(configDir, "node_modules");
  await mkdir(join(configDir, "plugin-config-data"), { recursive: true });
  await mkdir(modules);
  await symlink(PLUGIN_DIR, join(modules, "crowd-depth"), "dir");
  const dependencies: Record<string, string> = { "crowd-depth": "*" };
  if (historyRows) {
    await symlink(
      HISTORY_PROVIDER,
      join(modules, "e2e-history-provider"),
      "dir",
    );
    dependencies["e2e-history-provider"] = "*";
    await writeFile(
      join(configDir, "plugin-config-data", "e2e-history-provider.json"),
      JSON.stringify({ enabled: true, configuration: {} }),
    );
  }
  await writeFile(
    join(configDir, "package.json"),
    JSON.stringify({ name: "e2e-config", private: true, dependencies }),
  );
  await writeFile(
    join(configDir, "settings.json"),
    JSON.stringify({ interfaces: {}, pipedProviders: [] }),
  );
  await writeFile(
    join(configDir, "defaults.json"),
    JSON.stringify({
      vessels: {
        self: {
          uuid: "urn:mrn:signalk:uuid:e2e00000-0000-4000-8000-000000000001",
          name: "E2E Vessel",
        },
      },
    }),
  );
  if (enableAtBoot) {
    await writeFile(
      join(configDir, "plugin-config-data", "crowd-depth.json"),
      JSON.stringify({ enabled: true, configuration: config }),
    );
  }

  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [join(SERVER_DIR!, "bin", "signalk-server")],
    {
      env: {
        ...process.env,
        SIGNALK_NODE_CONFIG_DIR: configDir,
        PORT: String(port),
        BATHY_URL: trustedNodeUrl,
        // Report every few seconds rather than every six hours.
        BATHY_DEFAULT_SCHEDULE: "*/3 * * * * *",
        E2E_HISTORY: JSON.stringify(historyRows ?? []),
        // Don't wait long for a history provider in tests that have none.
        BATHY_HISTORY_WAIT: "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  cleanups.push(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => (await fetch(`${base}/signalk`)).ok,
    () => log,
  );

  return {
    base,
    log: () => log,
    /** Waits for the plugin's status line in the admin API to match. */
    async waitForStatus(pattern: RegExp) {
      await waitFor(
        async () => {
          const plugins = (await (
            await fetch(`${base}/skServer/plugins`)
          ).json()) as { id: string; statusMessage?: string }[];
          const status = plugins.find(
            (p) => p.id === "crowd-depth",
          )?.statusMessage;
          return pattern.test(status ?? "");
        },
        () => log,
      );
    },
    async enable() {
      const res = await fetch(`${base}/skServer/plugins/crowd-depth/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, configuration: config }),
      });
      expect(res.ok, await res.text()).toBe(true);
    },
    async sendDeltas(deltas: object[]) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/signalk/v1/stream?subscribe=none`,
      );
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      for (const delta of deltas) {
        ws.send(JSON.stringify(delta));
        await new Promise((r) => setTimeout(r, 200));
      }
      ws.close();
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0);
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise((r) => server.close(r));
  return port;
}

async function waitFor(check: () => Promise<boolean>, log: () => string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting on the Signal K server:\n${log()}`);
}

function expectValidCsb(upload: Upload) {
  const validate = new Ajv({ allErrors: true }).compile(schema);
  expect(validate(upload), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

describe.skipIf(!SERVER_DIR)("uploads from a real Signal K server", () => {
  test("live soundings arrive measured from the waterline", async () => {
    const node = await startTrustedNode();
    const sk = await startSignalK({
      trustedNodeUrl: node.url,
      enableAtBoot: true,
    });
    // Soundings sent before the plugin subscribes would be lost.
    await sk.waitForStatus(/Next report at/);

    const fix = (i: number) => ({
      path: "navigation.position",
      value: { latitude: -17.6 + i * 1e-4, longitude: 177.43 },
    });
    const update = (values: object[]) => ({
      context: "vessels.self",
      updates: [
        {
          source: { label: "e2e" },
          timestamp: new Date().toISOString(),
          values,
        },
      ],
    });
    // A depth is only kept with a fresh position fix, so the GPS speaks first,
    // as it would on board.
    await sk.sendDeltas([
      update([fix(0)]),
      ...[3.2, 3.4, 3.6].map((depth, i) =>
        update([
          fix(i),
          { path: "environment.depth.belowTransducer", value: depth },
        ]),
      ),
    ]);

    // A report can fall between soundings, splitting them over two uploads.
    const uploads = await node.collect(3);
    uploads.forEach(expectValidCsb);
    for (const upload of uploads) {
      expect(upload.properties.trustedNode.verticalReferenceOfDepth).toBe(
        "Waterline",
      );
    }
    expect(
      uploads.flatMap((u) => u.features.map((f) => f.properties.depth)),
    ).toEqual([3.7, 3.9, 4.1]);
  });

  test("soundings read through the History API arrive measured from the waterline", async () => {
    const node = await startTrustedNode();
    const start = Date.now() - 60 * 60 * 1000;
    const rows = [3.2, 3.4, 3.6].map((depth, i) => ({
      time: new Date(start + i * 1000).toISOString(),
      latitude: -17.6 + i * 1e-4,
      longitude: 177.43,
      depth,
    }));
    const sk = await startSignalK({
      trustedNodeUrl: node.url,
      // The plugin picks its source when it starts, so it starts only once
      // the history provider has registered.
      enableAtBoot: false,
      historyRows: rows,
    });
    await sk.enable();

    const upload = await node.next();
    expectValidCsb(upload);
    expect(upload.properties.trustedNode.verticalReferenceOfDepth).toBe(
      "Waterline",
    );
    expect(upload.features.map((f) => f.properties.depth)).toEqual([
      3.7, 3.9, 4.1,
    ]);
  });
});
