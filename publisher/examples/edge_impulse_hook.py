#!/usr/bin/env python3
"""Example: run the Edge Impulse model on the Pi and publish each result.

This shows exactly where ``RoadPublisher.send`` fits inside an Edge Impulse
Linux SDK classification loop. The only part the team has to replace is
``read_imu_window``, which must return the accelerometer samples coming from
the Thingy:52 over BLE.

Requirements on the Pi:

    pip install edge-impulse-linux paho-mqtt
    edge-impulse-linux-runner --download modelfile.eim   # exports the model

Run:

    export ROAD_MQTT_HOST={{BROKER_HOST}} ROAD_MQTT_USER=... ROAD_MQTT_PASSWORD=...
    python3 edge_impulse_hook.py modelfile.eim --device bike1
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time
from typing import List, Sequence, Tuple

from edge_impulse_linux.runner import ImpulseRunner

# publisher.py lives one directory up from this example.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from publisher import RoadPublisher  # noqa: E402

Sample = Tuple[float, float, float]

# The dashboard maps common alternative names (good, cobbles, pothole, idle)
# onto the four standard labels through its config.json "aliases" table. If
# the model was trained with labels that are not in that table, rename them
# here so the dashboard does not show them as "unknown".
LABEL_ALIASES = {
    # "asphalt": "smooth",
}


# ---------------------------------------------------------------------------
# TEAM CODE: Thingy:52 sampling over BLE
# ---------------------------------------------------------------------------
def read_imu_window(sample_count: int, frequency_hz: float) -> List[Sample]:
    """Return one window of accelerometer samples from the Thingy:52.

    Must return exactly ``sample_count`` tuples ``(ax, ay, az)`` in m/s^2,
    sampled at ``frequency_hz`` (the rate the model was trained at, read
    from the model parameters below). Blocking until the window is full is
    fine; the loop below simply runs once per window.

    Replace the body with the BLE notification handler (for example using
    bleak) that collects the Thingy:52 motion characteristic into a list.
    This placeholder returns a still sensor so the script can be started
    without the bicycle.
    """
    time.sleep(sample_count / frequency_hz)
    return [(0.0, 0.0, 9.81)] * sample_count


# ---------------------------------------------------------------------------


def vibration_rms(samples: Sequence[Sample]) -> float:
    """Vibration intensity of one window in m/s^2, gravity removed.

    Takes the magnitude |a| of every sample, subtracts the mean magnitude of
    the window (which is gravity plus any slow component) and returns the
    RMS of what is left. This is cheap and orientation independent. A
    high-pass filter (for example a first order filter at 0.5 Hz) on each
    axis would also remove gravity and preserves more of the low frequency
    content; either approach works for the dashboard's "vib" field as long
    as it is used consistently.
    """
    if not samples:
        return 0.0
    magnitudes = [math.sqrt(ax * ax + ay * ay + az * az) for ax, ay, az in samples]
    mean = sum(magnitudes) / len(magnitudes)
    return math.sqrt(sum((m - mean) ** 2 for m in magnitudes) / len(magnitudes))


def flatten(samples: Sequence[Sample]) -> List[float]:
    """Interleave the axes the way the Edge Impulse model expects.

    Edge Impulse stores time series as accX, accY, accZ, accX, accY, accZ,
    ... in the order the axes appear in the project's data acquisition
    settings. If gyroscope axes were added during training, append them to
    each sample in the same order here.
    """
    features: List[float] = []
    for ax, ay, az in samples:
        features.extend((ax, ay, az))
    return features


def main() -> int:
    parser = argparse.ArgumentParser(description="Classify Thingy:52 IMU windows and publish the results.")
    parser.add_argument("model", help="path to the exported .eim model file")
    parser.add_argument("--host", default=os.environ.get("ROAD_MQTT_HOST"), help="broker host (env ROAD_MQTT_HOST)")
    parser.add_argument("--port", type=int, default=8883)
    parser.add_argument("--user", default=os.environ.get("ROAD_MQTT_USER"))
    parser.add_argument("--password", default=os.environ.get("ROAD_MQTT_PASSWORD"))
    parser.add_argument("--device", default="bike1")
    parser.add_argument("--prefix", default="road")
    parser.add_argument("--no-tls", action="store_true")
    args = parser.parse_args()
    if not args.host:
        parser.error("no broker host given (use --host or ROAD_MQTT_HOST)")

    runner = ImpulseRunner(args.model)
    model_info = runner.init()
    params = model_info["model_parameters"]
    frequency_hz = float(params["frequency"])
    feature_count = int(params["input_features_count"])
    axis_count = int(params.get("axis_count", 3))
    sample_count = feature_count // axis_count
    labels = list(params.get("labels", []))
    model_name = model_info.get("project", {}).get("name", "edge-impulse")
    print(f"Model '{model_name}': {sample_count} samples x {axis_count} axes at {frequency_hz:g} Hz, labels {labels}")

    publisher = RoadPublisher(
        host=args.host,
        port=args.port if not args.no_tls else 1883,
        username=args.user,
        password=args.password,
        device=args.device,
        topic_prefix=args.prefix,
        tls=not args.no_tls,
        model_name=model_name,
    )

    try:
        while True:
            samples = read_imu_window(sample_count, frequency_hz)
            if len(samples) != sample_count:
                print(f"Skipping window: got {len(samples)} samples, expected {sample_count}")
                continue

            features = flatten(samples)
            res = runner.classify(features)

            # Classification result: dict of label -> probability (0..1).
            scores = res["result"]["classification"]
            label = max(scores, key=scores.get)
            label = LABEL_ALIASES.get(label, label)
            scores = {LABEL_ALIASES.get(k, k): v for k, v in scores.items()}

            timing = res.get("timing", {})
            inference_ms = timing.get("classification", 0) + timing.get("dsp", 0)

            # ---- this is the publish call the rest of the system depends on
            message = publisher.send(
                label=label,
                confidence=scores[label],
                scores=scores,
                vib=vibration_rms(samples),
                inference_ms=inference_ms,
            )
            print(f"#{message['seq']} {label} {scores[label]:.2f} vib {message.get('vib', 0):.2f} m/s^2")
    except KeyboardInterrupt:
        print("Stopping")
    finally:
        publisher.close()
        runner.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
