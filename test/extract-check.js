/* Live check for src/extract.js.
 *
 * Not a unit test — the thing worth testing here is whether the selectors still
 * match the real sites, and no fixture can tell you that. Run it against a page
 * that is actually open:
 *
 *   test/run-extract-check.sh https://www.imdb.com/chart/top/
 *
 * The runner loads src/extract.js into the page first, so PlexListExtract is
 * already defined; this file only defines the check, which the runner then calls
 * with `browse js`. (Defining rather than self-invoking on purpose: `browse eval`
 * proved unreliable at returning a value out of longer async work, while
 * `browse js "self.__plexlistCheck()"` returns it every time.)
 *
 * IMDb serves 403 to headless Chromium, so the runner uses `browse --headed`.
 */
self.__plexlistCheck = async () => {
  const EX = self.PlexListExtract;
  const fail = [];
  const note = [];

  const check = (cond, msg) => {
    if (!cond) fail.push(msg);
  };

  const site = EX.detectSite();
  check(site, `detectSite() returned nothing for ${location.hostname}`);
  check(
    EX.looksLikeList(site, location.pathname),
    `looksLikeList() rejected ${location.pathname}`
  );

  const t0 = Date.now();
  const r = await EX.extract(() => {});
  const ms = Date.now() - t0;

  check(Array.isArray(r.items), "items is not an array");
  check(r.items.length > 0, "no items extracted");
  /* "IMDb Top 250 movies" genuinely is the chart's name, so only the trailing
   * site branding is a failure — not the word appearing at all. */
  check(
    r.listName && !/[-|—•]\s*(IMDb|Letterboxd)\s*$/i.test(r.listName),
    `listName is missing or still carries site branding: ${JSON.stringify(r.listName)}`
  );

  /* Ordering is the whole point of a ranked list, so assert it rather than
   * eyeballing the first few. */
  const positions = r.items.map((i) => i.position);
  const ordered = positions.every((p, i) => i === 0 || p > positions[i - 1]);
  check(ordered, "positions are not strictly increasing");

  /* Every item must carry something the matcher can actually use. */
  const unusable = r.items.filter((i) => !i.imdbId && !i.tmdbId && !(i.title && i.year));
  check(unusable.length === 0, `${unusable.length} items carry no usable identifier`);

  if (site === "imdb") {
    const bad = r.items.filter((i) => !/^tt\d+$/.test(i.imdbId || ""));
    check(bad.length === 0, `${bad.length} items have a malformed IMDb id`);
    check(
      r.source.startsWith("__NEXT_DATA__"),
      `fell back to ${r.source} — the __NEXT_DATA__ shape has changed`
    );
  }

  if (site === "letterboxd") {
    const bad = r.items.filter((i) => !i.slug);
    check(bad.length === 0, `${bad.length} items have no slug`);
    const noYear = r.items.filter((i) => !i.year).length;
    if (noYear) note.push(`${noYear} items had no parseable year`);

    /* Spot-check id resolution on the first item; this is the path that turns a
     * title match into an exact one. */
    const one = await EX.lbResolveIds(r.items[0]);
    check(
      one.tmdbId || one.imdbId,
      `could not resolve any id for ${r.items[0].slug} — film-page markup changed`
    );
    note.push(`resolved ${r.items[0].slug} -> tmdb:${one.tmdbId} imdb:${one.imdbId}`);
  }

  const dupKey = site === "imdb" ? "imdbId" : "slug";
  const uniq = new Set(r.items.map((i) => i[dupKey]));
  check(uniq.size === r.items.length, `${r.items.length - uniq.size} duplicate items`);

  if (r.declaredTotal && r.declaredTotal !== r.items.length) {
    note.push(`declaredTotal ${r.declaredTotal} != extracted ${r.items.length}`);
  }

  return JSON.stringify(
    {
      url: location.href,
      site,
      source: r.source,
      listName: r.listName,
      extracted: r.items.length,
      declaredTotal: r.declaredTotal,
      truncated: r.truncated,
      extractorNotes: r.notes,
      ms,
      first: r.items[0],
      last: r.items[r.items.length - 1],
      notes: note,
      failures: fail,
      PASS: fail.length === 0,
    },
    null,
    2
  );
};
