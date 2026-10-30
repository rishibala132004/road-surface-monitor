#!/usr/bin/env node
/**
 * Writes public/samples/demo-ride.jsonl: a recorded simulated ride that the
 * dashboard can replay without a Pi or a broker (the demo-day backup).
 *
 * Usage: node tools/make-demo-ride.mjs [--seconds 1500] [--bikes 1] [--out public/samples/demo-ride.jsonl]
 *
 * The simulator is TypeScript, so the script loads it through Vite's
 * server-side module loader instead of duplicating the ride logic.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const seconds = Number(opt('seconds', 1500));
const bikes = Number(opt('bikes', 1));
const out = resolve(opt('out', 'public/samples/demo-ride.jsonl'));

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true },
});
try {
  const { SimulatedRide } = await server.ssrLoadModule('/src/data/sources/SimulatedSource.ts');
  const route = JSON.parse(readFileSync('public/sim/route.geojson', 'utf8')).features[0].geometry
    .coordinates;
  // A fixed start time so the file is reproducible: 6 November 2026, 10:00 CET.
  const start = Date.UTC(2026, 10, 6, 9, 0, 0);
  const ride = new SimulatedRide(
    route,
    {
      topicPrefix: 'road',
      classIds: ['smooth', 'rough', 'bump', 'stopped'],
      speed: 1,
      prefillS: 0,
      secondBike: bikes > 1,
      errorRate: 0.04,
      bikeIds: ['bike1', 'bike2'],
      seed: 20261106,
    },
    start,
  );
  const lines = [];
  for (let i = 0; i < seconds; i++) {
    for (const m of ride.step()) {
      // Receipt a little after the message time, like a real network.
      lines.push(
        JSON.stringify({
          t: ride.simTime + 120 + Math.floor(Math.random() * 60),
          topic: m.topic,
          payload: JSON.stringify(m.payload),
        }),
      );
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(
    `Wrote ${lines.length} messages (${seconds} s, ${bikes} bike${bikes > 1 ? 's' : ''}) to ${out}`,
  );
} finally {
  await server.close();
}
