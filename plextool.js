#!/usr/bin/env node
'use strict';
// Plex Library Export Tool
// Interactive CLI: search your own Plex library, pick a show, pick seasons/episodes,
// download the original files and remux them to .mp4.
//
// Config via env vars (all optional):
//   PLEX_URL          default http://127.0.0.1:32400
//   PLEX_TOKEN        your Plex auth token. If unset, tries to auto-detect from
//                      common Plex Media Server Preferences.xml locations.
//   STAGING_DIR        default ./download        (in-progress downloads)
//   FINAL_ROOT          default ./test-me          (finished files, per-show subfolder)
//   DOCKER_TOOLS_IMAGE default plex-capture-tools:latest (needs ffmpeg; see Dockerfile.tools)

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const PLEX_URL = process.env.PLEX_URL || 'http://127.0.0.1:32400';
const PLEX_TOKEN = process.env.PLEX_TOKEN || autoDetectToken();
const STAGING_DIR = process.env.STAGING_DIR || path.join(process.cwd(), 'download');
const FINAL_ROOT = process.env.FINAL_ROOT || path.join(process.cwd(), 'test-me');
const DOCKER_TOOLS_IMAGE = process.env.DOCKER_TOOLS_IMAGE || 'plex-capture-tools:latest';

const CID = 'plextool-cli-' + Math.random().toString(16).slice(2, 10);
const COMMON_Q = {
  'X-Plex-Product': 'Plex Web',
  'X-Plex-Version': '4.163.0',
  'X-Plex-Client-Identifier': CID,
  'X-Plex-Platform': 'Node',
  'X-Plex-Token': PLEX_TOKEN,
};

function autoDetectToken() {
  const candidates = [
    '/mnt/user/appdata/Plex-Media-Server/Library/Application Support/Plex Media Server/Preferences.xml',
    '/config/Library/Application Support/Plex Media Server/Preferences.xml',
    path.join(process.env.HOME || '', 'Library/Application Support/Plex Media Server/Preferences.xml'),
    '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml',
  ];
  for (const p of candidates) {
    try {
      const xml = fs.readFileSync(p, 'utf8');
      const m = /PlexOnlineToken="([^"]*)"/.exec(xml);
      if (m) return m[1];
    } catch (e) { /* try next */ }
  }
  return '';
}

if (!PLEX_TOKEN) {
  console.error('No Plex token found. Set PLEX_TOKEN env var or run on the Plex Media Server host.');
  process.exit(1);
}

fs.mkdirSync(STAGING_DIR, { recursive: true });

function qs(obj) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => {
  try {
    return new Promise((resolve) => rl.question(q, resolve));
  } catch (e) {
    console.log('\ninput closed, exiting.');
    process.exit(0);
  }
};

function sanitize(name) {
  return name.replace(/[\/:*?"<>|]/g, '').trim();
}

// ---------- search / metadata ----------

async function searchLibrary(query) {
  const url = `${PLEX_URL}/hubs/search?${qs({ query, ...COMMON_Q })}`;
  const body = await getJson(url);
  const hubs = body?.MediaContainer?.Hub || [];
  const showHub = hubs.find((h) => h.type === 'show');
  const dirs = showHub?.Metadata || [];
  return dirs.map((d) => ({ title: d.title, year: d.year, ratingKey: d.ratingKey }));
}

async function getChildren(ratingKey) {
  const url = `${PLEX_URL}/library/metadata/${ratingKey}/children?${qs(COMMON_Q)}`;
  const body = await getJson(url);
  return body?.MediaContainer?.Metadata || [];
}

async function getGuids(ratingKey) {
  const url = `${PLEX_URL}/library/metadata/${ratingKey}?${qs({ includeGuids: 1, ...COMMON_Q })}`;
  const res = await fetch(url); // no Accept header -> plain XML, easy to regex
  if (!res.ok) return {};
  const xml = await res.text();
  const out = {};
  const re = /<Guid id="([a-z]+):\/\/([^"]+)"/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = m[2];
  return out;
}

// ---------- download + remux ----------

async function downloadEpisode(episodeMeta, outPath, label) {
  const url = `${PLEX_URL}/library/metadata/${episodeMeta.ratingKey}?${qs(COMMON_Q)}`;
  const body = await getJson(url);
  const item = body.MediaContainer.Metadata[0];
  const part = item.Media[0].Part[0];
  const ext = (part.container || 'mp4').toLowerCase();
  const fileUrl = `${PLEX_URL}${part.key}?${qs(COMMON_Q)}`;

  const tmpDir = path.join(STAGING_DIR, `.tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const rawPath = path.join(tmpDir, `raw.${ext}`);

  console.log(`  [${label}] downloading original file (.${ext})...`);
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`file fetch ${res.status}`);
  const dest = fs.createWriteStream(rawPath);
  await new Promise((resolve, reject) => {
    const nodeStream = require('stream').Readable.fromWeb(res.body);
    nodeStream.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });

  if (ext === 'mp4') {
    fs.copyFileSync(rawPath, outPath);
  } else {
    remuxToMp4(tmpDir, `raw.${ext}`, outPath);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function remuxToMp4(dir, inFile, outPath) {
  const r = spawnSync('docker', [
    'run', '--rm',
    '-v', `${dir}:/work`, '-w', '/work',
    DOCKER_TOOLS_IMAGE, 'ffmpeg',
    '-y', '-i', inFile,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c', 'copy', '-movflags', '+faststart', 'remuxed.mp4',
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr);
    throw new Error('ffmpeg remux failed');
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.copyFileSync(path.join(dir, 'remuxed.mp4'), outPath);
}

// ---------- episode spec parsing ----------

function parseEpisodeSpec(spec, maxEp) {
  if (spec.trim().toLowerCase() === 'all') return Array.from({ length: maxEp }, (_, i) => i + 1);
  const out = new Set();
  for (const part of spec.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (t.includes('-')) {
      const [a, b] = t.split('-').map((n) => parseInt(n, 10));
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      out.add(parseInt(t, 10));
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------- main ----------

async function main() {
  let query;
  while (true) {
    query = (await ask('Search (4+ letters): ')).trim();
    if (query.length >= 4) break;
    console.log('  need 4+ letters.');
  }

  console.log('Searching...');
  const results = await searchLibrary(query).catch((e) => { console.error('search failed:', e.message); return []; });
  if (results.length === 0) {
    console.log('No matches.');
    rl.close();
    return;
  }
  results.forEach((r, i) => console.log(`[${i + 1}] ${r.title}${r.year ? ' (' + r.year + ')' : ''}`));

  const pickIdx = parseInt((await ask('Pick a result #: ')).trim(), 10) - 1;
  const show = results[pickIdx];
  if (!show) { console.log('invalid pick'); rl.close(); return; }

  console.log(`Selected: ${show.title}`);
  const seasons = await getChildren(show.ratingKey);
  seasons.forEach((s) => console.log(`  Season ${s.index}: ${s.leafCount} episodes`));

  const mode = (await ask('Download [a]ll / [s]pecific season / [e]pisode in one season: ')).trim().toLowerCase();

  const finalShowDir = path.join(FINAL_ROOT, sanitize(show.title));
  const targets = [];

  async function addSeasonEpisodes(season, epSpecRaw) {
    const episodes = await getChildren(season.ratingKey);
    const epNums = parseEpisodeSpec(epSpecRaw, episodes.length);
    for (const epNum of epNums) {
      const ep = episodes.find((e) => e.index === epNum);
      if (ep) targets.push({ seasonIndex: season.index, episodeIndex: epNum, meta: ep });
    }
  }

  if (mode === 'a') {
    for (const s of seasons) await addSeasonEpisodes(s, 'all');
  } else if (mode === 's') {
    const seasonSpec = (await ask(`Season # (1-${seasons.length}, or comma list): `)).trim();
    const seasonNums = parseEpisodeSpec(seasonSpec, seasons.length);
    for (const sn of seasonNums) {
      const season = seasons.find((s) => s.index === sn);
      if (!season) continue;
      await addSeasonEpisodes(season, 'all');
    }
  } else if (mode === 'e') {
    const sn = parseInt((await ask('Season #: ')).trim(), 10);
    const season = seasons.find((s) => s.index === sn);
    if (!season) { console.log('bad season'); rl.close(); return; }
    const epSpec = await ask('Episodes (e.g. 1,3,5-8 or all): ');
    await addSeasonEpisodes(season, epSpec);
  } else {
    console.log('unknown mode');
    rl.close();
    return;
  }

  console.log(`Will download ${targets.length} episode(s) -> ${finalShowDir}`);

  for (const t of targets) {
    const label = `S${String(t.seasonIndex).padStart(2, '0')}E${String(t.episodeIndex).padStart(2, '0')}`;
    const title = sanitize(t.meta.title || label);
    const fname = `${label} - ${title}.mp4`;
    const finalPath = path.join(finalShowDir, fname);
    if (fs.existsSync(finalPath)) { console.log(`skip (exists): ${finalPath}`); continue; }

    const guids = await getGuids(t.meta.ratingKey).catch(() => ({}));
    const guidStr = Object.entries(guids).map(([k, v]) => `${k}:${v}`).join(' ') || 'no external IDs found';
    console.log(`Downloading ${label} - ${title} (${guidStr})...`);

    const stagingPath = path.join(STAGING_DIR, fname);
    try {
      await downloadEpisode(t.meta, stagingPath, label);
      fs.mkdirSync(finalShowDir, { recursive: true });
      fs.renameSync(stagingPath, finalPath);
      console.log(`  saved: ${finalPath}`);
    } catch (e) {
      console.error(`  FAILED ${label}: ${e.message}`);
      fs.rmSync(stagingPath, { force: true });
    }
  }

  rl.close();
}

if (require.main === module) main();
