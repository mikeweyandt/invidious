#!/usr/bin/env node
// Browser test for the DASH player's behaviour when stream links expire.
//
//   node spec/player/retry_loop/run.mjs <mode>
//
// Modes:
//   baseline  upstream/master player.js; passes when the retry loop REPRODUCES
//   fixed     working-tree player.js; links expire, a manifest refresh recovers
//   dead      working-tree player.js; links expire and never work again
//   dead-media  working-tree player.js; after expiry the manifest and stream
//             headers still load, but every media segment is rejected
//   outage    working-tree player.js; media is rejected for a while, then works
//             again; playback must resume from where it stopped
//   normal    working-tree player.js; links never expire (false-positive check)
//
// Requires node >= 20, ffmpeg, tar, and a Chromium-family browser.
// Set BROWSER to override the browser command (e.g. BROWSER=chromium).
// See README.md in this directory.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MODE = process.argv[2] || "fixed";
const BASELINE_REF = process.env.BASELINE_REF || "upstream/master";

// How long generated links stay valid, in seconds.
const TTL = MODE === "normal" ? 3600 : 8;
// How long the browser is left running, in seconds.
const RUN_SECONDS = Number(process.env.RUN_SECONDS) ||
    { baseline: 25, fixed: 40, dead: 75, "dead-media": 75, outage: 60, normal: 25 }[MODE];
// "outage" mode: how long media stays unavailable after the first TTL.
const OUTAGE_SECONDS = 14;
// Length of the generated test video, in seconds.
const VIDEO_SECONDS = 180;

if (!(MODE in { baseline: 1, fixed: 1, dead: 1, "dead-media": 1, outage: 1, normal: 1 })) {
    console.error("usage: run.mjs baseline|fixed|dead|dead-media|outage|normal");
    process.exit(2);
}

const CACHE = path.join(os.tmpdir(), "invidious-player-retry-loop-test");
fs.mkdirSync(CACHE, { recursive: true });

// ---------------------------------------------------------------------------
// Player dependencies: same versions and checksums as the real build
// (videojs-dependencies.yml / scripts/fetch-player-dependencies.cr).
// ---------------------------------------------------------------------------

function readDependencies() {
    const text = fs.readFileSync(path.join(REPO, "videojs-dependencies.yml"), "utf8");
    const deps = {};
    const re = /^([A-Za-z0-9_.-]+):\n\s+version:\s*(\S+)\n\s+shasum:\s*(\S+)/gm;
    let m;
    while ((m = re.exec(text))) deps[m[1]] = { version: m[2], shasum: m[3] };
    return deps;
}

async function fetchDependencies() {
    const deps = readDependencies();
    for (const [name, { version, shasum }] of Object.entries(deps)) {
        const dir = path.join(CACHE, "deps", `${name}-${version}`);
        deps[name].dir = path.join(dir, "package", "dist");
        if (fs.existsSync(deps[name].dir)) continue;

        const res = await fetch(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
        if (!res.ok) throw new Error(`download of ${name} failed: ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer());
        const actual = createHash("sha1").update(data).digest("hex");
        if (actual !== shasum) throw new Error(`checksum for ${name} failed`);

        fs.mkdirSync(dir, { recursive: true });
        const tgz = path.join(dir, "package.tgz");
        fs.writeFileSync(tgz, data);
        execFileSync("tar", ["-xzf", tgz, "-C", dir]);
    }
    return deps;
}

// ---------------------------------------------------------------------------
// Fixture: single-file fragmented MP4s with one index (sidx) box each, the
// same layout YouTube serves and Invidious describes with SegmentBase.
// ---------------------------------------------------------------------------

const STREAMS = [
    { itag: 140, kind: "audio", codecs: "mp4a.40.2", bandwidth: 48000 },
    { itag: 134, kind: "video", codecs: "avc1.42c00c", bandwidth: 150000, width: 640, height: 360 },
    { itag: 133, kind: "video", codecs: "avc1.42c00c", bandwidth: 60000, width: 426, height: 240 },
];

function generateFixture() {
    const dir = path.join(CACHE, `fixture-${VIDEO_SECONDS}s`);
    fs.mkdirSync(dir, { recursive: true });

    for (const s of STREAMS) {
        s.file = path.join(dir, `${s.itag}.mp4`);
        if (!fs.existsSync(s.file)) {
            const input = s.kind === "audio"
                ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"]
                : ["-f", "lavfi", "-i", `testsrc=size=${s.width}x${s.height}:rate=15`];
            const codec = s.kind === "audio"
                ? ["-c:a", "aac", "-b:a", String(s.bandwidth)]
                : ["-c:v", "libx264", "-profile:v", "baseline", "-level", "1.2", "-preset", "ultrafast",
                    "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
                    "-b:v", String(s.bandwidth), "-pix_fmt", "yuv420p"];
            const tmp = s.file + ".tmp.mp4";
            const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...input,
                "-t", String(VIDEO_SECONDS), ...codec,
                "-movflags", "+dash+global_sidx+frag_keyframe", "-frag_duration", "2000000", tmp],
                { stdio: ["ignore", "inherit", "inherit"] });
            if (r.status !== 0) throw new Error("ffmpeg failed (is ffmpeg installed?)");
            fs.renameSync(tmp, s.file);
        }

        s.data = fs.readFileSync(s.file);
        // Locate the top-level sidx box: everything before it is the init
        // segment, the box itself is the index.
        let offset = 0;
        while (offset < s.data.length) {
            const size = s.data.readUInt32BE(offset);
            const type = s.data.toString("latin1", offset + 4, offset + 8);
            if (type === "sidx") {
                s.initRange = [0, offset - 1];
                s.indexRange = [offset, offset + size - 1];
                break;
            }
            offset += size;
        }
        if (!s.indexRange) throw new Error(`no sidx box found in ${s.file}`);
    }
}

// Mirrors the document built in src/invidious/routes/api/manifest.cr.
function buildManifest(origin, expire) {
    const rep = (s, attrs, extra = "") => {
        const url = `${origin}/videoplayback?itag=${s.itag}&amp;expire=${expire}&amp;c=WEB`;
        return `<Representation id="${s.itag}" codecs="${s.codecs}" bandwidth="${s.bandwidth}"${attrs}>` +
            extra + `<BaseURL>${url}</BaseURL>` +
            `<SegmentBase indexRange="${s.indexRange.join("-")}">` +
            `<Initialization range="${s.initRange.join("-")}"/></SegmentBase></Representation>`;
    };
    const audio = STREAMS.filter((s) => s.kind === "audio");
    const video = STREAMS.filter((s) => s.kind === "video");
    return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:full:2011" minBufferTime="PT1.5S" type="static" mediaPresentationDuration="PT${VIDEO_SECONDS}S">
<Period>
${audio.map((s, i) => `<AdaptationSet id="${i}" mimeType="audio/mp4" startWithSAP="1" subsegmentAlignment="true" label="Unknown [${s.bandwidth}k]" lang="und">` +
        `<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>` +
        rep(s, "", `<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>`) +
        `</AdaptationSet>`).join("\n")}
<AdaptationSet id="${audio.length}" mimeType="video/mp4" startWithSAP="1" subsegmentAlignment="true" scanType="progressive">
${video.map((s) => rep(s, ` width="${s.width}" height="${s.height}" startWithSAP="1" maxPlayoutRate="1" frameRate="15"`)).join("\n")}
</AdaptationSet>
</Period>
</MPD>`;
}

// ---------------------------------------------------------------------------
// Harness page: same data blocks and script order as the watch page
// (views/watch.ecr, views/components/player.ecr, player_sources.ecr).
// ---------------------------------------------------------------------------

function harnessPage() {
    const videoData = {
        id: "TESTVIDEO01",
        length_seconds: VIDEO_SECONDS,
        params: {
            autoplay: true, listen: false, quality: "dash", quality_dash: "auto",
            speed: 1, volume: 0, video_start: 0, video_end: -1, video_loop: false,
            annotations: false, save_player_pos: false, vr_mode: false, controls: true,
        },
        preferences: {},
        premiere_timestamp: null,
        vr: false,
        projection_type: null,
        local_disabled: false,
        live_now: false,
    };
    const playerData = { aspect_ratio: "16:9", title: "Retry loop test", description: "", thumbnail: "", preferred_caption_found: false };
    const config = { videojs: { goal_buffer_length: 4, max_goal_buffer_length: 6 } };
    const json = (id, v) => `<script id="${id}" type="application/json">${JSON.stringify(v)}</script>`;

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>player retry loop test</title>
<link rel="stylesheet" href="/videojs/video.js/video-js.css">
<script src="/js/_helpers.js"></script>
<script src="/videojs/video.js/video.js"></script>
<script src="/videojs/videojs-mobile-ui/videojs-mobile-ui.js"></script>
<script src="/videojs/videojs-contrib-quality-levels/videojs-contrib-quality-levels.js"></script>
<script src="/videojs/videojs-http-source-selector/videojs-http-source-selector.js"></script>
<script src="/videojs/videojs-markers/videojs-markers.js"></script>
<script src="/videojs/videojs-share/videojs-share.js"></script>
<script src="/videojs/videojs-vtt-thumbnails/videojs-vtt-thumbnails.js"></script>
</head><body>
${json("video_data", videoData)}
${json("config", config)}
<div id="player-container">
<video style="outline:none;width:640px" playsinline muted id="player" class="video-js" preload="auto" autoplay controls>
<source src="/api/manifest/dash/id/TESTVIDEO01?local=true&unique_res=1" type="application/dash+xml" label="dash">
</video>
${json("player_data", playerData)}
<script src="/js/player.js"></script>
</div>
<script src="/probe.js"></script>
</body></html>`;
}

// Runs in the page after player.js: reports player state to the test server.
const PROBE = `
(function () {
    var counts = {};
    var warnings = [];
    function bump(name) { counts[name] = (counts[name] || 0) + 1; }

    var origWarn = console.warn;
    console.warn = function () {
        var msg = Array.prototype.join.call(arguments, ' ').slice(0, 160);
        if (warnings.indexOf(msg) === -1 && warnings.length < 12) warnings.push(msg);
        return origWarn.apply(console, arguments);
    };

    var boundTech = null;
    function bindTech() {
        var tech = player.tech({ IWillNotUseThisInPlugins: true });
        if (!tech || tech === boundTech) return;
        boundTech = tech;
        ['retryplaylist', 'blacklistplaylist'].forEach(function (name) {
            tech.on(name, function () { bump(name); });
        });
    }
    player.ready(bindTech);
    ['loadstart', 'error', 'loadedmetadata', 'waiting', 'playing'].forEach(function (name) {
        player.on(name, function () { bump(name); bindTech(); });
    });

    setInterval(function () {
        var err = player.error();
        fetch('/report', {
            method: 'POST',
            body: JSON.stringify({
                currentTime: player.currentTime(),
                paused: player.paused(),
                error: err ? { code: err.code, message: err.message } : null,
                counts: counts,
                warnings: warnings
            })
        });
    }, 1000);
})();
`;

// ---------------------------------------------------------------------------
// Test server
// ---------------------------------------------------------------------------

const stats = {
    manifestFetches: 0,
    segmentsServed: 0,
    rejected: 0,            // 400s for expired / dead links
    rejectedPerSecond: {},  // seconds since first rejection -> count
    firstRejectionAt: null,
    lastRejectionAt: null,
    lastSegmentAt: null,
    reports: [],
};
let firstManifestAt = null;

function playerSource() {
    if (MODE !== "baseline") return fs.readFileSync(path.join(REPO, "assets/js/player.js"));
    return execFileSync("git", ["-C", REPO, "show", `${BASELINE_REF}:assets/js/player.js`]);
}

function startServer(deps) {
    const playerJs = playerSource();
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        const origin = `http://${req.headers.host}`;
        const send = (status, type, body, headers = {}) => {
            res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
            res.end(body);
        };

        if (url.pathname === "/harness.html") return send(200, "text/html", harnessPage());
        if (url.pathname === "/probe.js") return send(200, "text/javascript", PROBE);
        if (url.pathname === "/js/player.js") return send(200, "text/javascript", playerJs);
        if (url.pathname === "/js/_helpers.js")
            return send(200, "text/javascript", fs.readFileSync(path.join(REPO, "assets/js/_helpers.js")));

        if (url.pathname.startsWith("/videojs/")) {
            const [, , dep, file] = url.pathname.split("/");
            if (!deps[dep] || !/^[\w.-]+$/.test(file)) return send(404, "text/plain", "not found");
            const full = path.join(deps[dep].dir, file);
            if (!fs.existsSync(full)) return send(404, "text/plain", "not found");
            return send(200, file.endsWith(".css") ? "text/css" : "text/javascript", fs.readFileSync(full));
        }

        if (url.pathname.startsWith("/api/manifest/dash/id/")) {
            stats.manifestFetches++;
            firstManifestAt ??= Date.now();
            const expire = Math.floor(Date.now() / 1000) + TTL;
            return send(200, "application/dash+xml", buildManifest(origin, expire));
        }

        if (url.pathname === "/videoplayback") {
            const stream = STREAMS.find((s) => String(s.itag) === url.searchParams.get("itag"));
            if (!stream) return send(404, "text/plain", "unknown itag");

            const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
            const start = m ? Number(m[1]) : 0;

            const now = Date.now();
            const expired = Number(url.searchParams.get("expire")) < Math.floor(now / 1000);
            // In the "dead" modes even fresh links stop working after the first
            // TTL: entirely, or only for media segments (init + index still load).
            const afterFirstTtl = now > firstManifestAt + TTL * 1000;
            const isMedia = start > stream.indexRange[1];
            const inOutage = afterFirstTtl && now < firstManifestAt + (TTL + OUTAGE_SECONDS) * 1000;
            const dead = (afterFirstTtl && (MODE === "dead" || (MODE === "dead-media" && isMedia))) ||
                (MODE === "outage" && inOutage && isMedia);
            if (expired || dead) {
                stats.rejected++;
                stats.firstRejectionAt ??= now;
                stats.lastRejectionAt = now;
                const sec = Math.floor((now - stats.firstRejectionAt) / 1000);
                stats.rejectedPerSecond[sec] = (stats.rejectedPerSecond[sec] || 0) + 1;
                // Same status and body as invidious-companion's videoplayback proxy.
                return send(400, "text/plain",
                    "Expire query string undefined or videoplayback URL has expired.");
            }

            const end = m && m[2] ? Math.min(Number(m[2]), stream.data.length - 1) : stream.data.length - 1;
            stats.segmentsServed++;
            stats.lastSegmentAt = now;
            return send(m ? 206 : 200, stream.kind + "/mp4", stream.data.subarray(start, end + 1), {
                "accept-ranges": "bytes",
                "content-range": `bytes ${start}-${end}/${stream.data.length}`,
            });
        }

        if (url.pathname === "/report" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                try { stats.reports.push({ at: Date.now(), ...JSON.parse(body) }); } catch { /* ignore */ }
                send(204, "text/plain", "");
            });
            return;
        }

        send(404, "text/plain", "not found");
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function findBrowser() {
    if (process.env.BROWSER) return { cmd: process.env.BROWSER.split(" "), flatpak: /flatpak/.test(process.env.BROWSER) };
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
        if (spawnSync("which", [name]).status === 0) return { cmd: [name], flatpak: false };
    }
    for (const app of ["org.chromium.Chromium", "com.google.Chrome"]) {
        if (spawnSync("flatpak", ["info", app]).status === 0) return { cmd: ["flatpak", "run", app], flatpak: app };
    }
    throw new Error("no Chromium-family browser found; set BROWSER");
}

function launchBrowser(url) {
    const browser = findBrowser();
    // A dedicated profile so the run never attaches to an already-open browser.
    // Flatpak browsers can only write inside their own sandbox directory.
    const profileParent = browser.flatpak && typeof browser.flatpak === "string"
        ? path.join(os.homedir(), ".var/app", browser.flatpak, "cache")
        : os.tmpdir();
    fs.mkdirSync(profileParent, { recursive: true });
    const profile = fs.mkdtempSync(path.join(profileParent, "iv-retry-loop-test-"));
    const child = spawn(browser.cmd[0], [...browser.cmd.slice(1),
        "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--mute-audio", "--autoplay-policy=no-user-gesture-required",
        `--user-data-dir=${profile}`, "--window-size=900,700", url],
        { stdio: "ignore", detached: true });
    return {
        stop() {
            try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
            return new Promise((resolve) => setTimeout(() => {
                try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
                fs.rmSync(profile, { recursive: true, force: true });
                resolve();
            }, 1500));
        },
    };
}

// ---------------------------------------------------------------------------
// Run and judge
// ---------------------------------------------------------------------------

const deps = await fetchDependencies();
generateFixture();
const server = await startServer(deps);
const port = server.address().port;
const browser = launchBrowser(`http://127.0.0.1:${port}/harness.html`);

await new Promise((resolve) => setTimeout(resolve, RUN_SECONDS * 1000));
const endedAt = Date.now();
await browser.stop();
server.close();
server.closeAllConnections();

const last = stats.reports[stats.reports.length - 1] || {};
const times = stats.reports.map((r) => r.currentTime);
const maxTime = Math.max(0, ...times);
const perSecond = Object.values(stats.rejectedPerSecond);
const quietSeconds = stats.lastRejectionAt ? (endedAt - stats.lastRejectionAt) / 1000 : null;
// Seconds of the run in which playback position was still advancing at the end.
const tail = stats.reports.slice(-5).map((r) => r.currentTime);
const advancingAtEnd = tail.length >= 2 && tail[tail.length - 1] > tail[0] + 1;

const summary = {
    mode: MODE,
    runSeconds: RUN_SECONDS,
    linkTtlSeconds: TTL,
    manifestFetches: stats.manifestFetches,
    segmentsServed: stats.segmentsServed,
    rejectedRequests: stats.rejected,
    peakRejectedPerSecond: perSecond.length ? Math.max(...perSecond) : 0,
    secondsSinceLastRejection: quietSeconds === null ? null : Number(quietSeconds.toFixed(1)),
    reportsReceived: stats.reports.length,
    maxCurrentTime: Number(maxTime.toFixed(1)),
    advancingAtEnd,
    finalError: last.error || null,
    playerEvents: last.counts || {},
    warnings: last.warnings || [],
};
console.log(JSON.stringify(summary, null, 2));

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

check(stats.reports.length > 0, "the page never reported in (browser or player.js failed to start)");
check(stats.segmentsServed > 0, "no media was ever served (playback never started)");

if (MODE === "baseline") {
    check(stats.rejected > 200, `expected the retry loop to reproduce (>200 rejected requests), got ${stats.rejected}`);
} else if (MODE === "fixed") {
    // Each expiry may cost a handful of rejected requests before the reload.
    const allowed = 10 * stats.manifestFetches;
    check(stats.rejected <= allowed, `expected at most ${allowed} rejected requests, got ${stats.rejected}`);
    check(stats.manifestFetches >= 2, "expected the manifest to be re-fetched after links expired");
    check(maxTime > TTL + 10, `expected playback to continue well past expiry, reached ${maxTime.toFixed(1)}s`);
    check(advancingAtEnd, "expected playback to still be advancing at the end of the run");
    check(!last.error, "expected no player error");
} else if (MODE === "dead" || MODE === "dead-media") {
    check(stats.rejected <= 60, `expected at most 60 rejected requests, got ${stats.rejected}`);
    check(quietSeconds !== null && quietSeconds >= 15, `expected requests to have stopped for 15s+, quiet for ${quietSeconds}`);
    check(!!last.error, "expected the player to show an error");
    if (MODE === "dead-media") {
        check(stats.manifestFetches === 4, `expected 3 reload attempts (4 manifest fetches), got ${stats.manifestFetches}`);
        check(/stopped responding/.test(last.error?.message || ""), "expected the give-up error message");
    }
} else if (MODE === "outage") {
    // Playback position when the outage began.
    const before = stats.reports.filter((r) => r.at < stats.firstRejectionAt).map((r) => r.currentTime);
    const stoppedAt = Math.max(0, ...before);
    const restarted = stats.reports.some((r) => r.at > stats.firstRejectionAt &&
        r.currentTime > 0.5 && r.currentTime < stoppedAt - 2);
    console.log(`position when outage began: ${stoppedAt.toFixed(1)}s, final position: ${(last.currentTime || 0).toFixed(1)}s`);
    check(stats.manifestFetches >= 3, `expected more than one reload attempt, got ${stats.manifestFetches - 1}`);
    check(!restarted, "playback restarted from the beginning instead of resuming");
    check(last.currentTime > stoppedAt + 5, "expected playback to resume and move past where it stopped");
    check(advancingAtEnd, "expected playback to still be advancing at the end of the run");
    check(!last.error, "expected no player error");
} else if (MODE === "normal") {
    check(stats.rejected === 0, `expected no rejected requests, got ${stats.rejected}`);
    check(stats.manifestFetches === 1, `expected exactly one manifest fetch, got ${stats.manifestFetches}`);
    check(advancingAtEnd, "expected playback to still be advancing at the end of the run");
    check(!last.error, "expected no player error");
}

if (failures.length) {
    console.log(`\nFAIL (${MODE})`);
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
}
console.log(MODE === "baseline" ? "\nPASS (baseline): retry loop reproduced on " + BASELINE_REF : `\nPASS (${MODE})`);
