/* PlexList content script.
 *
 * Two jobs, and only these two:
 *   1. Read the list off the page the user is actually looking at.
 *   2. Host the dialog.
 *
 * All Plex traffic happens in the service worker. This script never sees the
 * Plex token.
 *
 * Why read the page instead of fetching it server-side: IMDb blocks automated
 * fetches outright (verified 2026-08-20 — curl gets HTTP 202 with an empty body,
 * headless Chromium gets 403 with a 49-byte document). Running as a content
 * script in the user's own logged-in browser means the page is already rendered.
 */
(() => {
  "use strict";
  if (window.__plexlistLoaded) return;
  window.__plexlistLoaded = true;

  const SITE = location.hostname.endsWith("letterboxd.com")
    ? "letterboxd"
    : location.hostname.endsWith("imdb.com")
      ? "imdb"
      : null;
  if (!SITE) return;

  /* Above this many unmatched Letterboxd films, resolving each one costs a page
   * fetch apiece, so it is reported instead of silently hammering the site. */
  const ENRICH_AUTO_LIMIT = 120;

  /* ==================================================================== utils */

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  const fmtInt = (n) => Number(n).toLocaleString("en-US");

  /* Extraction lives in extract.js, loaded as a content script just before
   * this one and sharing its isolated world. */
  const EX = self.PlexListExtract;
  if (!EX) throw new Error("PlexList: extract.js did not load before content.js");

  const looksLikeList = () => EX.looksLikeList(SITE, location.pathname);
  const extract = (onProgress) => EX.extract(onProgress);

  /* ================================================================== the UI */

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .launch {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 16px; border-radius: 999px; border: 0;
    background: #e5a00d; color: #1b1b1b; font-size: 14px; font-weight: 700;
    cursor: pointer; box-shadow: 0 6px 22px rgba(0,0,0,.35);
  }
  .launch:hover { filter: brightness(1.07); }
  .wrap {
    position: fixed; inset: 0; z-index: 2147483001;
    background: rgba(0,0,0,.62); display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .wrap[hidden] { display: none; }
  .box {
    position: relative; width: 100%; max-width: 520px; max-height: 88vh; overflow: auto;
    background: #1c1d20; color: #eceef1; border: 1px solid #33363c; border-radius: 14px;
    padding: 22px 24px 20px; box-shadow: 0 20px 60px rgba(0,0,0,.5);
  }
  h3 { margin: 0 0 4px; font-size: 18px; letter-spacing: -.01em; }
  .lede { margin: 0 0 16px; color: #a2a8b2; font-size: 13px; line-height: 1.5; }
  .x {
    position: absolute; top: 12px; right: 14px; background: none; border: 0;
    color: #7e8590; font-size: 22px; line-height: 1; cursor: pointer;
  }
  .x:hover { color: #eceef1; }
  label.fl {
    display: block; font-size: 11px; font-weight: 800; letter-spacing: .08em;
    text-transform: uppercase; color: #8b919b; margin: 14px 0 6px;
  }
  input[type=text], select {
    width: 100%; padding: 9px 11px; border-radius: 8px; border: 1px solid #3a3e45;
    background: #141518; color: #eceef1; font-size: 14px;
  }
  input[type=text]:focus, select:focus { outline: none; border-color: #e5a00d; }
  /* The native select arrow sits hard against the right border and ignores
     padding-right, so it never lines up with the 11px inset the text gets on the
     left. Draw our own and position it to match. */
  select {
    appearance: none; -webkit-appearance: none;
    padding-right: 34px;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'><path d='M1 1.5 L6 6.5 L11 1.5' fill='none' stroke='%238b919b' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat;
    background-position: right 11px center;
    background-size: 12px 8px;
  }
  .go {
    width: 100%; margin-top: 18px; padding: 11px 14px; border: 0; border-radius: 9px;
    background: #e5a00d; color: #1b1b1b; font-size: 14px; font-weight: 800; cursor: pointer;
  }
  .go:hover:not(:disabled) { filter: brightness(1.07); }
  .go:disabled { opacity: .5; cursor: default; filter: none; }
  .go.done { background: none; border: 1px solid rgba(125,220,143,.5); color: #7ddc8f; opacity: 1; }
  .again {
    display: block; width: 100%; margin-top: 9px; padding: 7px; background: none;
    border: 1px solid #3a3e45; border-radius: 8px; color: #a2a8b2; font-size: 13px; cursor: pointer;
  }
  .again[hidden] { display: none; }
  .count {
    margin-top: 14px; padding: 11px 13px; border: 1px solid #33363c; border-radius: 9px;
    background: #17181b; font-size: 13px; line-height: 1.5; color: #c8ccd3;
  }
  .count b { color: #eceef1; }
  .count.warn { border-color: rgba(255,170,90,.4); background: rgba(255,170,90,.07); }
  .warnblock {
    display: block; margin-top: 10px; padding-top: 10px; border-top: 1px solid #33363c;
    color: #f0b27a;
  }
  .warnblock b { color: #ffd0a4; }
  /* Each warning is its own line. Run together as one paragraph they read as a
     wall of text and the individual counts stop registering. */
  .warnitem { display: flex; gap: 8px; }
  .warnitem + .warnitem { margin-top: 7px; }
  .warnitem::before {
    content: "•"; flex: none; color: #8a6a45; line-height: inherit;
  }
  .egs {
    display: block; margin-top: 3px; color: #b99b7d; font-size: 12.5px;
    word-break: break-word;
  }
  .status { margin: 14px 0 0; font-size: 13px; line-height: 1.5; min-height: 1em; color: #a2a8b2; }
  .status.err { color: #ff8f7a; }
  .status.ok { color: #7ddc8f; }
  .foot { margin: 16px 0 0; font-size: 11.5px; color: #7e8590; line-height: 1.5; }
  .foot button { background: none; border: 0; color: #a2a8b2; font: inherit; cursor: pointer; text-decoration: underline; padding: 0; }
  `;

  let host, root, els;
  let state = {
    port: null,
    servers: null,
    listing: null, // { items, declaredTotal, source, notes, truncated }
    coverage: null,
    seq: 0,
    busy: false,
  };

  function buildUI() {
    host = document.createElement("div");
    host.id = "plexlist-root";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const launch = document.createElement("button");
    launch.className = "launch";
    launch.type = "button";
    launch.textContent = "Save to Plex";
    launch.addEventListener("click", open);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="box" role="dialog" aria-modal="true" aria-labelledby="pl-h">
        <button type="button" class="x" aria-label="Close">&times;</button>
        <h3 id="pl-h">Save to Plex</h3>
        <p class="lede"></p>
        <div class="body"></div>
        <p class="status" role="status" aria-live="polite"></p>
        <p class="foot"></p>
      </div>`;

    root.appendChild(launch);
    root.appendChild(wrap);
    document.documentElement.appendChild(host);

    els = {
      launch,
      wrap,
      box: wrap.querySelector(".box"),
      lede: wrap.querySelector(".lede"),
      body: wrap.querySelector(".body"),
      status: wrap.querySelector(".status"),
      foot: wrap.querySelector(".foot"),
    };
    wrap.querySelector(".x").addEventListener("click", close);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !wrap.hidden) close();
    });
  }

  function setStatus(msg, kind) {
    els.status.textContent = msg || "";
    els.status.className = "status" + (kind ? " " + kind : "");
  }

  /* ---------------------------------------------------------- worker bridge */

  let reqId = 0;
  const inflight = new Map();

  function connectPort() {
    if (state.port) return state.port;
    const port = chrome.runtime.connect({ name: "plexlist" });

    port.onMessage.addListener((msg) => {
      if (msg.evt === "progress") {
        setStatus(msg.text, "busy");
        return;
      }
      if (msg.id == null) return;
      const p = inflight.get(msg.id);
      if (!p) return;
      inflight.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });

    /* A dropped worker must not leave callers hanging forever. */
    port.onDisconnect.addListener(() => {
      state.port = null;
      const err = new Error(
        chrome.runtime.lastError?.message || "the extension worker disconnected"
      );
      for (const [, p] of inflight) p.reject(err);
      inflight.clear();
    });

    state.port = port;
    return port;
  }

  function send(cmd, payload) {
    const port = connectPort();
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      inflight.set(id, { resolve, reject });
      port.postMessage({ id, cmd, ...payload });
    });
  }

  /* ------------------------------------------------------------- open/close */

  async function open() {
    els.wrap.hidden = false;
    setStatus("");
    try {
      const st = await send("state", {});
      if (st.signedIn) await showSignedIn();
      else showSignedOut();
    } catch (e) {
      showSignedOut();
      setStatus(`Could not reach the extension worker: ${e.message}`, "err");
    }
  }

  function close() {
    els.wrap.hidden = true;
  }

  /* --------------------------------------------------------------- signed out */

  function showSignedOut() {
    els.lede.textContent =
      "Turn this list into a playlist on your own Plex server, in the order shown here.";
    els.body.innerHTML = `
      <button type="button" class="go" data-act="signin">Sign in with Plex</button>
      <p class="count">A Plex tab opens for you to approve access. Your token is stored
      in this browser only and is sent straight to Plex — this extension has no server
      to send it to.</p>`;
    els.foot.innerHTML = "";
    els.body.querySelector('[data-act="signin"]').addEventListener("click", doSignIn);
  }

  async function doSignIn() {
    setStatus("Opening Plex sign-in…", "busy");
    try {
      await send("signin", {});
      setStatus("Signed in.", "ok");
      await showSignedIn();
    } catch (e) {
      setStatus(`Sign-in failed: ${e.message}`, "err");
    }
  }

  async function doSignOut() {
    await send("signout", {});
    state.servers = null;
    state.coverage = null;
    setStatus("");
    showSignedOut();
  }

  /* ---------------------------------------------------------------- signed in */

  /* The list's own name, taken from the page data rather than document.title —
   * both sites bolt branding onto the title, and Letterboxd adds the author. */
  function defaultName() {
    return (state.listing && state.listing.listName) || "Imported list";
  }

  async function showSignedIn() {
    els.lede.textContent =
      "Turn this list into a playlist on your own Plex server, in the order shown here.";
    els.body.innerHTML = `
      <label class="fl" for="pl-server">Your Plex server</label>
      <select id="pl-server"><option>Loading your servers…</option></select>
      <label class="fl" for="pl-name">Name this playlist</label>
      <input type="text" id="pl-name" autocomplete="off" />
      <div class="count" data-el="cover">Reading this page…</div>
      <button type="button" class="go" data-act="create" disabled>Create playlist</button>`;
    els.foot.innerHTML = `Signed in to Plex. <button type="button" data-act="signout">Sign out</button>`;
    els.foot.querySelector('[data-act="signout"]').addEventListener("click", doSignOut);

    const nameEl = els.body.querySelector("#pl-name");
    nameEl.addEventListener("input", () => {
      nameEl.dataset.edited = "1";
      resetCreate();
    });

    const sel = els.body.querySelector("#pl-server");
    sel.addEventListener("change", checkCoverage);
    els.body.querySelector('[data-act="create"]').addEventListener("click", doCreate);

    /* Read the page first — it is local and fast, and its result is the same for
     * every server. */
    if (!state.listing) {
      try {
        state.listing = await extract((t) => setStatus(t, "busy"));
      } catch (e) {
        cover().className = "count warn";
        cover().innerHTML = `<span class="warnblock">Could not read this page: ${esc(e.message)}</span>`;
        setStatus("", "");
        return;
      }
    }
    /* Now that the list has been read we know its real name. Never overwrite
     * something the user has already typed. */
    if (!nameEl.dataset.edited) nameEl.value = defaultName();
    renderListingSummary();

    setStatus("Finding your servers…", "busy");
    try {
      state.servers = await send("servers", {});
      sel.innerHTML = state.servers
        .map((s, i) => `<option value="${i}">${esc(s.name)}${s.owned ? "" : " (shared)"}</option>`)
        .join("");
      setStatus("");
      await checkCoverage();
    } catch (e) {
      sel.innerHTML = "<option>none found</option>";
      setStatus(`Could not list your servers: ${e.message}`, "err");
    }
  }

  const cover = () => els.body.querySelector('[data-el="cover"]');

  /* The count in front of the user must be the count that will land. Reporting
   * a short read as if it were the whole list is the exact failure this project
   * kept running into. */
  function renderListingSummary() {
    const L = state.listing;
    const box = cover();
    let html = `Read <b>${fmtInt(L.items.length)}</b> titles from this page, in list order.`;
    const problems = [];
    if (L.declaredTotal && L.declaredTotal !== L.items.length) {
      problems.push(
        `This list says it has <b>${fmtInt(L.declaredTotal)}</b> items but only ` +
          `<b>${fmtInt(L.items.length)}</b> could be read.`
      );
    }
    for (const n of L.notes) problems.push(esc(n));
    if (problems.length) {
      html += `<span class="warnblock">${problems
        .map((p) => `<span class="warnitem"><span>${p}</span></span>`)
        .join("")}</span>`;
      box.className = "count warn";
    } else {
      box.className = "count";
    }
    box.innerHTML = html;
  }

  async function checkCoverage() {
    const sel = els.body.querySelector("#pl-server");
    const go = els.body.querySelector('[data-act="create"]');
    const idx = parseInt(sel.value, 10);
    const server = state.servers && state.servers[idx];
    if (!server || !state.listing) return;

    go.disabled = true;
    state.coverage = null;
    resetCreate();

    /* Switching servers leaves the previous lookup in flight. Stamp each check
     * and discard anything that returns after a newer one started, or a slow
     * reply for the old server overwrites the new server's result. */
    const seq = ++state.seq;
    const stale = () => seq !== state.seq;

    try {
      let items = state.listing.items;
      let cov = await send("coverage", { serverId: idx, items });
      if (stale()) return;

      /* Letterboxd list pages carry no ids, so the first pass matched on
       * title+year. Anything that missed or came back ambiguous gets its real
       * TMDB/IMDb id read off its film page, then matched again properly. */
      if (SITE === "letterboxd") {
        const needs = [...cov.missing, ...cov.ambiguous].filter((i) => i.slug);
        if (needs.length) {
          if (needs.length > ENRICH_AUTO_LIMIT) {
            cov.enrichSkipped = needs.length;
          } else {
            const { resolved, failures } = await EX.lbEnrich(needs, (t) =>
              setStatus(t, "busy")
            );
            if (stale()) return;
            if (resolved.size) {
              items = items.map((i) => resolved.get(i.slug) || i);
              cov = await send("coverage", { serverId: idx, items });
              if (stale()) return;
            }
            if (failures.length) cov.enrichFailures = failures.length;
          }
        }
      }

      state.coverage = { ...cov, items };
      renderCoverage(server);
      go.disabled = cov.matched.length === 0;
      setStatus(
        cov.matched.length ? "" : `None of these titles are on ${server.name}.`,
        cov.matched.length ? "" : "err"
      );
    } catch (e) {
      if (stale()) return;
      cover().className = "count warn";
      cover().innerHTML = `<span class="warnblock">Could not read that library: ${esc(e.message)}</span>`;
      setStatus("Pick another server, or check it is reachable.", "err");
    }
  }

  function renderCoverage(server) {
    const L = state.listing;
    const c = state.coverage;
    const box = cover();
    const have = c.matched.length;
    const total = L.items.length;

    let html =
      `<b>${fmtInt(have)}</b> of the <b>${fmtInt(total)}</b> titles read from this page ` +
      `are on ${esc(server.name)}, and will be added in this order.`;

    const warn = [];

    if (L.declaredTotal && L.declaredTotal !== total) {
      warn.push(
        `<b>This list declares ${fmtInt(L.declaredTotal)} items but only ${fmtInt(total)} ` +
          `could be read</b> — the playlist can only contain what was read.`
      );
    }
    for (const n of L.notes) warn.push(esc(n));

    if (c.missing.length) {
      const eg = c.missing.slice(0, 3).map((m) => m.title || m.imdbId || m.slug);
      /* Examples go on their own line: titles are long, and inlining them pushed
       * the count that matters off the start of the sentence. */
      warn.push(
        `<b>${fmtInt(c.missing.length)} ${c.missing.length === 1 ? "title is" : "titles are"} ` +
          `not in that library and will be skipped.</b>` +
          `<span class="egs">${esc(eg.join("; "))}` +
          (c.missing.length > 3 ? `, and ${fmtInt(c.missing.length - 3)} more` : "") +
          `</span>`
      );
    }
    if (c.ambiguous.length) {
      warn.push(
        `<b>${fmtInt(c.ambiguous.length)} could not be pinned to one library item</b> ` +
          `(same title and year appears more than once) and will be skipped rather than guessed.`
      );
    }
    if (c.guessedByTitle) {
      warn.push(
        `<b>${fmtInt(c.guessedByTitle)} matched on title and year rather than an id.</b> ` +
          `Those are the ones to spot-check.`
      );
    }
    if (c.enrichSkipped) {
      warn.push(
        `${fmtInt(c.enrichSkipped)} unmatched films were left as-is rather than fetching ` +
          `that many Letterboxd pages.`
      );
    }
    if (c.enrichFailures) {
      warn.push(`${fmtInt(c.enrichFailures)} Letterboxd lookups failed.`);
    }

    if (warn.length) {
      html += `<span class="warnblock">${warn
        .map((w) => `<span class="warnitem"><span>${w}</span></span>`)
        .join("")}</span>`;
      box.className = "count warn";
    } else {
      box.className = "count";
    }
    box.innerHTML = html;
  }

  /* ------------------------------------------------------------------ create */

  async function doCreate() {
    const go = els.body.querySelector('[data-act="create"]');
    const sel = els.body.querySelector("#pl-server");
    const idx = parseInt(sel.value, 10);
    const server = state.servers[idx];
    const title = els.body.querySelector("#pl-name").value.trim();

    if (!title) {
      setStatus("Give the playlist a name first.", "err");
      return;
    }
    if (!state.coverage || !state.coverage.matched.length) {
      setStatus("Nothing to add: none of these titles are on that server.", "err");
      return;
    }

    go.disabled = true;
    go.textContent = "Creating…";
    const keys = state.coverage.matched.map((m) => m.ratingKey);
    setStatus(`Creating “${title}” with ${fmtInt(keys.length)} items…`, "busy");

    try {
      const res = await send("create", { serverId: idx, title, ratingKeys: keys });
      let msg = `Created “${title}” with ${fmtInt(res.count)} item${res.count === 1 ? "" : "s"} on ${server.name}.`;
      const skipped = state.coverage.missing.length + state.coverage.ambiguous.length;
      if (skipped) msg += ` ${fmtInt(skipped)} skipped.`;
      let kind = "ok";
      if (res.count !== keys.length) {
        msg += ` Warning: expected ${fmtInt(keys.length)}.`;
        kind = "err";
      }
      if (!res.orderMatches) {
        msg += " Warning: Plex did not keep the order sent.";
        kind = "err";
      }
      setStatus(msg, kind);
      markCreated(res.count);
    } catch (e) {
      setStatus(`Failed: ${e.message}`, "err");
      go.textContent = "Create playlist";
      go.disabled = false;
    }
  }

  /* A finished create must not look like an idle one — leaving the button live
   * and unchanged hides that anything happened and invites duplicates. */
  function markCreated(n) {
    const go = els.body.querySelector('[data-act="create"]');
    go.textContent = `Created ✓  ${fmtInt(n)} item${n === 1 ? "" : "s"} added`;
    go.disabled = true;
    go.classList.add("done");
    let again = els.body.querySelector('[data-act="again"]');
    if (!again) {
      again = document.createElement("button");
      again.type = "button";
      again.className = "again";
      again.dataset.act = "again";
      again.textContent = "Make another playlist";
      again.addEventListener("click", resetCreate);
      go.parentNode.insertBefore(again, go.nextSibling);
    }
    again.hidden = false;
  }

  function resetCreate() {
    const go = els.body.querySelector('[data-act="create"]');
    if (!go || !go.classList.contains("done")) return;
    go.textContent = "Create playlist";
    go.classList.remove("done");
    go.disabled = !(state.coverage && state.coverage.matched.length);
    const again = els.body.querySelector('[data-act="again"]');
    if (again) again.hidden = true;
    setStatus("");
  }

  /* ================================================================== bootstrap */

  if (!looksLikeList()) return;
  buildUI();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.cmd === "open-panel") open();
  });
})();
