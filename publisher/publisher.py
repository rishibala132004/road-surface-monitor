#!/usr/bin/env python3
"""MQTT publisher for the road surface monitor (Raspberry Pi side).

Publishes classifier results, GPS fixes and periodic status messages to the
MQTT broker that the browser dashboard listens to. The classifier itself
(Edge Impulse, running on the Pi) is not part of this file; it calls
``RoadPublisher.send`` once per inference window. See
``examples/edge_impulse_hook.py`` for the integration point.

Run ``python3 publisher.py --help`` for the command line, or
``python3 publisher.py --dummy`` to publish a simulated ride for testing the
dashboard without the bicycle.

Topics (``{prefix}`` defaults to ``road``, ``{device}`` to ``bike1``):

    {prefix}/{device}/condition   one message per classified window (QoS 1)
    {prefix}/{device}/gps         position fixes (QoS 0)
    {prefix}/{device}/status      health message every 10 s (QoS 0)
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import math
import os
import random
import signal
import ssl
import sys
import threading
import time
from pathlib import Path
from typing import Deque, Dict, Iterable, List, Optional, Tuple

import paho.mqtt.client as mqtt

LOG = logging.getLogger("road.publisher")

DEFAULT_LABELS = ["smooth", "rough", "bump", "stopped"]
STATUS_PERIOD_S = 10.0
RATE_WINDOW_S = 30.0


def now_ms() -> int:
    """Current wall clock time in milliseconds since the epoch."""
    return int(time.time() * 1000)


def _round(value: Optional[float], digits: int) -> Optional[float]:
    if value is None:
        return None
    return round(float(value), digits)


def read_battery_percent() -> Optional[int]:
    """Battery level from the kernel power supply class, if any is present.

    A Pi powered from the mains has no battery entry, in which case None is
    returned and the field is left out of the status message. UPS HATs that
    register a battery appear here automatically.
    """
    base = Path("/sys/class/power_supply")
    if not base.is_dir():
        return None
    for supply in sorted(base.iterdir()):
        try:
            if (supply / "type").read_text().strip() != "Battery":
                continue
            return int((supply / "capacity").read_text().strip())
        except (OSError, ValueError):
            continue
    return None


class RoadPublisher:
    """Thread safe MQTT publisher with automatic reconnect and offline queue.

    Messages produced while the connection is down are kept in a bounded
    queue (oldest dropped first) and flushed in order when the client
    reconnects. Condition messages use QoS 1 so the broker acknowledges
    them; GPS and status messages use QoS 0 because the next one supersedes
    the previous one anyway.
    """

    def __init__(
        self,
        host: str,
        port: int = 8883,
        username: Optional[str] = None,
        password: Optional[str] = None,
        device: str = "bike1",
        topic_prefix: str = "road",
        tls: bool = True,
        model_name: Optional[str] = None,
        queue_size: int = 5000,
    ) -> None:
        self.device = device
        self.topic_prefix = topic_prefix.strip("/")
        self.model_name = model_name
        self.seq = 0
        self.connected = False

        self._lock = threading.Lock()
        self._queue: Deque[Tuple[str, str, int]] = collections.deque(maxlen=queue_size)
        self._send_times: Deque[float] = collections.deque()
        self._started = time.monotonic()
        self._stop = threading.Event()

        client_id = f"{self.topic_prefix}-{device}-{os.getpid()}"
        self._client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id,
            protocol=mqtt.MQTTv311,
            clean_session=True,
        )
        if username:
            self._client.username_pw_set(username, password)
        if tls:
            # System CA store; HiveMQ Cloud uses a Let's Encrypt certificate.
            self._client.tls_set(cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLS_CLIENT)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.reconnect_delay_set(min_delay=1, max_delay=30)

        # connect_async returns immediately; the network loop runs in its own
        # thread and keeps retrying until the broker is reachable.
        self._client.connect_async(host, port, keepalive=30)
        self._client.loop_start()

        self._status_thread = threading.Thread(target=self._status_loop, name="status", daemon=True)
        self._status_thread.start()

    # ------------------------------------------------------------------ topics

    def topic(self, suffix: str) -> str:
        return f"{self.topic_prefix}/{self.device}/{suffix}"

    # --------------------------------------------------------------- callbacks

    def _on_connect(self, client, userdata, flags, reason_code, properties) -> None:
        if reason_code != 0:
            LOG.error("Broker refused connection: %s", reason_code)
            return
        self.connected = True
        LOG.info("Connected to broker")
        self._flush_queue()

    def _on_disconnect(self, client, userdata, flags, reason_code, properties) -> None:
        self.connected = False
        if not self._stop.is_set():
            LOG.warning("Disconnected (%s), reconnecting in the background", reason_code)

    def _flush_queue(self) -> None:
        with self._lock:
            pending = list(self._queue)
            self._queue.clear()
        if pending:
            LOG.info("Flushing %d queued messages", len(pending))
        for index, (topic, payload, qos) in enumerate(pending):
            info = self._client.publish(topic, payload, qos=qos)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                # Connection dropped again; keep the remainder for next time.
                with self._lock:
                    self._queue.extendleft(reversed(pending[index:]))
                break

    # ----------------------------------------------------------------- publish

    def _publish(self, topic: str, message: dict, qos: int) -> None:
        payload = json.dumps(message, separators=(",", ":"))
        if self.connected:
            info = self._client.publish(topic, payload, qos=qos)
            if info.rc == mqtt.MQTT_ERR_SUCCESS:
                return
        with self._lock:
            self._queue.append((topic, payload, qos))

    def send(
        self,
        label: str,
        confidence: Optional[float] = None,
        scores: Optional[Dict[str, float]] = None,
        vib: Optional[float] = None,
        inference_ms: Optional[float] = None,
        lat: Optional[float] = None,
        lon: Optional[float] = None,
    ) -> dict:
        """Publish one classified window and return the message that was sent.

        Only ``label`` is required. ``seq`` and ``ts`` are filled in here.
        ``lat``/``lon`` should only be given when the Pi has its own GPS;
        otherwise the dashboard joins conditions with the phone's GPS topic.
        """
        with self._lock:
            self.seq += 1
            seq = self.seq
            now = time.monotonic()
            self._send_times.append(now)
            while self._send_times and now - self._send_times[0] > RATE_WINDOW_S:
                self._send_times.popleft()

        message: dict = {"v": 1, "device": self.device, "label": label, "ts": now_ms(), "seq": seq}
        if confidence is not None:
            message["confidence"] = _round(confidence, 3)
        if scores:
            message["scores"] = {k: _round(v, 3) for k, v in scores.items()}
        if vib is not None:
            message["vib"] = _round(vib, 2)
        if inference_ms is not None:
            message["inference_ms"] = _round(inference_ms, 1)
        if lat is not None and lon is not None:
            message["lat"] = _round(lat, 6)
            message["lon"] = _round(lon, 6)

        self._publish(self.topic("condition"), message, qos=1)
        return message

    def send_gps(
        self,
        lat: float,
        lon: float,
        speed: Optional[float] = None,
        acc: Optional[float] = None,
        heading: Optional[float] = None,
    ) -> dict:
        """Publish a position fix. Speed in km/h, accuracy in metres."""
        message: dict = {"lat": _round(lat, 6), "lon": _round(lon, 6), "ts": now_ms()}
        if speed is not None:
            message["speed"] = _round(speed, 1)
        if acc is not None:
            message["acc"] = _round(acc, 1)
        if heading is not None:
            message["heading"] = _round(heading, 0)
        self._publish(self.topic("gps"), message, qos=0)
        return message

    def send_status(self, battery: Optional[int] = None, extra: Optional[dict] = None) -> dict:
        """Publish a health message. Called automatically every 10 s."""
        if battery is None:
            battery = read_battery_percent()
        with self._lock:
            times = list(self._send_times)
        rate_hz = None
        if len(times) >= 2:
            span = times[-1] - times[0]
            if span > 0:
                rate_hz = (len(times) - 1) / span

        message: dict = {"device": self.device, "uptime_s": int(time.monotonic() - self._started)}
        if battery is not None:
            message["battery"] = int(battery)
        if self.model_name:
            message["model"] = self.model_name
        if rate_hz is not None:
            message["rate_hz"] = _round(rate_hz, 2)
        if extra:
            message.update(extra)
        self._publish(self.topic("status"), message, qos=0)
        return message

    def _status_loop(self) -> None:
        while not self._stop.wait(STATUS_PERIOD_S):
            try:
                self.send_status()
            except Exception:  # keep the thread alive whatever happens
                LOG.exception("Status message failed")

    # ------------------------------------------------------------------- close

    def queued(self) -> int:
        """Number of messages waiting for the connection to come back."""
        with self._lock:
            return len(self._queue)

    def close(self, timeout: float = 3.0) -> None:
        """Flush what can be flushed, then disconnect cleanly."""
        self._stop.set()
        deadline = time.monotonic() + timeout
        while self.queued() and time.monotonic() < deadline:
            if self.connected:
                self._flush_queue()
            time.sleep(0.1)
        self._client.disconnect()
        self._client.loop_stop()


# ------------------------------------------------------------------ dummy ride


class DummyRide:
    """State machine producing a plausible ride for dashboard testing.

    Mostly smooth riding at 15 to 19 km/h, rough stretches of 20 to 60 s,
    isolated bumps (occasionally two in a row) and stops of 8 to 15 s. Each
    call to ``step`` advances by ``period`` seconds and returns the fields
    for one condition message, plus the current speed for the GPS track.
    """

    VIB = {
        "smooth": (0.5, 1.4),
        "rough": (2.4, 4.6),
        "bump": (6.8, 10.5),
        "stopped": (0.05, 0.2),
    }

    def __init__(self, labels: List[str], period: float, rng: random.Random) -> None:
        self.labels = labels
        self.period = period
        self.rng = rng
        self.state = "smooth"
        self.remaining = 0.0
        self.speed = rng.uniform(15.0, 19.0)
        self.pending_bumps = 0

    def _enter(self, state: str) -> None:
        self.state = state
        if state == "smooth":
            self.remaining = self.rng.uniform(30.0, 120.0)
        elif state == "rough":
            self.remaining = self.rng.uniform(20.0, 60.0)
        elif state == "stopped":
            self.remaining = self.rng.uniform(8.0, 15.0)
        else:
            self.remaining = self.period

    def _advance_state(self) -> None:
        if self.state == "bump" and self.pending_bumps > 0:
            self.pending_bumps -= 1
            self.remaining = self.period
            return
        if self.remaining > 0:
            return
        if self.state in ("bump", "stopped"):
            self._enter("smooth")
            return
        roll = self.rng.random()
        if roll < 0.08:
            self._enter("stopped")
        elif roll < 0.18:
            self.pending_bumps = 1 if self.rng.random() < 0.3 else 0
            self._enter("bump")
        elif self.state == "smooth":
            self._enter("rough")
        else:
            self._enter("smooth")

    def _update_speed(self) -> None:
        target = 0.0 if self.state == "stopped" else self.rng.uniform(15.0, 19.0)
        if self.state == "rough":
            target -= 2.0
        # First order approach so the speed does not jump between windows.
        self.speed += (target - self.speed) * min(1.0, 0.35 * self.period)
        if self.speed < 0.3:
            self.speed = 0.0

    def _scores(self, true_label: str) -> Tuple[str, float, Dict[str, float]]:
        mistaken = self.rng.random() < 0.04 and len(self.labels) > 1
        if mistaken:
            winner = self.rng.choice([l for l in self.labels if l != true_label])
            confidence = self.rng.uniform(0.35, 0.6)
        else:
            winner = true_label
            confidence = self.rng.uniform(0.72, 0.98)
        others = [l for l in self.labels if l != winner]
        weights = [self.rng.random() for _ in others]
        total = sum(weights) or 1.0
        rest = 1.0 - confidence
        scores = {winner: confidence}
        for name, w in zip(others, weights):
            scores[name] = rest * w / total
        return winner, confidence, scores

    def step(self) -> dict:
        self.remaining -= self.period
        self._advance_state()
        self._update_speed()
        true_label = self.state if self.state in self.labels else self.labels[0]
        label, confidence, scores = self._scores(true_label)
        lo, hi = self.VIB.get(true_label, (0.5, 1.4))
        return {
            "label": label,
            "confidence": confidence,
            "scores": scores,
            "vib": self.rng.uniform(lo, hi),
            "inference_ms": self.rng.uniform(3.0, 6.0),
            "speed": self.speed,
        }


class DummyTrack:
    """Moves back and forth along a short line in Enschede at the ride speed."""

    START = (52.2318, 6.8722)
    END = (52.2275, 6.8810)

    def __init__(self) -> None:
        self.progress = 0.0
        self.direction = 1
        lat0, lon0 = self.START
        lat1, lon1 = self.END
        dy = (lat1 - lat0) * 111_320.0
        dx = (lon1 - lon0) * 111_320.0 * math.cos(math.radians(lat0))
        self.length_m = math.hypot(dx, dy)
        self.heading_fwd = math.degrees(math.atan2(dx, dy)) % 360.0

    def advance(self, speed_kmh: float, dt: float) -> Tuple[float, float, float]:
        self.progress += self.direction * (speed_kmh / 3.6) * dt / self.length_m
        if self.progress >= 1.0 or self.progress <= 0.0:
            self.progress = min(1.0, max(0.0, self.progress))
            self.direction *= -1
        lat = self.START[0] + (self.END[0] - self.START[0]) * self.progress
        lon = self.START[1] + (self.END[1] - self.START[1]) * self.progress
        heading = self.heading_fwd if self.direction > 0 else (self.heading_fwd + 180.0) % 360.0
        return lat, lon, heading


def run_dummy(pub: RoadPublisher, labels: List[str], period: float, with_gps: bool, verbose: bool) -> None:
    rng = random.Random()
    ride = DummyRide(labels, period, rng)
    track = DummyTrack() if with_gps else None
    stop = threading.Event()

    def handle_signal(signum, frame) -> None:
        stop.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    LOG.info("Dummy ride started, %s messages every %.1f s (Ctrl-C to stop)", "/".join(labels), period)
    next_tick = time.monotonic()
    while not stop.is_set():
        window = ride.step()
        speed = window.pop("speed")
        message = pub.send(**window)
        if track is not None:
            lat, lon, heading = track.advance(speed, period)
            pub.send_gps(lat, lon, speed=speed, acc=rng.uniform(3.0, 8.0), heading=heading)

        if verbose:
            print(json.dumps(message))
        else:
            state = "online" if pub.connected else f"offline, {pub.queued()} queued"
            print(
                f"#{message['seq']:<6} {message['label']:<8} conf {message.get('confidence', 1):.2f}"
                f"  vib {message.get('vib', 0):>5.2f} m/s^2  speed {speed:>4.1f} km/h  [{state}]"
            )

        next_tick += period
        delay = next_tick - time.monotonic()
        if delay > 0:
            stop.wait(delay)
        else:
            next_tick = time.monotonic()

    LOG.info("Stopping, %d messages still queued", pub.queued())


# ------------------------------------------------------------------------- CLI


def parse_labels(text: str) -> List[str]:
    labels = [part.strip() for part in text.split(",") if part.strip()]
    return labels or list(DEFAULT_LABELS)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Publish road condition messages to the MQTT broker.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("ROAD_MQTT_HOST"),
        help="broker host name, e.g. {{BROKER_HOST}} (env ROAD_MQTT_HOST)",
    )
    parser.add_argument("--port", type=int, default=None, help="broker port (default 8883, or 1883 with --no-tls)")
    parser.add_argument("--user", default=os.environ.get("ROAD_MQTT_USER"), help="broker user name (env ROAD_MQTT_USER)")
    parser.add_argument(
        "--password",
        default=os.environ.get("ROAD_MQTT_PASSWORD"),
        help="broker password (env ROAD_MQTT_PASSWORD, preferred over the command line)",
    )
    parser.add_argument("--device", default=os.environ.get("ROAD_DEVICE", "bike1"), help="device id, e.g. {{BIKE_IDS}}")
    parser.add_argument("--prefix", default=os.environ.get("ROAD_TOPIC_PREFIX", "road"), help="topic prefix, e.g. {{TOPIC_PREFIX}}")
    parser.add_argument("--no-tls", action="store_true", help="plain TCP, for a local Mosquitto on port 1883")
    parser.add_argument("--model", default=None, help="model name reported in status messages, e.g. road-v3")
    parser.add_argument("--dummy", action="store_true", help="publish a simulated ride instead of waiting for a caller")
    parser.add_argument("--period", type=float, default=1.0, help="seconds between dummy messages")
    parser.add_argument("--labels", default=",".join(DEFAULT_LABELS), help="comma separated label list ({{LABELS}})")
    parser.add_argument("--with-gps", action="store_true", help="dummy mode also publishes a fake GPS track in Enschede")
    parser.add_argument("--verbose", "-v", action="store_true", help="print every message as JSON")
    return parser


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    if not args.host:
        print("error: no broker host given (use --host or ROAD_MQTT_HOST)", file=sys.stderr)
        return 2
    if not args.dummy:
        print("Nothing to do: this script publishes a simulated ride with --dummy; the classifier", file=sys.stderr)
        print("imports RoadPublisher instead (see examples/edge_impulse_hook.py).", file=sys.stderr)
        return 2

    tls = not args.no_tls
    port = args.port if args.port else (8883 if tls else 1883)
    labels = parse_labels(args.labels)

    pub = RoadPublisher(
        host=args.host,
        port=port,
        username=args.user,
        password=args.password,
        device=args.device,
        topic_prefix=args.prefix,
        tls=tls,
        model_name=args.model or "dummy",
    )
    try:
        run_dummy(pub, labels, max(0.1, args.period), args.with_gps, args.verbose)
    finally:
        pub.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
