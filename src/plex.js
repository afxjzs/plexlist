/* Plex client.
 *
 * Ported from the working "Save to Plex" panel in
 * doug-is/src/content/stuff/simpsons-episodes-ranked.html and the endpoint notes
 * in LEARNINGS.md. Every endpoint used here was verified against a live server on
 * 2026-08-20 except where a comment says otherwise.
 *
 * Runs in the MV3 service worker, so page CORS does not apply — but host
 * permissions do. Anything that can fail throws with a message a human can act on.
 */

const PRODUCT = "PlexList";
const BATCH = 150; // rating keys per request; see LEARNINGS.md §5 (safe, not a known max)

/* ------------------------------------------------------------------ storage */

const KEY_TOKEN = "plex_token";
const KEY_CID = "plex_client_id";
const KEY_INDEX = "plex_index_cache";

export async function getToken() {
  const s = await chrome.storage.local.get(KEY_TOKEN);
  return s[KEY_TOKEN] || null;
}

export async function setToken(token) {
  await chrome.storage.local.set({ [KEY_TOKEN]: token });
}

export async function clearToken() {
  await chrome.storage.local.remove([KEY_TOKEN, KEY_INDEX]);
}

/* Must be stable per install. A fresh id orphans the authorization and shows up
 * as a brand new device in the user's Plex account on every sign-in. */
export async function clientId() {
  const s = await chrome.storage.local.get(KEY_CID);
  if (s[KEY_CID]) return s[KEY_CID];
  const id = "plexlist-" + crypto.randomUUID();
  await chrome.storage.local.set({ [KEY_CID]: id });
  return id;
}

/* ---------------------------------------------------------------- transport */

/* No silent failures: a non-2xx, a timeout, and a bad body each throw with the
 * status and the path that produced them. */
async function jsonFetch(url, opts = {}) {
  const ms = opts.timeout || 15000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let res;
  try {
    res = await fetch(url, {
      method: opts.method || "GET",
      headers: opts.headers,
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`timed out after ${ms / 1000}s`);
    throw new Error(`${url.split("?")[0]} failed: ${e.message}`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Plex returned HTTP ${res.status} for ${url.split("?")[0]}`);
  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Plex returned a non-JSON body for ${url.split("?")[0]}: ${e.message}`);
  }
}

async function tvHeaders(withToken) {
  const h = {
    Accept: "application/json",
    "X-Plex-Product": PRODUCT,
    "X-Plex-Client-Identifier": await clientId(),
  };
  if (withToken) {
    const t = await getToken();
    if (!t) throw new Error("not signed in to Plex");
    h["X-Plex-Token"] = t;
  }
  return h;
}

/* The token rides in a header, never the query string, so it stays out of logs,
 * history and referrers. Verified: Plex allows X-Plex-Token cross-origin. */
function srvHeaders(conn) {
  return { Accept: "application/json", "X-Plex-Token": conn.token };
}

function srvGet(conn, path, params) {
  const q = new URLSearchParams(params || {}).toString();
  return jsonFetch(conn.base + path + (q ? "?" + q : ""), {
    headers: srvHeaders(conn),
    timeout: 60000,
  });
}

function srvSend(conn, method, path, params) {
  const q = new URLSearchParams(params || {}).toString();
  return jsonFetch(conn.base + path + (q ? "?" + q : ""), {
    method,
    headers: srvHeaders(conn),
    timeout: 60000,
  });
}

/* --------------------------------------------------------------------- auth */

export async function createPin() {
  const pin = await jsonFetch("https://plex.tv/api/v2/pins?strong=true", {
    method: "POST",
    headers: await tvHeaders(false),
  });
  if (!pin || !pin.id || !pin.code) {
    throw new Error("Plex did not return a usable PIN");
  }
  return pin;
}

export async function authUrl(code) {
  const cid = await clientId();
  return (
    "https://app.plex.tv/auth#?clientID=" +
    encodeURIComponent(cid) +
    "&code=" +
    encodeURIComponent(code) +
    "&context%5Bdevice%5D%5Bproduct%5D=" +
    encodeURIComponent(PRODUCT)
  );
}

/* Poll until the user approves. `isCancelled` lets the caller abort when the
 * approval tab is closed, so this never spins silently forever. */
export async function pollPin(pinId, { deadlineMs = 300000, isCancelled } = {}) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error("timed out waiting for you to approve access");
    if (isCancelled && (await isCancelled())) {
      throw new Error("the Plex sign-in tab was closed before approving");
    }
    const p = await jsonFetch(`https://plex.tv/api/v2/pins/${pinId}`, {
      headers: await tvHeaders(false),
      timeout: 10000,
    });
    if (p.authToken) return p.authToken;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/* ------------------------------------------------------------------ servers */

export async function listServers() {
  const list = await jsonFetch(
    "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1",
    { headers: await tvHeaders(true), timeout: 20000 }
  );
  const servers = (list || []).filter((d) => (d.provides || "").includes("server"));
  if (!servers.length) throw new Error("no Plex servers on this account");
  /* Strip to what the UI needs; accessToken stays in the worker. */
  return servers.map((s, i) => ({
    id: i,
    name: s.name,
    owned: !!s.owned,
    accessToken: s.accessToken,
    connections: s.connections || [],
  }));
}

/* Race every connection rather than iterating. Verified: one real server
 * advertised 16 connections of which exactly 1 worked; serially at an 8s timeout
 * that is a two-minute wait, raced it is under a second.
 *
 * `presence`/`online` flags are ignored on purpose — verified stale on a server
 * that was serving requests perfectly. */
export async function connect(server) {
  const token = server.accessToken;
  if (!token) throw new Error(`${server.name} has no access token on this account`);
  const conns = server.connections;
  if (!conns.length) throw new Error(`${server.name} lists no connections`);

  const tries = conns.map(async (c) => {
    const r = await jsonFetch(c.uri + "/", {
      headers: { Accept: "application/json", "X-Plex-Token": token },
      timeout: 8000,
    });
    const machine = r?.MediaContainer?.machineIdentifier;
    if (!machine) throw new Error("no machineIdentifier in response");
    return { base: c.uri, token, machine, local: !!c.local };
  });

  try {
    return await Promise.any(tries);
  } catch {
    const localCount = conns.filter((c) => c.local).length;
    throw new Error(
      `could not reach ${server.name} on any of its ${conns.length} connections` +
        (localCount
          ? `. ${localCount} of them are private-network addresses — grant PlexList ` +
            `access to all sites (see the README) so it may reach your LAN`
          : "")
    );
  }
}

/* ---------------------------------------------------------------- the index
 *
 * The finding the whole extension rests on: Plex stores external ids and hands
 * them over for an entire library in one request. Verified: 5,879 movies with
 * Guid arrays in 6.9s. Without includeGuids=1 there is no Guid array at all, and
 * there is no server-side guid lookup (verified: ?guid=… returns size=0), so the
 * index must be built client-side.
 *
 *   type=1 movies, type=2 shows, type=4 episodes.
 *
 * Episodes are the expensive pull and most lists do not need them, so they are
 * fetched lazily — only when ids are still unmatched after movies and shows.
 */

function normTitle(s) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");
}

export function newIndex(sections = []) {
  return { byGuid: {}, byTitleYear: {}, titles: {}, episodesLoaded: false, sections };
}

/* Exported so test/match-test.mjs builds its fixtures through the same code path
 * production uses, rather than hand-rolling a lookalike that can drift. */
export function indexAdd(index, m) {
  const key = String(m.ratingKey);
  for (const g of m.Guid || []) {
    if (!g.id) continue;
    /* First writer wins: duplicate rips of the same film should not shuffle
     * which copy the playlist points at between runs. */
    if (!index.byGuid[g.id]) index.byGuid[g.id] = key;
  }
  if (m.title) {
    const tk = normTitle(m.title) + "|" + (m.year || "");
    (index.byTitleYear[tk] = index.byTitleYear[tk] || []).push(key);
  }
  index.titles[key] = { title: m.title, year: m.year, type: m.type };
}

export async function listSections(conn) {
  const r = await srvGet(conn, "/library/sections");
  return (r?.MediaContainer?.Directory || []).map((d) => ({
    key: d.key,
    type: d.type,
    title: d.title,
  }));
}

/* Builds movie + show coverage. Returns the index and the section list so the
 * caller can extend it with episodes if needed. */
export async function buildIndex(conn, onProgress) {
  const sections = await listSections(conn);
  const index = newIndex(sections);

  const movieSecs = sections.filter((s) => s.type === "movie");
  const showSecs = sections.filter((s) => s.type === "show");
  if (!movieSecs.length && !showSecs.length) {
    throw new Error("this server has no movie or TV libraries");
  }

  let done = 0;
  const total = movieSecs.length + showSecs.length;
  for (const sec of movieSecs) {
    onProgress?.(`Reading “${sec.title}”… (${++done} of ${total} libraries)`);
    const r = await srvGet(conn, `/library/sections/${sec.key}/all`, {
      type: 1,
      includeGuids: 1,
    });
    for (const m of r?.MediaContainer?.Metadata || []) indexAdd(index, m);
  }
  for (const sec of showSecs) {
    onProgress?.(`Reading “${sec.title}”… (${++done} of ${total} libraries)`);
    const r = await srvGet(conn, `/library/sections/${sec.key}/all`, {
      type: 2,
      includeGuids: 1,
    });
    for (const m of r?.MediaContainer?.Metadata || []) indexAdd(index, m);
  }
  return index;
}

/* Episodes carry their own IMDb id (verified: imdb://tt0701122 for S8E23
 * "Homer's Enemy"), so episode-level lists work — but this is the slow pull. */
export async function addEpisodes(conn, index, onProgress) {
  if (index.episodesLoaded) return index;
  const showSecs = index.sections.filter((s) => s.type === "show");
  let done = 0;
  for (const sec of showSecs) {
    onProgress?.(`Reading episodes in “${sec.title}”… (${++done} of ${showSecs.length})`);
    const r = await srvGet(conn, `/library/sections/${sec.key}/all`, {
      type: 4,
      includeGuids: 1,
    });
    for (const m of r?.MediaContainer?.Metadata || []) indexAdd(index, m);
  }
  index.episodesLoaded = true;
  return index;
}

/* Cache keyed on machineIdentifier. The index is the expensive part and the
 * service worker is killed aggressively, so it lives in storage, not memory. */
export async function loadCachedIndex(machine) {
  const s = await chrome.storage.local.get(KEY_INDEX);
  const c = s[KEY_INDEX];
  if (!c || c.machine !== machine) return null;
  return c.index;
}

export async function saveCachedIndex(machine, index) {
  await chrome.storage.local.set({
    [KEY_INDEX]: { machine, index, savedAt: Date.now() },
  });
}

export async function dropCachedIndex() {
  await chrome.storage.local.remove(KEY_INDEX);
}

/* ----------------------------------------------------------------- matching
 *
 * Match on ids. LEARNINGS.md §2, measured against a real library: matching by
 * number succeeded 50/50 where exact-title matching succeeded 47/50, and the
 * failures were punctuation, not near-misses. Title matching quietly drops items,
 * which is the worst failure mode because the playlist still looks fine.
 *
 * So: id first, always. A title+year match is only ever used when the source gave
 * us no id at all (Letterboxd list pages carry none), it must be unambiguous, and
 * every item resolved that way is reported back to the user as a guess.
 */
/* Which Plex item types may satisfy this source item.
 *
 * This exists because TMDB numbers movies and TV in separate namespaces: TMDB
 * movie 550 and TMDB show 550 are unrelated titles, and Plex stores both as a
 * bare `tmdb://550`. Matching a film list's TMDB id against a show would be a
 * silently wrong item in the playlist. IMDb ids do not have this problem (tt
 * numbers are unique across movies, series and episodes), so an imdb:// hit is
 * accepted without a type check.
 *
 * null means "no constraint known" — do not filter. */
function expectedTypes(item) {
  const k = item.tmdbType || item.kind;
  if (!k) return null;
  switch (k) {
    case "movie":
    case "tvMovie":
    case "video":
    case "short":
      return new Set(["movie"]);
    case "tv":
    case "tvSeries":
    case "tvMiniSeries":
      return new Set(["show"]);
    case "tvEpisode":
      return new Set(["episode"]);
    default:
      return null;
  }
}

function typeOk(index, key, allowed) {
  if (!allowed) return true;
  const t = index.titles[key]?.type;
  if (!t) return true; // unknown type: do not invent a reason to reject
  return allowed.has(t);
}

export function matchItems(items, index) {
  const matched = []; // { item, ratingKey, how }
  const missing = [];
  const ambiguous = [];

  for (const it of items) {
    const allowed = expectedTypes(it);
    let key = null;
    let how = null;

    /* tt ids are globally unique, so this needs no type check. */
    if (it.imdbId) {
      key = index.byGuid["imdb://" + it.imdbId] || null;
      if (key) how = "imdb";
    }
    /* TMDB ids are namespaced by type, so this one does. */
    if (!key && it.tmdbId) {
      const cand = index.byGuid["tmdb://" + it.tmdbId] || null;
      if (cand && typeOk(index, cand, allowed)) {
        key = cand;
        how = "tmdb";
      }
    }
    if (!key && it.title) {
      const hits = (index.byTitleYear[normTitle(it.title) + "|" + (it.year || "")] || []).filter(
        (k) => typeOk(index, k, allowed)
      );
      if (hits.length === 1) {
        key = hits[0];
        how = "title";
      } else if (hits.length > 1) {
        /* Two library items share a normalized title and year. Guessing here is
         * exactly the silently-wrong-item failure we refuse to make. */
        ambiguous.push(it);
        continue;
      }
    }

    if (key) matched.push({ item: it, ratingKey: key, how });
    else missing.push(it);
  }
  return { matched, missing, ambiguous };
}

/* ---------------------------------------------------------------- playlists */

function uriFor(conn, keys) {
  return (
    "server://" +
    conn.machine +
    "/com.plexapp.plugins.library/library/metadata/" +
    keys.join(",")
  );
}

/* Verified: Plex preserves the order the rating keys are sent in. That is what
 * makes a ranked playlist possible and is worth re-checking after a Plex update
 * — which is why createPlaylist's caller reads the result back. */
export async function createPlaylist(conn, title, keys, onProgress) {
  const head = keys.slice(0, BATCH);
  const tail = keys.slice(BATCH);

  const made = await srvSend(conn, "POST", "/playlists", {
    type: "video",
    title,
    smart: 0,
    uri: uriFor(conn, head),
  });
  const meta = made?.MediaContainer?.Metadata;
  if (!meta || !meta.length) throw new Error("Plex created no playlist");
  const ratingKey = meta[0].ratingKey;

  for (let i = 0; i < tail.length; i += BATCH) {
    const chunk = tail.slice(i, i + BATCH);
    onProgress?.(
      `Adding items… ${Math.min(BATCH + i + chunk.length, keys.length)} of ${keys.length}`
    );
    await srvSend(conn, "PUT", `/playlists/${ratingKey}/items`, {
      uri: uriFor(conn, chunk),
    });
  }
  return ratingKey;
}

/* Read it back instead of trusting the write. One extra request, and it is the
 * difference between "created" and "probably created". */
export async function readPlaylist(conn, ratingKey) {
  const r = await srvGet(conn, `/playlists/${ratingKey}/items`);
  return (r?.MediaContainer?.Metadata || []).map((m) => String(m.ratingKey));
}

export async function listPlaylists(conn) {
  const r = await srvGet(conn, "/playlists");
  return (r?.MediaContainer?.Metadata || []).map((p) => ({
    ratingKey: p.ratingKey,
    title: p.title,
    leafCount: p.leafCount,
  }));
}
