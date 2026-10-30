# Raspberry Pi publisher

Python side of the road surface monitor. `publisher.py` sends classifier
results, GPS fixes and status messages to the MQTT broker; the browser
dashboard in the repository root subscribes to them.

Files:

| File | Purpose |
| --- | --- |
| `publisher.py` | `RoadPublisher` class (reconnect, offline queue, status thread) and a `--dummy` ride generator |
| `examples/edge_impulse_hook.py` | Where to call the publisher inside the Edge Impulse Linux SDK loop |
| `gps_bridge.py` | Optional: publish GPS from gpsd or a serial NMEA receiver when OwnTracks is not used |
| `requirements.txt` | `paho-mqtt` 2.x |

## Install

Python 3.10 or newer (Raspberry Pi OS Bookworm ships 3.11).

```sh
cd publisher
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Dummy run against HiveMQ Cloud

HiveMQ Cloud only accepts TLS on port 8883 (MQTT) and 8884 (WebSocket). The
publisher uses 8883 and the system CA store by default.

```sh
export ROAD_MQTT_HOST={{BROKER_HOST}}
export ROAD_MQTT_USER=pi
export ROAD_MQTT_PASSWORD='...'
python3 publisher.py --dummy --with-gps
```

`--with-gps` also publishes a fake track along a short line in Enschede so
the dashboard shows a moving bicycle without a phone. Add `--verbose` to
print every message as JSON, `--period 0.5` to send twice per second,
`--device bike2` for a second bicycle. Stop with Ctrl-C.

## Dummy run against a local Mosquitto

```sh
mosquitto -v                     # in another terminal, default port 1883
python3 publisher.py --host localhost --no-tls --dummy
```

The dashboard needs WebSockets; add `listener 9001` and `protocol websockets`
to `mosquitto.conf` and connect the dashboard to `ws://localhost:9001`.

## Environment variables

| Variable | Option | Default |
| --- | --- | --- |
| `ROAD_MQTT_HOST` | `--host` | none (required) |
| `ROAD_MQTT_USER` | `--user` | none |
| `ROAD_MQTT_PASSWORD` | `--password` | none |
| `ROAD_DEVICE` | `--device` | `bike1` ({{BIKE_IDS}}) |
| `ROAD_TOPIC_PREFIX` | `--prefix` | `road` ({{TOPIC_PREFIX}}) |

Use the environment variables (or the `EnvironmentFile` below) for the
password so that it does not show up in `ps` output or shell history.

## Hooking into the Edge Impulse script

`examples/edge_impulse_hook.py` is a complete loop around
`edge_impulse_linux.runner.ImpulseRunner`. The only function to replace is
`read_imu_window()`, which must return the Thingy:52 accelerometer window
as a list of `(ax, ay, az)` tuples in m/s^2 at the model's sample rate.

The essential part, for an existing script:

```python
from publisher import RoadPublisher

pub = RoadPublisher(host, username=user, password=password, device="bike1", model_name="road-v3")
scores = res["result"]["classification"]          # label -> probability
label = max(scores, key=scores.get)
pub.send(label, confidence=scores[label], scores=scores, vib=vibration_rms(samples), inference_ms=ms)
pub.close()                                        # in a finally block
```

`send` fills in `ts` (milliseconds) and an incrementing `seq`, publishes with
QoS 1 so the broker acknowledges the message, and queues it if the
connection is down (up to 5000 messages, flushed in order on reconnect). A
status message with uptime, measured send rate, model name and battery
level (if a battery is registered under `/sys/class/power_supply`) goes out
every 10 s on its own thread.

Labels: the dashboard knows `{{LABELS}}` plus some aliases (see
`public/config.json`). If the model uses other names, rename them in
`LABEL_ALIASES` in the example script.

## Running on boot (systemd)

`/etc/road-publisher.env` (mode 600, owned by root):

```
ROAD_MQTT_HOST={{BROKER_HOST}}
ROAD_MQTT_USER=pi
ROAD_MQTT_PASSWORD=...
ROAD_DEVICE=bike1
ROAD_TOPIC_PREFIX={{TOPIC_PREFIX}}
```

`/etc/systemd/system/road-publisher.service`:

```ini
[Unit]
Description=Road surface classifier and MQTT publisher
After=network-online.target bluetooth.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/rsm/publisher
EnvironmentFile=/etc/road-publisher.env
ExecStart=/home/pi/rsm/publisher/.venv/bin/python3 examples/edge_impulse_hook.py /home/pi/modelfile.eim
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now road-publisher
journalctl -u road-publisher -f
```

Swap the `ExecStart` for `publisher.py --dummy --with-gps` to have a demo
feed start on boot.

## GPS bridge (optional)

Skip this if the phone runs OwnTracks; the dashboard already reads
`owntracks/#`. With a receiver on the Pi:

```sh
python3 gps_bridge.py --gpsd                        # gpsd on localhost:2947
python3 gps_bridge.py --serial /dev/ttyACM0 --baud 9600   # needs pip install pyserial
```

Fixes go to `{prefix}/{device}/gps` at most once per second with speed in
km/h, heading from the RMC course and an accuracy estimate of HDOP x 5 m
(gpsd supplies `eph` directly). Broker options and environment variables are
the same as for `publisher.py`.

## Troubleshooting

- **Connection refused or hangs on port 8883**: check the host name in the
  HiveMQ Cloud console. Port 8884 is the WebSocket port and is for the
  dashboard, not for this script. Port 1883 is only for a local broker
  with `--no-tls`.
- **`ssl.SSLCertVerificationError`**: the Pi's CA store is out of date.
  Run `sudo apt update && sudo apt install --reinstall ca-certificates`.
  Do not disable certificate checking.
- **`Broker refused connection: Not authorized`**: wrong user name or
  password, or the HiveMQ credential lacks publish permission on
  `road/#`. Create the credential under Access Management with publish and
  subscribe rights.
- **Dashboard shows the label as "unknown"**: the label string does not
  match the dashboard's class list or alias table. Either add the name to
  `aliases` in `public/config.json` or map it in `LABEL_ALIASES` in the
  hook script. The dashboard matches labels case-insensitively, but the `LABEL_ALIASES` map in the hook script is case sensitive.
- **Points appear at the wrong time or are dropped as stale**: the Pi's
  clock is wrong, so `ts` is wrong. The Pi has no battery backed clock and
  only syncs over the network. Check with `timedatectl`; make sure the
  phone hotspot is up before the publisher starts, or run
  `sudo systemctl restart systemd-timesyncd` once online. Messages with a
  `ts` more than a few minutes off are hard to join with the GPS track.
- **Messages queue up ("offline, N queued")**: the hotspot dropped. The
  publisher reconnects by itself and flushes the queue in order; nothing
  needs restarting.
- **No `rate_hz` in status**: fewer than two `send` calls in the last 30 s,
  which is normal right after start.
