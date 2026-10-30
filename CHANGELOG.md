# Changelog

All notable changes to this project are recorded here. The format follows Keep a Changelog, and the project uses semantic versioning.

## [Unreleased]

## [0.1.0] - 2026-10-29

First complete version for the demo on 6 November 2026.

### Added

- Data contract with a tolerant parser (seconds or milliseconds, confidence 0 to 1 or 0 to 100, label aliases, OwnTracks positions) and a single ride store with derived statistics.
- Simulated ride along real streets from the University of Twente campus to the Oude Markt, with rough sections, bumps, traffic-light stops, GPS noise and model mistakes.
- MQTT source over WebSockets with reconnect and an automatic switch from simulation to live data on the first real result.
- Replay of recorded `.jsonl` logs at 1x to 10x with pause and seek, plus a bundled demo ride.
- MapLibre map with a condition-coloured and patterned ribbon, bump pins, a speed-adaptive follow camera, heading-up mode, graticule, scale bar, cursor coordinates and reverse-geocoded place names.
- Animated cyclist with pedalling, wheel spin, rough-road shake, bump jolt, foot-down stop, scrolling road surface and parallax skyline, with small multiples for other bikes.
- Live readouts, class probabilities, ride summary with a configurable comfort score, elevation profile when altitude is present.
- Ride timeline with vibration trace, probability bands, condition strip, hover link to the map and scrubbed replay.
- Area report per street, worst first, with map highlight, and an aggregated hex quality layer across rides.
- System pipeline view with animated packets and live numbers per stage.
- Settings drawer with export, import and reset; defaults in `public/config.json`.
- Light and dark themes, presentation mode, keyboard shortcuts, opening sequence, reduced-motion support.
- Raw IMU signal viewer for Edge Impulse CSV exports.
- Exports: `.jsonl`, GeoJSON, CSV and PNG snapshot.
- Raspberry Pi publisher with dummy mode, offline queue, status messages, GPS bridge and an Edge Impulse hook example.
- GitHub Actions for CI and GitHub Pages.
