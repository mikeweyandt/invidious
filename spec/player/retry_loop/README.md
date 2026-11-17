# DASH player retry-loop test

Browser test for what `assets/js/player.js` does when DASH stream links stop
working (most commonly because the `expire` time in the videoplayback URL has
passed while the tab was left open).

Without a guard, video.js retries the failing renditions with no delay and
never raises a player error, sending thousands of requests per second for as
long as the tab stays open.

## Running

```sh
node spec/player/retry_loop/run.mjs <mode>
```

| Mode         | `player.js` used  | Server behaviour                                             | Passes when                                                   |
|--------------|-------------------|--------------------------------------------------------------|---------------------------------------------------------------|
| `baseline`   | `upstream/master` | links expire after 8 s                                       | the retry loop **reproduces** (proves the test has teeth)     |
| `fixed`      | working tree      | links expire after 8 s; a new manifest has fresh links       | manifest is reloaded, playback continues, few rejections      |
| `outage`     | working tree      | media is rejected for 14 s, then works again                 | playback resumes from where it stopped, no error              |
| `dead`       | working tree      | everything is rejected after 8 s                             | requests stop and the player shows an error                   |
| `dead-media` | working tree      | manifest and stream headers load, media segments are rejected | three reload attempts, then requests stop with an error      |
| `dead-network` | working tree    | like `dead-media`, but connections are dropped (no response) | three reload attempts, then requests stop with an error      |
| `normal`     | working tree      | links never expire                                           | no rejections, no reloads                                     |

Each run prints a JSON summary (request counts, player events, final error)
followed by `PASS` or `FAIL` and exits non-zero on failure.

## Requirements

- node 20 or newer, `ffmpeg`, `tar`
- a Chromium-family browser. One is looked up on `PATH`, then as a Flatpak;
  set `BROWSER` to choose one, e.g. `BROWSER=chromium`.
- network access on the first run, to download the player dependencies listed
  in `videojs-dependencies.yml` from the npm registry (checksums are verified)

Downloads and the generated test video are cached in the system temp
directory under `invidious-player-retry-loop-test`.

Other options:

- `BASELINE_REF`: git ref used by `baseline`
- `RUN_SECONDS`: how long the browser is left running
- `TTL`: seconds until links stop working (`TTL=0` fails from the first request)
- `DROP=1`: drop the connection instead of answering `400`, in any mode

## How it works

`run.mjs` starts a local server that plays three roles:

- the watch page: the same data blocks and script order as the real page,
  loading the real `_helpers.js` and `player.js`
- the DASH manifest: the same shape `src/invidious/routes/api/manifest.cr`
  produces, with a fresh `expire` on every fetch
- the videoplayback proxy: answers `400` once `expire` has passed, like
  invidious-companion does

It opens the page in a headless browser, lets it run, and judges the result
from what the server saw plus state the page reports back once a second.

This is not wired into CI.
