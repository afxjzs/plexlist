/* PlexList service worker.
 *
 * Owns every Plex request and the Plex token. The content script never sees the
 * token and never talks to a Plex server directly — it only reads the page and
 * renders the dialog.
 *
 * Extensions are not subject to page CORS, but they ARE subject to host
 * permissions, which is why an unreachable server produces an explicit
 * "grant access to all sites" message rather than a bare network error.
 */

import * as plex from "./plex.js";

/* Per-port session. MV3 kills the worker aggressively, so anything that must
 * survive that (token, client id, library index) lives in chrome.storage.local;
 * this map is only a warm cache for the life of one open dialog. */
const sessions = new Map();

function sessionFor(port) {
  let s = sessions.get(port);
  if (!s) {
    s = { servers: null, conns: new Map(), index: null, indexMachine: null };
    sessions.set(port, s);
  }
  return s;
}

/* -------------------------------------------------------------- sign-in flow */

/* Opens a tab for the user to approve the PIN, then polls until Plex hands back
 * a token. The tab is watched so closing it fails fast instead of polling into
 * a five-minute timeout. */
async function signIn(progress) {
  const pin = await plex.createPin();
  const url = await plex.authUrl(pin.code);
  const tab = await chrome.tabs.create({ url, active: true });

  let closed = false;
  const onRemoved = (id) => {
    if (id === tab.id) closed = true;
  };
  chrome.tabs.onRemoved.addListener(onRemoved);

  progress("Waiting for you to approve access in the Plex tab…");
  try {
    const token = await plex.pollPin(pin.id, {
      isCancelled: async () => closed,
    });
    await plex.setToken(token);
    /* A different account means a different library; never reuse the old index. */
    await plex.dropCachedIndex();
    if (!closed) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* Already gone. Nothing to report — the sign-in itself succeeded. */
      }
    }
    return { ok: true };
  } finally {
    chrome.tabs.onRemoved.removeListener(onRemoved);
  }
}

/* ------------------------------------------------------------ server + index */

async function getServers(session) {
  if (!session.servers) session.servers = await plex.listServers();
  /* accessToken stays in the worker. */
  return session.servers.map((s) => ({ id: s.id, name: s.name, owned: s.owned }));
}

async function getConn(session, serverId) {
  if (session.conns.has(serverId)) return session.conns.get(serverId);
  if (!session.servers) await plex.listServers().then((s) => (session.servers = s));
  const server = session.servers[serverId];
  if (!server) throw new Error("that server is no longer in your account list");
  const conn = await plex.connect(server);
  session.conns.set(serverId, conn);
  return conn;
}

async function getIndex(session, conn, progress, { withEpisodes } = {}) {
  if (session.index && session.indexMachine === conn.machine) {
    if (!withEpisodes || session.index.episodesLoaded) return session.index;
  } else {
    const cached = await plex.loadCachedIndex(conn.machine);
    if (cached) {
      session.index = cached;
      session.indexMachine = conn.machine;
      if (!withEpisodes || cached.episodesLoaded) return cached;
    }
  }

  if (!session.index || session.indexMachine !== conn.machine) {
    progress("Reading your library…");
    session.index = await plex.buildIndex(conn, progress);
    session.indexMachine = conn.machine;
  }
  if (withEpisodes && !session.index.episodesLoaded) {
    await plex.addEpisodes(conn, session.index, progress);
  }
  await plex.saveCachedIndex(conn.machine, session.index);
  return session.index;
}

/* ------------------------------------------------------------------ commands */

const commands = {
  async state() {
    return { signedIn: !!(await plex.getToken()) };
  },

  async signin(_msg, _session, progress) {
    return signIn(progress);
  },

  async signout(_msg, session) {
    await plex.clearToken();
    session.servers = null;
    session.conns.clear();
    session.index = null;
    session.indexMachine = null;
    return { ok: true };
  },

  async servers(_msg, session) {
    return getServers(session);
  },

  async coverage(msg, session, progress) {
    const conn = await getConn(session, msg.serverId);
    const items = msg.items || [];

    /* Episodes are the expensive pull, so only take it when the list actually
     * contains one. */
    const wantsEpisodes = items.some((i) => i.kind === "tvEpisode");
    let index = await getIndex(session, conn, progress, { withEpisodes: wantsEpisodes });

    let result = plex.matchItems(items, index);

    /* If ids went unmatched and we have not read episodes yet, the misses may be
     * episodes sitting in a TV library. Pay for that pull once, then re-match. */
    if (!wantsEpisodes && result.missing.length && !index.episodesLoaded) {
      const couldBeEpisode = result.missing.some((i) => !i.kind || i.kind === "tvEpisode");
      if (couldBeEpisode) {
        index = await getIndex(session, conn, progress, { withEpisodes: true });
        result = plex.matchItems(items, index);
      }
    }

    return {
      matched: result.matched.map((m) => ({
        ratingKey: m.ratingKey,
        how: m.how,
        title: m.item.title,
      })),
      missing: result.missing,
      ambiguous: result.ambiguous,
      guessedByTitle: result.matched.filter((m) => m.how === "title").length,
      libraryMachine: conn.machine,
    };
  },

  async create(msg, session, progress) {
    const conn = await getConn(session, msg.serverId);
    const keys = (msg.ratingKeys || []).map(String);
    if (!keys.length) throw new Error("nothing to add");

    const ratingKey = await plex.createPlaylist(conn, msg.title, keys, progress);

    /* Read it back rather than trusting the write. One extra request, and it is
     * the difference between "created" and "probably created". */
    progress("Verifying the playlist…");
    const got = await plex.readPlaylist(conn, ratingKey);
    return {
      ratingKey,
      count: got.length,
      orderMatches: got.length === keys.length && got.every((k, i) => k === keys[i]),
    };
  },
};

/* -------------------------------------------------------------------- wiring */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "plexlist") return;
  const session = sessionFor(port);

  port.onMessage.addListener(async (msg) => {
    const fn = commands[msg.cmd];
    if (!fn) {
      port.postMessage({ id: msg.id, error: `unknown command: ${msg.cmd}` });
      return;
    }
    const progress = (text) => {
      try {
        port.postMessage({ evt: "progress", text });
      } catch {
        /* Port closed mid-operation; the operation itself still resolves or
         * throws below, so nothing is being swallowed here. */
      }
    };
    try {
      const result = await fn(msg, session, progress);
      port.postMessage({ id: msg.id, result });
    } catch (e) {
      port.postMessage({ id: msg.id, error: e?.message || String(e) });
    }
  });

  port.onDisconnect.addListener(() => sessions.delete(port));
});

/* Clicking the toolbar icon opens the panel on a supported page. If the content
 * script is not there, say why rather than doing nothing. */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { cmd: "open-panel" });
  } catch {
    await chrome.action.setTitle({
      tabId: tab.id,
      title: "PlexList works on IMDb list/chart pages and Letterboxd lists.",
    });
  }
});
