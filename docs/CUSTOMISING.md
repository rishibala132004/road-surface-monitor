# Customising

How to change the look and behaviour of the dashboard, from a slider in the browser to a new class in the code. In order of effort:

1. The settings drawer: no code, stored in this browser.
2. `public/config.json`: the deployed defaults, no rebuild needed.
3. `.env.local`: prefill the broker connection for local development.
4. `src/styles/tokens.css`: colours, fonts, spacing, motion.
5. Small code changes: map styles, the simulator route, classes, readings.

## 1. The settings drawer

Open it from the header (the gear icon). Every change goes through `ConfigStore.update` in `src/config/index.ts`, is applied immediately and saved in this browser's localStorage under the key `rsm.settings.v1`. Only the keys you changed are stored, so a later edit of `config.json` still takes effect for everything you did not touch.

| Section         | Control                                             | What it changes                                                                                                                   |
| --------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Appearance      | Theme                                               | `theme`: follow the system, light or dark. T in the header toggles light and dark explicitly.                                     |
|                 | Accent colour, Default                              | `accent`: overrides `--accent` and derives `--accent-soft`, `--accent-line` and a contrasting `--accent-ink`.                     |
|                 | Animation intensity                                 | `motion`, 0 to 1: scales decorative motion; 0 behaves like the system's reduced-motion setting.                                   |
| Road conditions | Per class: light colour, dark colour, pattern       | `classes[].colourLight`, `colourDark`, `pattern`. Colour overrides set `--cond-<id>` and `--cond-<id>-soft` for the active theme. |
|                 | Reset colours                                       | Restores `classes` from the deployed defaults.                                                                                    |
|                 | Label aliases                                       | `aliases`: one line per alias, `model label = class`. Replaces the whole table.                                                   |
|                 | Faint display below confidence                      | `lowConfidence`, 0 to 1: samples under it are drawn faint and dotted.                                                             |
| Data            | GPS join window (ms)                                | `joinWindowMs`, 500 to 30 000.                                                                                                    |
|                 | No-data warning after (s)                           | `broker.noDataTimeoutS`, 5 to 600.                                                                                                |
|                 | Area report segment length (m)                      | `segmentLengthM`, 10 to 200.                                                                                                      |
| Comfort score   | Smooth weight, Rough weight, Points per bump per km | `comfort.smoothWeight`, `comfort.roughWeight`, `comfort.bumpPenaltyPerKm`.                                                        |
| Units           | Speed                                               | `units.speed`: `kmh` or `ms`.                                                                                                     |
|                 | Coordinates                                         | `units.coords`: `dd` (decimal degrees) or `dms`.                                                                                  |
| Map             | Light style URL, Dark style URL                     | `map.styleLight`, `map.styleDark`: MapLibre style JSON URLs.                                                                      |
|                 | Street names from Nominatim                         | `geocoding.enabled`.                                                                                                              |
| Simulator       | Speed                                               | `simulator.speed`: 1x, 4x or 10x.                                                                                                 |
|                 | Second bike                                         | `simulator.secondBike`.                                                                                                           |
|                 | Model error rate                                    | `simulator.errorRate`, 0 to 0.2.                                                                                                  |
| Settings file   | Export JSON                                         | Downloads `dashboard-settings.json` containing only the changed keys.                                                             |
|                 | Import JSON                                         | Replaces the stored settings with the file's content.                                                                             |
|                 | Reset to defaults                                   | Clears `rsm.settings.v1`; the dashboard returns to `config.json` plus `.env.local`.                                               |

The Source drawer stores two more things in localStorage, separately from the settings: the connection (`rsm.connection.v1`: URL, username, topics, and the password only when "Remember" is ticked) and the OwnTracks phone-to-bike mapping, which is written into `broker.owntracksMap` in the settings.

## 2. public/config.json

Fetched at start with `cache: no-cache`, so editing it on the server changes the deployed defaults without a rebuild. `src/config/defaults.ts` holds an identical built-in copy used only when the file cannot be loaded; keep the two in step. The types are in `src/config/types.ts`. Resolution order, later wins: built-in defaults, `config.json`, `.env.local`, user settings.

| Key                                   | Type                                          | Default                                                | Meaning                                                                   |
| ------------------------------------- | --------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `title`                               | string                                        | `Road Surface Monitor`                                 | Shown in the header, the intro, the browser tab and the PNG snapshot.     |
| `team`                                | string[]                                      | four placeholder names                                 | Shown in the help drawer.                                                 |
| `course`                              | string                                        | `IoT course, University of Twente`                     | Shown in the help drawer.                                                 |
| `repoUrl`                             | string                                        | `https://github.com/<org>/<repo>`                      | "Source code" link in the help drawer.                                    |
| `theme`                               | `system`, `light`, `dark`                     | `system`                                               | Initial theme.                                                            |
| `accent`                              | CSS colour or `""`                            | `""`                                                   | Accent override; empty means the token in `tokens.css`.                   |
| `motion`                              | number 0 to 1                                 | `1`                                                    | Decorative motion scale.                                                  |
| `units.speed`                         | `kmh`, `ms`                                   | `kmh`                                                  | Speed unit.                                                               |
| `units.coords`                        | `dd`, `dms`                                   | `dd`                                                   | Coordinate format.                                                        |
| `classes[]`                           | array                                         | smooth, rough, bump, stopped                           | The classes the trained model outputs, in display order.                  |
| `classes[].id`                        | string, lower case                            |                                                        | Canonical id; must match the model's label (after aliasing).              |
| `classes[].name`                      | string                                        |                                                        | Display name.                                                             |
| `classes[].pattern`                   | `solid`, `hatched`, `pin`, `hollow`, `dotted` |                                                        | Line pattern on the map ribbon, in the timeline strip and in the legends. |
| `classes[].hint`                      | string                                        |                                                        | One line shown under the current condition.                               |
| `classes[].vibLevel`                  | number, m/s^2                                 | 0.9, 3.2, 8.5, 0.1                                     | Vibration assumed when a message carries no `vib` (shown as "est.").      |
| `classes[].colourLight`, `colourDark` | CSS colour                                    | unset                                                  | Optional colour overrides; otherwise `--cond-<id>` from `tokens.css`.     |
| `aliases`                             | object                                        | 18 entries (`good`, `cobbles`, `pothole`, `idle`, ...) | Lower-case alias to class id.                                             |
| `lowConfidence`                       | number 0 to 1                                 | `0.6`                                                  | Threshold for the faint and dotted style.                                 |
| `joinWindowMs`                        | number                                        | `3000`                                                 | GPS join window.                                                          |
| `segmentLengthM`                      | number                                        | `25`                                                   | Segment length for the area report.                                       |
| `comfort.smoothWeight`                | number                                        | `1`                                                    | See the comfort formula below.                                            |
| `comfort.roughWeight`                 | number                                        | `0.5`                                                  |                                                                           |
| `comfort.bumpPenaltyPerKm`            | number                                        | `3`                                                    |                                                                           |
| `broker.wsUrl`                        | string                                        | `""`                                                   | Prefills the Source drawer URL.                                           |
| `broker.username`                     | string                                        | `""`                                                   | Prefills the username. Never put a password here.                         |
| `broker.topicPrefix`                  | string                                        | `road`                                                 | First topic segment, for parsing and for the default subscriptions.       |
| `broker.extraTopics`                  | string[]                                      | `["owntracks/#"]`                                      | Subscribed in addition to `<prefix>/+/+` and `<prefix>/+/+/+`.            |
| `broker.owntracksMap`                 | object                                        | `{}`                                                   | `"user/device": "bikeN"`.                                                 |
| `broker.owntracksDefaultBike`         | string                                        | `bike1`                                                | Bike for unlisted phones, and for payloads with no device at all.         |
| `broker.noDataTimeoutS`               | number                                        | `20`                                                   | Seconds of silence in live mode before the banner.                        |
| `map.styleLight`, `map.styleDark`     | URL                                           | CARTO Positron and Dark Matter                         | MapLibre style JSON per theme.                                            |
| `map.center`                          | `[lon, lat]`                                  | `[6.876, 52.2305]`                                     | View before any data arrives.                                             |
| `map.zoom`                            | number                                        | `13.4`                                                 |                                                                           |
| `map.followZoomSlow`                  | number                                        | `17.2`                                                 | Follow zoom at 0 km/h.                                                    |
| `map.followZoomFast`                  | number                                        | `15.6`                                                 | Follow zoom at speed; the camera eases between the two.                   |
| `map.followPitch`                     | degrees                                       | `45`                                                   | Camera pitch while following.                                             |
| `map.graticule`                       | boolean                                       | `false`                                                | Grid on at start.                                                         |
| `geocoding.enabled`                   | boolean                                       | `true`                                                 | Reverse geocoding on or off.                                              |
| `geocoding.url`                       | URL                                           | Nominatim `reverse` endpoint                           | Any Nominatim-compatible endpoint.                                        |
| `geocoding.minIntervalMs`             | number                                        | `1100`                                                 | Minimum gap between requests; Nominatim asks for at least 1000.           |
| `geocoding.contact`                   | string                                        | `""`                                                   | Sent as the `email` parameter, as the Nominatim policy asks.              |
| `simulator.routeUrl`                  | path                                          | `sim/route.geojson`                                    | Relative to the site base.                                                |
| `simulator.speed`                     | 1, 4 or 10                                    | `1`                                                    | Playback multiplier.                                                      |
| `simulator.prefillS`                  | number                                        | `200`                                                  | Seconds generated instantly at start.                                     |
| `simulator.secondBike`                | boolean                                       | `false`                                                |                                                                           |
| `simulator.errorRate`                 | number 0 to 1                                 | `0.04`                                                 | Fraction of windows the simulated model gets wrong.                       |

## 3. .env.local

Copy `.env.example` to `.env.local` (ignored by git) to prefill the connection during development:

```
VITE_BROKER_WS_URL=wss://xxxx.s1.eu.hivemq.cloud:8884/mqtt
VITE_BROKER_USERNAME=dashboard
VITE_TOPIC_PREFIX=road
```

These map onto `broker.wsUrl`, `broker.username` and `broker.topicPrefix` and sit between `config.json` and the user settings. A `VITE_BROKER_WS_URL` that still contains `{{` is ignored. There is deliberately no password variable: passwords are typed into the Source drawer and stay in the browser.

## 4. tokens.css

`src/styles/tokens.css` defines every design value once. The `:root` block holds the light palette together with the theme-independent values (typefaces, type scale, spacing, radii, durations, easings, layout sizes, z-index layers). The `:root[data-theme='dark']` block redefines only the colours. `ThemeManager` (`src/components/theme.ts`) sets `data-theme` on `<html>` from the setting or the system preference, and reads the resolved values back into a palette object for the canvas and WebGL parts that cannot use CSS variables.

- **Accent**: `--accent`, `--accent-ink`, `--accent-soft`, `--accent-line` in both blocks. The settings drawer override replaces these at runtime.
- **Condition colours**: `--cond-smooth`, `--cond-rough`, `--cond-bump`, `--cond-stopped`, `--cond-unknown` and their `-soft` variants, in both blocks. They are colourblind-safe and always paired with a pattern and a text label. Bike colours are `--bike-1` to `--bike-4`.
- **Fonts**: `--font-display` (Saira Condensed), `--font-text` (Public Sans), `--font-mono` (JetBrains Mono). The files come from `@fontsource` packages imported at the top of `src/main.ts`; to change a font, install the `@fontsource/<name>` package, swap the imports there and the family in the token.
- **Spacing and radii**: `--space-1` to `--space-7`, `--radius-xs` to `--radius-pill`.
- **Motion**: `--dur-fast`, `--dur-base`, `--dur-slow`, `--dur-intro`, the easing curves, and `--motion-scale`, which the animation intensity setting drives. `prefers-reduced-motion` sets all durations to 0.
- **Presentation mode**: `:root[data-presentation='true']` raises the root font size to 20 px and widens the rail; everything in rem scales with it.

## 5. Map styles

Any MapLibre style JSON works. The defaults are the key-less CARTO styles. OpenFreeMap is a drop-in alternative: `https://tiles.openfreemap.org/styles/positron` (light) and `https://tiles.openfreemap.org/styles/dark` (dark). Set them in the settings drawer (Map section) or in `config.json`. A self-hosted style (for example from a local tile server) works the same way; it must be reachable over https when the dashboard is served from GitHub Pages. When a style cannot be fetched, `MapController` falls back after about eight seconds to a plain background and shows "Map tiles unavailable offline".

## 6. The simulator route

`public/sim/route.geojson` is one `LineString` feature. Its `properties.streets` array lists `{ name, from_m, to_m }` stretches along the line, which the geocoder uses for street names when Nominatim is unreachable. Regenerate it with `tools/make-route.mjs`, which asks the public FOSSGIS OSRM server for a cycling route through the given waypoints (longitude first):

```sh
npm run make-route -- 6.856,52.2393 6.8604,52.2339 6.8958,52.2213
# options: --profile bike|foot   --out public/sim/route.geojson   --server https://routing.openstreetmap.de
```

With no waypoints it uses the campus, Hengelosestraat and Oude Markt. The ride profile (where the rough sections, bumps and stops are) is defined as fractions of the route length in `defaultProfile` in `src/data/sources/SimulatedSource.ts`, so it adapts to a new route; the bundled test `tests/simulator.test.ts` expects a route of 4 to 5 km in Enschede, adjust it if yours differs. Set `map.center` to the new area.

To regenerate the bundled demo ride for the backup replay run `npm run make-demo` (`tools/make-demo-ride.mjs`, options `--seconds 1500 --bikes 1 --out public/samples/demo-ride.jsonl`). It drives the same simulator headless with a fixed seed and a fixed start time of 6 November 2026, 10:00 CET.

## 7. Adding a class

1. Add an entry to `classes` in `public/config.json` (and `src/config/defaults.ts`): `id`, `name`, `pattern`, `hint`, `vibLevel`. The id must be lower case and match what the model outputs, or add an alias.
2. Add `--cond-<id>` and `--cond-<id>-soft` to both palette blocks in `tokens.css`. Without the token the class falls back to the unknown colour in the palette, and CSS rules that reference `var(--cond-<id>)` have no value. Alternatively set `colourLight` and `colourDark` on the class.
3. Choose a `pattern`. `hatched` and `hollow` are drawn as overlays on the map ribbon and in the timeline strip, `dotted` is drawn like a low-confidence run, `solid` is a plain line. `pin` only affects the legend swatch; pins on the map are placed for bump events, which are tied to the `bump` id.
4. The new class automatically gets a probability bar, a legend row, a share in the statistics and a `p_<id>` column in the CSV. The comfort score, the hex aggregate, bump events and stops only look at `smooth`, `rough`, `bump` and `stopped`; extend `recomputeStats` in `src/data/store.ts`, `buildHexGrid` in `src/map/layers.ts` and the cyclist's surface drawing in `src/components/cyclist.ts` if the new class should take part.
5. `vibLevel` is the vibration shown when a message carries no measurement; pick something between the existing classes.

## 8. Adding a reading

The eight tiles under "Live readings" are defined in `Rail` (`src/components/readouts.ts`) in the `defs` array of `[key, label, unit]` triples, and filled in `renderNumbers` with `set(key, value)`. Add a triple and a `set` call; the values usually come from `d.stats` (`DeviceStats` in `src/data/store.ts`) or the current `Sample`. The summary grid below works the same way with `sumDefs` and `this.summary.get(key)`. If the value needs a new counter, add it to `DeviceStats` and compute it in `recomputeStats`.

## 9. The comfort formula

```
comfort = 100 x (smoothWeight x smooth + roughWeight x rough) / (smooth + rough + bump) - bumpPenaltyPerKm x bumpsPerKm
```

`smooth`, `rough` and `bump` are window counts, stopped windows are left out, and the result is clamped to 0 to 100. The weights are in `comfort` in `config.json` and in the settings drawer; the formula itself is `recomputeStats` in `src/data/store.ts`, and `comfortFormula()` builds the hover text so the two stay together. The street comfort in the area report (`groupByStreet` in `src/map/segments.ts`) and the hex colours use the same weights.

## 10. Geocoding

Switch it off with `geocoding.enabled: false` or the "Street names from Nominatim" checkbox. The place card then shows the route's baked-in street names where the bike is on the simulator route and plain coordinates elsewhere, and the area report groups by those names. The Nominatim usage policy asks for at most one request per second and a contact address; the dashboard queues requests at `minIntervalMs` (1100 ms), caches results on a 40 m grid and sends `geocoding.contact` as the `email` parameter. Fill it in before a long live session.

## 11. Join window and no-data timeout

`joinWindowMs` (default 3000) is how far apart a condition and a GPS fix may be to be joined; interpolation is used when two fixes bracket the condition and are at most 4 x window apart, and a fix arriving late is attached to conditions up to 2 x window back. Widen it if the phone reports every 5 s. `broker.noDataTimeoutS` (default 20) is how long live data may be silent before the "No data for N s" banner. Both are in the settings drawer under Data.

## 12. Keyboard shortcuts

`src/components/shortcuts.ts` holds the `SHORTCUTS` table (shown in the help drawer) and `installShortcuts`, a single `keydown` listener that ignores key presses while typing in a field and any press with Ctrl, Alt or Meta. Add a row to the table and a case to the switch; the actions are wired in `src/main.ts`.
