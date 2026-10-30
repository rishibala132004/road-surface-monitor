# Placeholders

Values in `{{DOUBLE_BRACES}}` are filled in by the team. Each row says where the value lives and what to put there. Search the tree for `{{` to find every occurrence.

| Placeholder           | Where it lives                                                                                | What to fill in                                                                                                                  | Default if left                          |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `{{PROJECT_TITLE}}`   | `public/config.json` (`title`), `index.html` (`<title>`), `README.md` heading                 | Short, plain title shown in the UI and README                                                                                    | `Road Surface Monitor`                   |
| `{{TEAM_MEMBERS}}`    | `public/config.json` (`team`), `package.json` (`author`), `LICENSE`, `README.md` footer       | Names of the four team members                                                                                                   | `Member A, Member B, Member C, Member D` |
| `{{COURSE_NAME}}`     | `public/config.json` (`course`), `README.md` footer                                           | Course name                                                                                                                      | `IoT course, University of Twente`       |
| `{{GITHUB_REPO_URL}}` | `public/config.json` (`repoUrl`), `README.md` links, `docs/MANUAL.md`                         | Repository URL                                                                                                                   | `https://github.com/<org>/<repo>`        |
| `{{BROKER_WS_URL}}`   | `.env.example` (copy to `.env.local`), or the connection drawer in the UI                     | HiveMQ Cloud WebSocket URL, for example `wss://xxxx.s1.eu.hivemq.cloud:8884/mqtt`                                                | empty, entered in the UI                 |
| `{{BROKER_HOST}}`     | `publisher/README.md`, the systemd unit example, `ROAD_MQTT_HOST` environment variable        | Broker host for the Pi (MQTT over TLS, port 8883), for example `xxxx.s1.eu.hivemq.cloud`                                         | empty                                    |
| `{{TOPIC_PREFIX}}`    | `public/config.json` (`broker.topicPrefix`), `publisher.py --prefix`, `docs/DATA_CONTRACT.md` | First part of every MQTT topic                                                                                                   | `road`                                   |
| `{{LABELS}}`          | `public/config.json` (`classes[].id`), `publisher.py --labels`                                | Class names output by the trained model. If they differ, add aliases in the settings drawer or `config.json` instead of renaming | `smooth, rough, bump, stopped`           |
| `{{BIKE_IDS}}`        | `publisher.py --device`, OwnTracks mapping in the connection drawer (`broker.owntracksMap`)   | Device IDs of the bikes. New IDs appear on the dashboard automatically                                                           | `bike1`                                  |
| `{{LICENCE}}`         | `LICENSE`, `package.json` (`license`)                                                         | Licence for the repository                                                                                                       | `MIT`                                    |

## Also fill in

- **GitHub Pages:** after the first push to `main`, open the repository settings, Pages, and set the source to "GitHub Actions". The workflow in `.github/workflows/pages.yml` builds with the repository name as the base path.
- **Git author:** the initial commits were made as `{{TEAM_MEMBERS}}`. Set your own identity (`git config user.name`, `git config user.email`) before committing. To re-author the history, squash it into one commit with your name: `git reset --soft $(git rev-list --max-parents=0 HEAD) && git commit --amend --reset-author -m "Initial version"`.
- **Nominatim contact:** `public/config.json`, `geocoding.contact`. An email address the operator can reach if the dashboard misbehaves, as the Nominatim usage policy asks. Optional but polite.
- **Map styles:** `public/config.json`, `map.styleLight` and `map.styleDark`. Free CARTO styles by default; OpenFreeMap (`https://tiles.openfreemap.org/styles/positron`, `.../dark`) is a drop-in alternative.

## Shipped route

`public/sim/route.geojson` was generated from the FOSSGIS OSRM server (bicycle profile) and follows real streets from the campus to the Oude Markt (about 4.0 km). To regenerate it with different waypoints run `npm run make-route -- lon,lat lon,lat ...` (needs internet). To regenerate the bundled demo ride run `npm run make-demo`.
