/* A fake chrome.* just big enough to drive content.js in a plain page.
 *
 * Loaded before src/extract.js and src/content.js by run-ui-smoke.sh so the
 * dialog can be exercised on a real list page without installing the extension
 * or touching a Plex server. It answers the same port protocol background.js
 * does, with canned data that deliberately includes misses and an ambiguous
 * item so the warning paths render.
 */
(() => {
  const listeners = { message: [], disconnect: [] };

  /* Canned answers. Coverage is derived from the items the content script
   * actually extracted, so the counts on screen reflect a real extraction. */
  const handlers = {
    state: () => ({ signedIn: true }),
    /* Deliberately generic names — this file is public, and a real server name
     * is a small personal detail with no business in a fixture. */
    servers: () => [
      { id: 0, name: "Living Room", owned: true },
      { id: 1, name: "Shared With Me", owned: false },
    ],
    coverage: (msg) => {
      const items = msg.items || [];
      const cut = Math.floor(items.length * 0.8);
      const matched = items.slice(0, cut).map((it, i) => ({
        ratingKey: String(1000 + i),
        how: i % 10 === 0 ? "title" : "imdb",
        title: it.title,
      }));
      const missing = items.slice(cut, items.length - 1).map((it) => ({ ...it }));
      /* Titles are user-controlled on both sites — anyone can name a Letterboxd
       * list entry. The panel renders into a shadow DOM inside the content
       * script's privileged world, so an escaping bug here would be a real
       * privilege escalation, not a cosmetic one. Poison the first title and let
       * run-ui-smoke.sh assert it came out as text. */
      if (missing.length) missing[0].title = self.__plexlistXssProbe;
      return {
        matched,
        missing,
        ambiguous: items.slice(items.length - 1),
        guessedByTitle: matched.filter((m) => m.how === "title").length,
        libraryMachine: "stub-machine",
      };
    },
    create: (msg) => ({
      ratingKey: "9999",
      count: msg.ratingKeys.length,
      orderMatches: true,
    }),
  };

  const port = {
    postMessage(msg) {
      const fn = handlers[msg.cmd];
      /* Async, like the real thing, so ordering bugs show up here too. */
      setTimeout(() => {
        if (!fn) {
          emit({ id: msg.id, error: `unknown command: ${msg.cmd}` });
          return;
        }
        try {
          emit({ id: msg.id, result: fn(msg) });
        } catch (e) {
          emit({ id: msg.id, error: e.message });
        }
      }, 30);
    },
    onMessage: { addListener: (f) => listeners.message.push(f) },
    onDisconnect: { addListener: (f) => listeners.disconnect.push(f) },
    disconnect() {},
  };

  function emit(msg) {
    for (const f of listeners.message) f(msg);
  }

  /* Kept on a global so the assertion and the payload cannot drift apart. */
  self.__plexlistXssProbe = '<img src=x onerror="self.__plexlistXssFired=1"><b id="pl-xss">boom</b>';
  self.__plexlistXssFired = 0;

  self.chrome = {
    runtime: {
      connect: () => port,
      onMessage: { addListener: () => {} },
      lastError: null,
    },
  };
  self.__plexlistStubPort = port;
})();
