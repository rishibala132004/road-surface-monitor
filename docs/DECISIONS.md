# Decisions

Short records of the main technical choices. Newest at the bottom.

## 1. Vite with TypeScript and no UI framework

**Choice:** plain TypeScript with small hand-written components, built with Vite.

**Why:** the team knows embedded systems and Python better than front-end frameworks. A component here is a class that builds its DOM once and updates it from a single animation-frame loop, which reads much like a firmware main loop. There is no virtual DOM, no JSX and no build-time magic to learn. Vite gives fast development, a static build and TypeScript in strict mode so the data types in `src/data/contract.ts` are checked everywhere.

**Trade-off:** more DOM code than a framework would need. Kept manageable by the `el()` helper in `src/utils/dom.ts`.

## 2. MapLibre GL JS with CARTO vector styles

**Choice:** MapLibre GL JS, with the free, key-less CARTO Positron (light) and Dark Matter (dark) GL styles. Style URLs live in `public/config.json`.

**Why:** vector tiles give a map that can be restyled per theme, pitched for the follow camera and rotated for heading-up, which raster tiles cannot do well. CARTO's styles need no key and allow this use with attribution. OpenFreeMap styles are a drop-in alternative; change two URLs in the settings drawer or `config.json`.

**Offline:** when the style cannot be fetched, the map falls back to a plain background after eight seconds and the ride layers still draw, so the dashboard works with no internet.

## 3. Hand-written canvas charts

**Choice:** the timeline, class-probability bars, elevation profile and raw-signal plots are drawn directly on canvas or as plain DOM, with no charting library.

**Why:** the brief asks for charts that do not look like library defaults and for 60 fps during a 30-minute ride. The timeline redraws a few thousand samples in well under a millisecond, uses the same design tokens as the rest of the app (read back from CSS into a palette object), and needs no dependency. A library would have added 100 to 300 kB and its own look.

**Trade-off:** no built-in axis or tooltip helpers. The timeline implements the little it needs (a time axis in mm:ss, a crosshair, a tooltip).

## 4. One store, three sources, one parser

**Choice:** every data source (simulated, MQTT, replay) emits raw `(topic, payload)` pairs. `parseMessage` turns them into normalised messages and `RideStore.ingest` stores them. Nothing downstream knows where data came from.

**Why:** this is what makes the switch from fake to real data a matter of settings, not code. It also makes the simulator honest: it has to produce the same bytes a Pi would.

## 5. The switch from simulation to live data

**Choice:** the MQTT connection listens alongside the simulation. The first real _condition_ message stops the simulation, clears the store and switches to live. GPS-only traffic (a phone left running) does not trigger the switch. The app never switches back on its own; a "no data for N s" banner appears instead.

**Why:** the demo must not lose the live ride because of a short dropout, and a phone sending positions before the Pi is ready should not throw away a working simulation. A manual "switch to live now" button covers the odd case where only GPS is arriving.

## 6. GPS and condition join

**Choice:** conditions are joined to the nearest GPS fix within a configurable window (3 s by default), with interpolation when two fixes bracket the timestamp and the gap between them is not absurd. Conditions that arrive before their fix are joined when the fix comes in.

**Why:** the phone and the Pi are separate devices with separate clocks and separate delivery paths. A join by time is the only thing that works for both OwnTracks and a Pi-side GPS.

## 7. Comfort score

**Choice:** `100 x (smooth + 0.5 x rough) / (smooth + rough + bump) - 3 x bumps per km`, stops left out, clamped to 0 to 100, weights configurable.

**Why:** it is explainable in one sentence to a panel and it reacts to both the share of bad surface and the count of impacts. It is not a validated index; the formula is shown on hover so nobody mistakes it for one.

## 8. Reverse geocoding

**Choice:** Nominatim with a strict one-request-per-second queue, a cache keyed on a 40 m grid, and the live position prioritised. When Nominatim is unreachable, street names fall back to the names baked into `public/sim/route.geojson` (from OSRM), and otherwise to coordinates.

**Why:** Nominatim is free and key-less but has a strict usage policy. The queue and cache keep the dashboard inside it even with four bikes. The route fallback keeps the area report working offline, which matters on a campus network.

## 9. Self-hosted fonts

**Choice:** Saira Condensed (display), Public Sans (text) and JetBrains Mono (numbers), bundled through `@fontsource` packages.

**Why:** Google Fonts served from the network would break the typography offline and leak visitor data to a third party. Bundling adds about 250 kB once, cached by the browser.

## 10. Hex grid for the aggregated quality layer

**Choice:** a flat-top hexagonal grid of 28 m cells in a local metric projection around the first sample, coloured by the comfort of all samples in the cell across every ride seen in the session.

**Why:** hexes read as an aggregate rather than a track, cope with rides in both directions, and need no external library. 28 m is about one street width at the zoom levels used, so a cell says something about a stretch of road, not a lane.

## 11. Publisher queues messages and uses QoS 1 for conditions

**Choice:** `RoadPublisher` keeps a bounded queue while the broker is unreachable and flushes it in order on reconnect. Conditions are published with QoS 1, GPS and status with QoS 0.

**Why:** the hotspot drops out under bridges and between buildings. Conditions are the data the project is about, so losing them is worse than a short burst on reconnect; positions are replaced by the next fix anyway.
