#!/usr/bin/env python3
"""Optional GPS bridge: publish position fixes from the Pi instead of a phone.

The normal setup uses the OwnTracks app on the phone, which publishes its
own location to the broker and needs nothing on the Pi. Use this script
only when a GPS receiver is attached to the Pi, either through gpsd or as a
serial NMEA device (USB or UART dongle).

    python3 gps_bridge.py --gpsd                       # gpsd on localhost:2947
    python3 gps_bridge.py --serial /dev/ttyACM0 --baud 9600

Fixes are published at most once per second to ``{prefix}/{device}/gps``
through ``RoadPublisher.send_gps``. Broker settings come from the same
command line options and ROAD_MQTT_* environment variables as publisher.py.

The serial path uses a small hand-written NMEA parser (RMC for position,
speed and course; GGA for fix quality and HDOP) so no extra packages are
needed beyond pyserial.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
import time
from typing import Dict, Iterator, Optional

from publisher import RoadPublisher

LOG = logging.getLogger("road.gps")

KNOTS_TO_KMH = 1.852
MIN_PUBLISH_INTERVAL_S = 1.0


# ----------------------------------------------------------------------- gpsd


def gpsd_fixes(host: str, port: int) -> Iterator[Dict]:
    """Yield fix dicts from gpsd's JSON stream (TPV reports only).

    gpsd speaks a simple line protocol: after sending the WATCH command it
    streams one JSON object per line. Only TPV (time-position-velocity)
    reports with a 2D or 3D fix are passed on.
    """
    while True:
        try:
            with socket.create_connection((host, port), timeout=10) as sock:
                sock.sendall(b'?WATCH={"enable":true,"json":true}\n')
                reader = sock.makefile("r", encoding="utf-8", errors="replace")
                for line in reader:
                    try:
                        report = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if report.get("class") != "TPV" or report.get("mode", 0) < 2:
                        continue
                    if "lat" not in report or "lon" not in report:
                        continue
                    fix = {"lat": report["lat"], "lon": report["lon"]}
                    if "speed" in report:  # gpsd reports m/s
                        fix["speed"] = report["speed"] * 3.6
                    if "track" in report:
                        fix["heading"] = report["track"]
                    if "eph" in report:  # estimated horizontal error, metres
                        fix["acc"] = report["eph"]
                    yield fix
        except OSError as exc:
            LOG.warning("gpsd connection failed (%s), retrying in 5 s", exc)
            time.sleep(5)


# --------------------------------------------------------------------- serial


def nmea_checksum_ok(sentence: str) -> bool:
    if not sentence.startswith("$") or "*" not in sentence:
        return False
    body, _, given = sentence[1:].partition("*")
    calc = 0
    for ch in body:
        calc ^= ord(ch)
    try:
        return calc == int(given[:2], 16)
    except ValueError:
        return False


def nmea_to_degrees(value: str, hemisphere: str) -> Optional[float]:
    """Convert ddmm.mmmm / dddmm.mmmm plus N/S/E/W to signed decimal degrees."""
    if not value or not hemisphere:
        return None
    try:
        raw = float(value)
    except ValueError:
        return None
    degrees = int(raw // 100)
    minutes = raw - degrees * 100
    result = degrees + minutes / 60.0
    if hemisphere in ("S", "W"):
        result = -result
    return result


def parse_nmea(sentence: str, state: Dict) -> bool:
    """Update ``state`` from one RMC or GGA sentence. Returns True on new RMC."""
    sentence = sentence.strip()
    if not nmea_checksum_ok(sentence):
        return False
    fields = sentence[1:].split("*")[0].split(",")
    kind = fields[0][2:]  # strip the talker id (GP, GN, GL, ...)

    if kind == "RMC" and len(fields) >= 9:
        # $GxRMC,time,status,lat,N/S,lon,E/W,speed(knots),course,date,...
        if fields[2] != "A":
            return False
        lat = nmea_to_degrees(fields[3], fields[4])
        lon = nmea_to_degrees(fields[5], fields[6])
        if lat is None or lon is None:
            return False
        state["lat"] = lat
        state["lon"] = lon
        state["speed"] = float(fields[7]) * KNOTS_TO_KMH if fields[7] else None
        state["heading"] = float(fields[8]) if fields[8] else None
        return True

    if kind == "GGA" and len(fields) >= 9:
        # $GxGGA,time,lat,N/S,lon,E/W,quality,sats,hdop,alt,...
        try:
            quality = int(fields[6] or 0)
            hdop = float(fields[8]) if fields[8] else None
        except ValueError:
            return False
        state["fix"] = quality > 0
        # Rough accuracy estimate: HDOP times a nominal 5 m ranging error.
        # Good enough for the dashboard's accuracy circle, not a real figure.
        state["acc"] = hdop * 5.0 if hdop is not None else None
        return False

    return False


def serial_fixes(port: str, baud: int) -> Iterator[Dict]:
    try:
        import serial  # pyserial, only needed for this mode
    except ImportError:
        sys.exit("pyserial is required for --serial: pip install pyserial")

    state: Dict = {}
    while True:
        try:
            with serial.Serial(port, baud, timeout=2) as dev:
                LOG.info("Reading NMEA from %s at %d baud", port, baud)
                while True:
                    raw = dev.readline()
                    if not raw:
                        continue
                    line = raw.decode("ascii", errors="replace")
                    if parse_nmea(line, state) and state.get("fix", True):
                        yield {k: state.get(k) for k in ("lat", "lon", "speed", "heading", "acc")}
        except (OSError, serial.SerialException) as exc:
            LOG.warning("Serial device failed (%s), retrying in 5 s", exc)
            time.sleep(5)


# ------------------------------------------------------------------------ CLI


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Publish GPS fixes from gpsd or a serial NMEA receiver.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--gpsd", action="store_true", help="read from gpsd")
    source.add_argument("--serial", metavar="PORT", help="read NMEA from a serial device, e.g. /dev/ttyACM0")
    parser.add_argument("--baud", type=int, default=9600, help="serial baud rate")
    parser.add_argument("--gpsd-host", default="localhost")
    parser.add_argument("--gpsd-port", type=int, default=2947)
    parser.add_argument("--host", default=os.environ.get("ROAD_MQTT_HOST"), help="broker host, e.g. {{BROKER_HOST}}")
    parser.add_argument("--port", type=int, default=None, help="broker port (8883, or 1883 with --no-tls)")
    parser.add_argument("--user", default=os.environ.get("ROAD_MQTT_USER"))
    parser.add_argument("--password", default=os.environ.get("ROAD_MQTT_PASSWORD"))
    parser.add_argument("--device", default=os.environ.get("ROAD_DEVICE", "bike1"))
    parser.add_argument("--prefix", default=os.environ.get("ROAD_TOPIC_PREFIX", "road"))
    parser.add_argument("--no-tls", action="store_true")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not args.host:
        parser.error("no broker host given (use --host or ROAD_MQTT_HOST)")

    tls = not args.no_tls
    pub = RoadPublisher(
        host=args.host,
        port=args.port or (8883 if tls else 1883),
        username=args.user,
        password=args.password,
        device=args.device,
        topic_prefix=args.prefix,
        tls=tls,
        model_name=None,
    )
    fixes = gpsd_fixes(args.gpsd_host, args.gpsd_port) if args.gpsd else serial_fixes(args.serial, args.baud)

    last_sent = 0.0
    try:
        for fix in fixes:
            now = time.monotonic()
            if now - last_sent < MIN_PUBLISH_INTERVAL_S:
                continue
            last_sent = now
            message = pub.send_gps(fix["lat"], fix["lon"], speed=fix.get("speed"), acc=fix.get("acc"), heading=fix.get("heading"))
            if args.verbose:
                print(json.dumps(message))
    except KeyboardInterrupt:
        LOG.info("Stopping")
    finally:
        pub.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
