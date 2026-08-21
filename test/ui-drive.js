/* Drives the whole dialog in ONE page evaluation and returns everything the
 * smoke test asserts on.
 *
 * One call rather than a sequence of `browse js` round trips on purpose: live
 * list pages carry ads that navigate the top frame on their own schedule, and a
 * navigation between two calls destroys the execution context mid-test
 * ("Execution context was destroyed"). Doing it in a single evaluation means the
 * page has no gap to move in.
 *
 * Defined as a global rather than self-invoking because `browse eval` does not
 * reliably return values out of longer async work; the runner calls this with
 * `browse js`.
 */
self.__plexlistDrive = async () => {
  const sr = document.getElementById("plexlist-root")?.shadowRoot;
  if (!sr) return JSON.stringify({ error: "panel root never mounted" });

  const $ = (sel) => sr.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Wait for a condition rather than a fixed delay, so this is not racing the
   * extraction and the stubbed coverage round trip. */
  async function until(fn, ms = 8000) {
    const stop = Date.now() + ms;
    for (;;) {
      let v;
      try {
        v = fn();
      } catch {
        v = false;
      }
      if (v) return true;
      if (Date.now() > stop) return false;
      await sleep(100);
    }
  }

  $(".launch").click();

  const ready = await until(() => {
    const go = $('[data-act="create"]');
    const cover = $('[data-el="cover"]');
    return go && !go.disabled && cover && /are on /.test(cover.textContent);
  });

  const before = {
    ready,
    panelVisible: !$(".wrap").hidden,
    servers: Array.from(sr.querySelectorAll("#pl-server option")).map((o) => o.textContent),
    name: $("#pl-name") ? $("#pl-name").value : null,
    coverage: $('[data-el="cover"]') ? $('[data-el="cover"]').textContent.replace(/\s+/g, " ").trim() : null,
    createLabel: $('[data-act="create"]') ? $('[data-act="create"]').textContent : null,
    createDisabled: $('[data-act="create"]') ? $('[data-act="create"]').disabled : null,
  };

  /* A hostile list-entry title must render as text, never as markup. */
  const xss = {
    fired: self.__plexlistXssFired,
    injectedNode: !!sr.querySelector("#pl-xss"),
    injectedImg: !!sr.querySelector("img"),
    renderedAsText: ($('[data-el="cover"]')?.textContent || "").includes("onerror"),
  };

  if (before.createDisabled === false) $('[data-act="create"]').click();
  await until(() => $('[data-act="create"]')?.classList.contains("done"));

  const go = $('[data-act="create"]');
  const after = {
    createLabel: go ? go.textContent : null,
    createDisabled: go ? go.disabled : null,
    parked: go ? go.classList.contains("done") : false,
    againShown: !!sr.querySelector('[data-act="again"]') && !sr.querySelector('[data-act="again"]').hidden,
    status: $(".status").textContent,
  };

  /* "Leaves no mess": the extension must own exactly one node in the host page,
   * everything else sealed inside its shadow root. */
  const footprint = {
    rootsInPage: document.querySelectorAll("#plexlist-root").length,
    strayLightDomNodes: document.querySelectorAll('[class^="plex-"], [class^="plexlist"]').length,
    pageStyleSheetsAdded: Array.from(document.styleSheets).filter((s) => {
      try {
        return (s.ownerNode?.textContent || "").includes(".plexwrap") ||
               (s.ownerNode?.textContent || "").includes("data-act=");
      } catch {
        return false;
      }
    }).length,
    localStorageKeys: Object.keys(localStorage).filter((k) => /plex/i.test(k)),
    sessionStorageKeys: Object.keys(sessionStorage).filter((k) => /plex/i.test(k)),
    cookieMentionsPlex: /plex/i.test(document.cookie),
  };

  return JSON.stringify({ before, xss, after, footprint }, null, 2);
};
