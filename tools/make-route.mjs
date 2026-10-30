#!/usr/bin/env node
// Builds public/sim/route.geojson for the dashboard's built-in simulator.
//
// Requests a cycling route between the given waypoints from the public
// OSRM instance run by FOSSGIS (routing.openstreetmap.de), concatenates the
// legs into one LineString and records which street each stretch is on, so
// the simulator can show a street name without calling a geocoder.
//
// Usage:
//   node tools/make-route.mjs [--profile bike|foot] [--out public/sim/route.geojson]
//                             [--server https://routing.openstreetmap.de] lon,lat lon,lat ...
//
// With no waypoints it uses University of Twente campus, Hengelosestraat and
// Oude Markt in Enschede. Node 18 or newer, no dependencies.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const USER_AGENT = 'road-surface-monitor/0.1 (student project)';
const PAUSE_MS = 1000;

const DEFAULT_WAYPOINTS = [
  [6.856, 52.2393], // University of Twente campus
  [6.8604, 52.2339], // Hengelosestraat
  [6.8958, 52.2213], // Oude Markt, Enschede
];

function parseArgs(argv) {
  const opts = {
    profile: 'bike',
    out: 'public/sim/route.geojson',
    server: 'https://routing.openstreetmap.de',
    waypoints: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile' || arg === '--out' || arg === '--server') {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tools/make-route.mjs [--profile bike|foot] [--out file] [--server url] lon,lat lon,lat ...',
      );
      process.exit(0);
    } else {
      const parts = arg.split(',').map(Number);
      if (parts.length !== 2 || parts.some(Number.isNaN)) fail(`Not a lon,lat pair: ${arg}`);
      opts.waypoints.push(parts);
    }
  }
  if (!['bike', 'foot'].includes(opts.profile))
    fail(`Unknown profile ${opts.profile}, use bike or foot`);
  if (opts.waypoints.length === 0) opts.waypoints = DEFAULT_WAYPOINTS;
  if (opts.waypoints.length < 2) fail('At least two waypoints are needed');
  return opts;
}

function fail(message) {
  console.error(`make-route: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  const data = await response.json();
  if (data.code !== 'Ok' || !data.routes?.length)
    throw new Error(`OSRM answered ${data.code ?? 'without a route'}`);
  return data.routes[0];
}

// One leg between two consecutive waypoints. Requesting legs separately
// avoids the U-turn artefacts OSRM produces when a via point sits on the
// wrong side of the road.
async function fetchLeg(from, to, opts) {
  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const query = 'overview=full&geometries=geojson&steps=true';
  const primary = `${opts.server}/routed-${opts.profile}/route/v1/driving/${coords}?${query}`;
  const fallback = `https://router.project-osrm.org/route/v1/driving/${coords}?${query}`;
  try {
    return {
      route: await fetchJson(primary),
      source: `OSRM (routing.openstreetmap.de, ${opts.profile} profile), OpenStreetMap data`,
    };
  } catch (err) {
    console.warn(
      `Primary server failed (${err.message}); trying router.project-osrm.org (car profile)`,
    );
    return {
      route: await fetchJson(fallback),
      source: 'OSRM (router.project-osrm.org, car profile), OpenStreetMap data',
    };
  }
}

function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const round1 = (x) => Math.round(x * 10) / 10;

function buildStreets(legs) {
  const streets = [];
  let offset = 0;
  let firstUnnamedRunDone = false;
  for (const leg of legs) {
    for (const step of leg.steps) {
      let name = step.name?.trim() ?? '';
      if (name === '') {
        // The route starts on unnamed campus paths; later unnamed stretches
        // are short cycle paths between named streets.
        name = firstUnnamedRunDone ? 'Unnamed path' : 'Campus paths';
      } else if (streets.length > 0 && streets[streets.length - 1].name === 'Campus paths') {
        firstUnnamedRunDone = true;
      }
      const from_m = round1(offset);
      offset += step.distance;
      const to_m = round1(offset);
      if (to_m === from_m) continue;
      const last = streets[streets.length - 1];
      if (last && last.name === name) {
        last.to_m = to_m;
      } else {
        streets.push({ name, from_m, to_m });
      }
    }
  }
  return streets;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const coordinates = [];
  const legs = [];
  let source = '';

  for (let i = 0; i < opts.waypoints.length - 1; i++) {
    if (i > 0) await sleep(PAUSE_MS);
    let result;
    try {
      result = await fetchLeg(opts.waypoints[i], opts.waypoints[i + 1], opts);
    } catch (err) {
      console.error(`make-route: could not fetch leg ${i + 1}: ${err.message}`);
      console.error(
        'No network or the routing servers are down. The shipped public/sim/route.geojson still works.',
      );
      process.exit(1);
    }
    const { route } = result;
    source = source || result.source;
    const points = route.geometry.coordinates;
    // Drop the first point of every leg after the first; it duplicates the
    // last point of the previous leg (the shared waypoint).
    coordinates.push(...(coordinates.length ? points.slice(1) : points));
    legs.push(...route.legs);
    console.log(`Leg ${i + 1}: ${round1(route.distance)} m, ${points.length} points`);
  }

  let length_m = 0;
  for (let i = 1; i < coordinates.length; i++)
    length_m += haversine(coordinates[i - 1], coordinates[i]);
  length_m = round1(length_m);

  const streets = buildStreets(legs);
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'University of Twente campus to Oude Markt',
          from: 'University of Twente campus, Enschede',
          to: 'Oude Markt, Enschede',
          length_m,
          profile: opts.profile,
          source,
          streets,
        },
        geometry: { type: 'LineString', coordinates },
      },
    ],
  };

  await mkdir(dirname(opts.out), { recursive: true });
  await writeFile(opts.out, JSON.stringify(geojson, null, 1) + '\n');

  console.log(
    `\nWrote ${opts.out}: ${coordinates.length} points, ${length_m} m (${opts.profile} profile)`,
  );
  console.log('Streets:');
  for (const s of streets)
    console.log(`  ${String(s.from_m).padStart(7)} to ${String(s.to_m).padStart(7)} m  ${s.name}`);
}

main().catch((err) => fail(err.message));
