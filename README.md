# Berlin Streckensammler

Log which of Berlin's public transport stations you have been to, by mode:
S-Bahn, U-Bahn, regional trains, tram, bus and ferry. Type a station's name or
look up the stops near you (your location is asked for once and never leaves the
browser), and tap to log a visit. Every visit is a journal entry with a date and an
optional note on what you did there; a station counts as collected from its first.
Progress per mode and per line, with each line's stations in order.

Live at https://berlin-streckensammler.janbe.eu

## How it is built

- **One Bun process** (`src/server.ts`) serves everything: the React app, which
  Bun bundles from `src/index.html`, the station data and a small JSON API.
  No separate web server.
- **SQLite** (`bun:sqlite`, `src/db.ts`): users, sessions, passkeys and the journal
  (`entries`: station, mode, date, note; any number per station).
  Collecting needs no account: the first station collected starts an anonymous
  collection tied to a session cookie. **Accounts** (`src/auth.ts`) are a name plus
  passkeys (WebAuthn via `@simplewebauthn`, discoverable credentials, so signing in
  needs no name). Creating an account or signing in takes over the anonymous
  collection of that browser; more passkeys can be added for other devices or
  password managers, and the last one cannot be removed.
- **Station data** (`data/stations.json`, committed) comes from VBB's GTFS open
  data (CC BY 4.0), built by `scripts/build-data.ts`:
  - a station is a named stop; its modes and lines come from the trips stopping there;
  - Berlin only, except the S-Bahn, whose whole network counts;
  - the current feed covers only about two months, so stations closed in that window
    are filled in from VBB's yearly archives (rail, tram, ferry only);
  - the northern U6 (closed 2022–2027) is added by hand.

## Develop

```bash
bun install
bun run dev        # http://localhost:3000, hot reload (PORT=... to change)
                   # passkeys work on localhost; production needs ORIGIN=https://...
bun test
bun run typecheck
```

## Update the station data

```bash
curl -L -o gtfs.zip https://unternehmen.vbb.de/gtfs && unzip -o gtfs.zip -d gtfs
# yearly archives, for stations closed right now:
curl -L -o gtfs-2024.zip https://unternehmen.vbb.de/fileadmin/user_upload/VBB/Dokumente/API-Datensaetze/gtfs-2024.zip && unzip -o gtfs-2024.zip -d gtfs-2024
curl -L -o gtfs-2023.zip https://unternehmen.vbb.de/fileadmin/user_upload/VBB/Dokumente/API-Datensaetze/gtfs-2023.zip && unzip -o gtfs-2023.zip -d gtfs-2023
bun run data gtfs gtfs-2024 gtfs-2023
bun test           # checks the U-Bahn and S-Bahn counts, among others
```

Station IDs are VBB's stop IDs, so visits survive a data update.

## Deploy

A push to `main` runs `.github/workflows/deploy.yml`: the Docker image is built (the
tests run inside the build) and pushed to `ghcr.io/jan-be/berlin-streckensammler`.
On the server, `deploy/docker-compose.yml` (as `~/streckensammler/docker-compose.yml`)
runs the app behind Traefik plus its own Watchtower, which pulls a new `:latest`
within a minute. The database lives in `~/docker_files/streckensammler/app.db`.

## Data and credits

Stop data: VBB Verkehrsverbund Berlin-Brandenburg GmbH, GTFS, licensed CC BY 4.0.
Mode signs (`src/client/signs/`): Berlin's S-Bahn, U-Bahn, VBB regional, tram, BVG bus and ferry
signs from Wikimedia Commons, all marked public domain there (S-Bahn-Logo.svg, U-Bahn Berlin logo.svg,
VBB Bahn-Regionalverkehr.svg, Tram-Logo.svg, BUS-Logo-BVG.svg, Fähre-Logo-BVG.svg).
A private project, not affiliated with BVG, S-Bahn Berlin, VBB or the "Streckensammler" app.
