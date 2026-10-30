# Data contract

This document describes every message the dashboard understands, how tolerant the parser is, how conditions are joined to GPS fixes, how the derived counters are computed, and the formats the dashboard reads and writes. The implementation is `src/data/contract.ts` (parsing), `src/data/join.ts` (GPS join), `src/data/store.ts` (counters) and `src/components/exports.ts` (exports). The unit tests in `tests/contract.test.ts`, `tests/join.test.ts` and `tests/store.test.ts` exercise the rules below.

All three data sources (simulation, MQTT, replay) produce raw `(topic, payload)` pairs that go through the same `parseMessage` function, so the simulator is held to the same contract as the Raspberry Pi.

## Topics

The topic prefix defaults to `road` and is set in `public/config.json` (`broker.topicPrefix`) and on the Pi with `--prefix` or `ROAD_TOPIC_PREFIX`.

| Topic                               | Direction          | Content                                   | QoS from the Pi |
| ----------------------------------- | ------------------ | ----------------------------------------- | --------------- |
| `{{TOPIC_PREFIX}}/<bike>/condition` | Pi to dashboard    | One classified window                     | 1               |
| `{{TOPIC_PREFIX}}/<bike>/gps`       | Pi to dashboard    | A position fix (only when the Pi has GPS) | 0               |
| `{{TOPIC_PREFIX}}/<bike>/status`    | Pi to dashboard    | Health message every 10 s                 | 0               |
| `owntracks/<user>/<device>`         | Phone to dashboard | OwnTracks location report                 | set by the app  |

`<bike>` is the device id, for example `bike1`. It may contain further slashes; everything between the prefix and the last segment is taken as the device. The dashboard subscribes to `<prefix>/+/+`, `<prefix>/+/+/+` and the filters in `broker.extraTopics` (default `owntracks/#`), unless the Source drawer specifies its own list.

Topic suffixes are recognised case-insensitively, with a few alternatives:

| Suffix                                  | Treated as |
| --------------------------------------- | ---------- |
| `condition`, `result`, `label`, `class` | condition  |
| `gps`, `location`, `position`           | gps        |
| `status`                                | status     |

A payload on a topic that is not recognised at all is classified by content: a `label`, `class` or `prediction` field makes it a condition; otherwise `lat` or `latitude` makes it a GPS fix; otherwise `battery`, `uptime_s` or `model` makes it a status message. Anything else is dropped.

## Condition payload

Full example, as sent by `publisher.py` and by the simulator:

```json
{
  "v": 1,
  "device": "bike1",
  "label": "rough",
  "confidence": 0.91,
  "ts": 1793290000000,
  "scores": { "smooth": 0.05, "rough": 0.91, "bump": 0.03, "stopped": 0.01 },
  "vib": 3.2,
  "inference_ms": 4.1,
  "seq": 1532,
  "lat": 52.2318,
  "lon": 6.8722
}
```

Minimal example that is still accepted (device from the topic, confidence defaults to 1, timestamp defaults to the time of receipt):

```json
{ "label": "smooth" }
```

| Field          | Type             | Unit                          | Required | Default or note                                                     |
| -------------- | ---------------- | ----------------------------- | -------- | ------------------------------------------------------------------- |
| `label`        | string           |                               | yes      | Class name; see label matching below                                |
| `ts`           | number           | ms or s since epoch           | no       | Receipt time when missing                                           |
| `confidence`   | number or string | 0 to 1, 0 to 100, "87%"       | no       | 1 when missing                                                      |
| `scores`       | object           | per class, 0 to 1 or 0 to 100 | no       | Omitted when missing; probability bars then show `--`               |
| `vib`          | number           | m/s^2 RMS, gravity removed    | no       | Falls back to the class `vibLevel` from config, shown as "est."     |
| `inference_ms` | number           | ms                            | no       | Shown as "Model run time"                                           |
| `seq`          | number           | counter                       | no       | Rounded to an integer; drives the lost-message counter              |
| `lat`, `lon`   | number           | degrees                       | no       | Only when the Pi has its own GPS; otherwise the phone track is used |
| `device`       | string           |                               | no       | Falls back to the topic, then to `broker.owntracksDefaultBike`      |
| `v`            | number           |                               | no       | Ignored (contract version marker)                                   |

Negative `vib` values are clamped to 0. A `lat`/`lon` pair is only used when both are present, within range, and not exactly `0, 0`.

## GPS payload

Sent on `<prefix>/<bike>/gps` by `publisher.send_gps` or `gps_bridge.py`:

```json
{ "lat": 52.2393, "lon": 6.856, "ts": 1793290000000, "speed": 16.4, "acc": 4.5, "heading": 131 }
```

| Field     | Type   | Unit                | Required | Note                                         |
| --------- | ------ | ------------------- | -------- | -------------------------------------------- |
| `lat`     | number | degrees             | yes      |                                              |
| `lon`     | number | degrees             | yes      |                                              |
| `ts`      | number | ms or s             | no       | Receipt time when missing                    |
| `speed`   | number | km/h                | no       | Clamped to 0 or more                         |
| `acc`     | number | metres (horizontal) | no       | Values above 15 m show as poor GPS           |
| `heading` | number | degrees from north  | no       | Negative values dropped, wrapped to 0 to 359 |
| `alt`     | number | metres              | no       | Enables the elevation profile                |

A fix without a usable position is dropped.

## OwnTracks payload

The phone publishes to `owntracks/<user>/<device>`. Only messages with `"_type": "location"` are used; `lwt`, `transition`, `waypoint` and other types are ignored.

```json
{
  "_type": "location",
  "lat": 52.2339,
  "lon": 6.8604,
  "tst": 1793290000,
  "vel": 17,
  "acc": 5,
  "cog": 128,
  "alt": 41,
  "batt": 83,
  "tid": "ab"
}
```

Fields used: `lat`, `lon`, `tst` (seconds), `vel` (km/h), `acc` (metres), `cog` (heading in degrees), `alt` (metres). Everything else is ignored. The fix is assigned to a bike by looking up `<user>/<device>` (or `owntracks/<user>/<device>`) in `broker.owntracksMap`; phones that are not listed go to `broker.owntracksDefaultBike` (default `bike1`).

## Status payload

Sent every 10 s by the publisher's status thread:

```json
{
  "device": "bike1",
  "battery": 83,
  "model": "road-v3",
  "rate_hz": 1.0,
  "uptime_s": 1260,
  "ts": 1793290000000
}
```

| Field      | Type   | Note                                                                |
| ---------- | ------ | ------------------------------------------------------------------- |
| `battery`  | number | Percent; the publisher reads `/sys/class/power_supply` when present |
| `model`    | string | Model name shown in the pipeline view                               |
| `rate_hz`  | number | Measured send rate over the last 30 s                               |
| `uptime_s` | number | Seconds since the publisher started                                 |
| `ts`       | number | Receipt time when missing                                           |

All fields are optional. The status is kept per device and replaces the previous one.

## Tolerance rules

The parser is deliberately forgiving so that a change on the Pi side does not blank the dashboard.

- Unknown fields are ignored. Missing optional fields are handled as in the tables above. A payload that is not a JSON object is dropped.
- Timestamps may be in seconds or milliseconds. Values below `1e11` are treated as seconds and multiplied by 1000 (anything below that cannot be a sensible millisecond timestamp). Zero, negative and non-numeric values fall back to the receipt time. Numeric strings are accepted.
- Confidence may be `0..1`, `0..100` or a string such as `"87%"`. Any value above 1 is divided by 100, then clamped to 0 to 1. Note that a bare value of exactly `1` is read as 100%, not 1%.
- Labels are trimmed and lower-cased, then matched in this order: an exact class id; the alias table (`aliases` in `config.json`, editable in the settings drawer); a loose prefix match after removing non-letters, so `"Rough road"` becomes `rough` and `"BUMP_1"` becomes `bump`; finally the same prefix match against the alias keys.
- Unknown labels are kept, not dropped. The message carries `known: false`, the condition panel shows the raw label with a hint to add an alias, and the sample is drawn in the "unknown" colour.
- `scores` keys go through the same label mapping, so `{"Cobbles": 91}` becomes `{"rough": 0.91}`. If the largest value is above 1 the whole object is divided by 100. Non-numeric values are skipped; an empty result is treated as no scores.
- The device id comes from the payload (`device`, `id` or `bike`) if present, otherwise from the topic, otherwise from `owntracksDefaultBike`.
- Binary payloads (`Uint8Array`) are decoded as UTF-8 before parsing.

Alternative field names, tried in the order given:

| Meaning        | Accepted names                                     |
| -------------- | -------------------------------------------------- |
| latitude       | `lat`, `latitude`                                  |
| longitude      | `lon`, `lng`, `longitude`                          |
| timestamp      | `ts`, `timestamp`, `time` (OwnTracks: `tst` first) |
| confidence     | `confidence`, `conf`, `probability`, `score`       |
| scores         | `scores`, `classification`, `probabilities`        |
| vibration      | `vib`, `vibration`, `rms`                          |
| inference time | `inference_ms`, `inferenceMs`, `latency_ms`        |
| sequence       | `seq`, `sequence`, `count`                         |
| speed          | `speed`, `vel`, `speed_kmh`                        |
| accuracy       | `acc`, `accuracy`, `hdop`                          |
| heading        | `heading`, `cog`, `bearing`, `course`              |
| altitude       | `alt`, `altitude`, `ele`                           |
| battery        | `battery`, `batt`                                  |
| model          | `model`, `model_name`                              |
| rate           | `rate_hz`, `rate`                                  |
| uptime         | `uptime_s`, `uptime`                               |
| label          | `label`, `class`, `prediction`                     |
| device         | `device`, `id`, `bike`                             |

## Joining conditions to GPS

Conditions come from the Pi and positions from the phone, so they arrive separately and are joined by time in `GpsBuffer.locate` (`src/data/join.ts`). The window is `joinWindowMs` (default 3000 ms, settings drawer "GPS join window").

1. For a condition at time `t`, find the fixes immediately before and after `t`.
2. If both exist, both are within the window of `t`, and the gap between them is at most 4 x window (12 s by default), interpolate position, speed, heading and altitude linearly between them. Accuracy is the worse of the two. The result is marked `interpolated`.
3. Otherwise take the nearest of the two fixes if it is within the window. The result carries `ageMs`, the time difference used.
4. Otherwise the condition has no position. It still feeds the readouts, counters and timeline but is not drawn on the map.

Late fixes: when a GPS fix arrives, conditions already stored whose timestamp is at most 2 x window older than the fix are re-joined if they had no position yet. A condition that carries its own `lat`/`lon` keeps that position and only borrows speed and heading from the nearest fix.

The GPS buffer holds at most 20 000 fixes per bike and inserts out-of-order fixes in sorted position.

## Derived counters

All counters live in `RideStore` (`src/data/store.ts`).

- **Lost messages**: when a condition carries `seq`, a gap `seq - lastSeq - 1 > 0` is added to the lost counter, but only when the gap is smaller than 10 000 (a publisher restart with a new counter does not count as thousands of lost messages).
- **Bump events**: consecutive `bump` windows within 2.5 s of each other are merged into one event. The "Bumps" summary, the bump pins and bumps per km count events, not windows.
- **Stops**: a run of `stopped` windows lasting at least 3 s counts as one stop. Moving time excludes stopped windows; gaps between samples are capped at 3 s so a dropout does not inflate the clock.
- **Distance**: summed from the GPS track with jitter suppression (steps at a speed below 2 km/h, steps under 4 m with no speed, and steps faster than 25 m/s are ignored).
- **Comfort score**: `100 x (smoothWeight x smooth + roughWeight x rough) / (smooth + rough + bump) - bumpPenaltyPerKm x bumps per km`, over window counts, stops excluded, clamped to 0 to 100. Defaults: 1, 0.5 and 3.
- **Message rate**: condition messages received in the last 10 s divided by 10.
- **Latency**: `receivedAt - ts` of the last condition, in milliseconds, meaningful for live data only.
- Samples are capped at 20 000 per bike; the oldest are dropped.

## Recorded log format (.jsonl)

The dashboard records every raw message it ingests (up to 200 000, oldest dropped). The export writes one JSON object per line:

```json
{
  "t": 1793290000123,
  "topic": "road/bike1/condition",
  "payload": "{\"label\":\"rough\",\"confidence\":0.91,\"ts\":1793290000000}"
}
```

- `t`: receipt time in milliseconds.
- `topic`: the MQTT topic as received.
- `payload`: the payload as a string, exactly as received.

The replayer (`parseJsonl` in `src/data/sources/ReplaySource.ts`) is more lenient than the writer: `payload` may also be a JSON object (it is re-serialised), `receivedAt` is accepted instead of `t`, and when neither exists `t` is derived from the payload's `ts` or `tst` (seconds or milliseconds). Lines with no `t` at all are placed one second after the previous line. Malformed lines and lines without a topic are skipped, and the records are sorted by `t` before playback. Timestamps inside the payloads are left as recorded, so a replayed ride appears at its original time.

`public/samples/demo-ride.jsonl` is a 1500 s simulated ride in this format, written by `tools/make-demo-ride.mjs`.

## Export formats

**GeoJSON** (`ride-<stamp>.geojson`): a `FeatureCollection` with

- one `LineString` per run of equal condition, properties `device`, `slot`, `label`, `low` (1 below the confidence threshold), `t0`, `t1`, `kind: "segment"`, `name`, and when a class colour override is set, `stroke` and `stroke-width`;
- one `Point` per bump event with a position, properties `device`, `slot`, `ts`, `confidence`, `low`, `vib`, `kind: "bump"`, `marker-symbol: "triangle"` and, when set, `marker-color`.

Positions in the ribbon are smoothed with a three-point average; the CSV keeps the raw joined positions.

**CSV** (`ride-<stamp>.csv`): one row per condition sample for every bike, columns

```
device, ts, iso_time, label, raw_label, confidence, vib_ms2, inference_ms, seq,
lat, lon, speed_kmh, gps_acc_m, distance_m, p_<class> for each configured class
```

`vib_ms2` is empty when the message carried no measurement (the estimated class level is not exported). `raw_label` is JSON-quoted.

**Log** (`ride-<stamp>.jsonl`): see above.

**Map snapshot** (`map-<stamp>.png`): the current map view with the bike markers and a legend.
