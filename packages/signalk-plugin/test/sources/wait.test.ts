import { expect, test } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { waitForHistorySource } from "../../src/sources/history.js";
import { BathymetrySource } from "../../src/types.js";

const found = { createReader: () => undefined } as unknown as BathymetrySource;
const interval = Temporal.Duration.from({ milliseconds: 1 });

test("returns a provider that registers after startup", async () => {
  let calls = 0;
  const source = await waitForHistorySource(
    async () => (++calls === 3 ? found : undefined),
    { timeout: Temporal.Duration.from({ seconds: 5 }), interval },
  );
  expect(source).toBe(found);
  expect(calls).toBe(3);
});

test("gives up when no provider appears in time", async () => {
  const source = await waitForHistorySource(async () => undefined, {
    timeout: Temporal.Duration.from({ milliseconds: 20 }),
    interval,
  });
  expect(source).toBeUndefined();
});

test("stops waiting when the plugin stops", async () => {
  const controller = new AbortController();
  const waiting = waitForHistorySource(async () => undefined, {
    timeout: Temporal.Duration.from({ minutes: 10 }),
    interval: Temporal.Duration.from({ seconds: 1 }),
    signal: controller.signal,
  });
  controller.abort();
  expect(await waiting).toBeUndefined();
});
