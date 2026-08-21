/* Panel driver for tools/store-shots.sh.
 *
 * Lives in a file rather than being inlined into the shell script for two
 * reasons, both learned the hard way:
 *
 *   1. Escaping a multi-line predicate through bash into `browse js` mangles it
 *      into a SyntaxError.
 *   2. `browse js` has its own timeout and silently returns nothing when the
 *      promise outlives it — so every wait here is short and resumable, and the
 *      shell calls it repeatedly instead of asking for one long wait.
 *
 * Each call returns quickly and reports state honestly, so the caller can refuse
 * to screenshot a half-rendered panel.
 */
self.__plexlistShot = (() => {
  const root = () => document.getElementById("plexlist-root")?.shadowRoot || null;
  const q = (sel) => {
    const r = root();
    return r ? r.querySelector(sel) : null;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isCovered = () => {
    const c = q('[data-el="cover"]');
    const g = q('[data-act="create"]');
    return !!(c && / are on /.test(c.textContent) && g && !g.disabled);
  };
  const isCreated = () => !!q('[data-act="create"]')?.classList.contains("done");

  async function poll(test, ms) {
    const stop = Date.now() + ms;
    for (;;) {
      if (test()) return true;
      if (Date.now() > stop) return false;
      await sleep(150);
    }
  }

  return {
    /* Page-load wait lives here too. An inline async IIFE passed to `browse js`
     * returns nothing at all — only a named function's result comes back — so
     * every wait in this flow has to be a method on this object. */
    async waitPage(ms) {
      const ready = () =>
        !!(
          document.getElementById("__NEXT_DATA__") ||
          document.querySelector("[data-item-slug]")
        );
      return (await poll(ready, Math.min(ms || 8000, 8000))) ? "PAGEREADY" : "PENDING";
    },

    open() {
      if (!root()) return "NOPANEL";
      self.__plexlistXssProbe = "Blade Runner";
      q(".launch").click();
      return "OPENED";
    },

    /* Short, resumable wait. Call again if it returns PENDING. */
    async waitCovered(ms) {
      return (await poll(isCovered, Math.min(ms || 8000, 8000))) ? "COVERED" : "PENDING";
    },

    /* Swap in a fictional server name. These images get published, so a real
     * one must never reach them. */
    rename(server) {
      const sel = q("#pl-server");
      if (!sel) return "NOSELECT";
      /* Keep value="0"/"1". The panel does parseInt(sel.value) to index its
       * server list, so an option without a numeric value makes that NaN and
       * the create throws before it can finish. */
      sel.innerHTML =
        `<option value="0">${server}</option><option value="1">Basement NAS</option>`;
      const c = q('[data-el="cover"]');
      if (c) c.innerHTML = c.innerHTML.split("Living Room").join(server);
      const st = q(".status");
      if (st) st.textContent = st.textContent.split("Living Room").join(server);
      return "RENAMED";
    },

    create() {
      const g = q('[data-act="create"]');
      if (!g || g.disabled) return "CANTCLICK";
      g.click();
      return "CLICKED";
    },

    async waitCreated(ms) {
      return (await poll(isCreated, Math.min(ms || 8000, 8000))) ? "CREATED" : "PENDING";
    },
  };
})();
