# plex-library-export

Interactive CLI to search your own Plex library and export episodes to `.mp4`.

Search your library (4+ letters), pick a show, pick seasons/episodes (`all`, a
season list, or `1,3,5-8` style ranges), and it downloads the original files
from your Plex server and remuxes anything that isn't already `.mp4` (stream
copy, no re-encode) via ffmpeg.

Before each download it prints the episode's TMDB/TVDB GUIDs (pulled live
from Plex's `includeGuids=1` metadata) so you can cross-check you're grabbing
the right episode before trusting the file.

Files are written to a staging folder first, then moved into
`test-me/<Show Name>/` only once the download succeeds — nothing partial
ever lands in the final folder.

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- Docker (for the ffmpeg remux step) — build the included image once:
  ```
  docker build -t plex-capture-tools -f Dockerfile.tools .
  ```
- A Plex token. Either set `PLEX_TOKEN` yourself, or run this on/near your
  Plex Media Server host — it'll try to auto-detect the token from the usual
  `Preferences.xml` locations (Unraid, Docker `linuxserver/plex`-style
  `/config`, macOS, standard Linux package).

## Usage

```
PLEX_URL=http://127.0.0.1:32400 \
PLEX_TOKEN=xxxx \
node plextool.js
```

```
Search (4+ letters): <show name>
[1] Show A (2020)
[2] Show B (2019)
Pick a result #: 1
  Season 1: 10 episodes
  Season 2: 8 episodes
Download [a]ll / [s]pecific season / [e]pisode in one season: e
Season #: 1
Episodes (e.g. 1,3,5-8 or all): 1,3,5-8
```

Needs a real terminal — piping input doesn't work (Node's readline closes on
EOF mid-session).

## Config (env vars, all optional)

| Var | Default | Purpose |
|---|---|---|
| `PLEX_URL` | `http://127.0.0.1:32400` | Your Plex server |
| `PLEX_TOKEN` | auto-detected | Plex auth token |
| `STAGING_DIR` | `./download` | In-progress downloads |
| `FINAL_ROOT` | `./test-me` | Finished files, one subfolder per show |
| `DOCKER_TOOLS_IMAGE` | `plex-capture-tools:latest` | ffmpeg image name |

## Scope

This only pulls from **your own Plex library** — content you already have
rights to. It does not touch Plex's ad-supported "Watch Free" catalog.
