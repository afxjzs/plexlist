/* List extraction for IMDb and Letterboxd.
 *
 * Kept separate from the UI so it can be evaluated standalone against a live
 * page (see test/extract-check.js) — these selectors are the part most likely to
 * rot, so they need to be checkable without loading the whole extension.
 *
 * Loaded as a plain content script before content.js and shares its isolated
 * world, so it exports onto a global rather than using ES modules.
 *
 * Everything below was verified against live pages on 2026-08-20. The one
 * exception is noted inline: IMDb's pagination parameter for lists longer than
 * 250 items, which is guarded at runtime rather than assumed.
 */
(() => {
  "use strict";

  const MAX_PAGES = 40;
  const ENRICH_CONCURRENCY = 4;

  function detectSite(host = location.hostname) {
    if (host.endsWith("letterboxd.com")) return "letterboxd";
    if (host.endsWith("imdb.com")) return "imdb";
    return null;
  }

  function looksLikeList(site = detectSite(), path = location.pathname) {
    if (site === "imdb") return /^\/(list\/ls\d+|chart\/[a-z_]+)/.test(path);
    if (site === "letterboxd") return /\/(list|watchlist)\//.test(path);
    return false;
  }

  /* Same-origin only, enforced here rather than at each call site.
   *
   * Two callers resolve an href taken off the page (Letterboxd's `a.next` and
   * `data-item-link`) against location.origin. A relative href resolves as you
   * would expect, but an absolute one to another host would win — and this sends
   * cookies. Pinning the origin means a hostile or hijacked page cannot use the
   * extension to make credentialed requests somewhere else. */
  async function fetchDoc(url) {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin) {
      throw new Error(`refusing to fetch ${u.origin} from ${location.origin}`);
    }
    const r = await fetch(u.toString(), { credentials: "same-origin" });
    if (!r.ok) throw new Error(`${u.pathname} returned HTTP ${r.status}`);
    return new DOMParser().parseFromString(await r.text(), "text/html");
  }

  /* The list's own name, for the default playlist name. document.title is the
   * last resort because both sites bolt their branding (and, on Letterboxd, the
   * author) onto it. Verified that og:title is clean on all four page types. */
  function pageName(doc) {
    const og = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
    if (og) return og.trim();
    const h1 = doc.querySelector("h1")?.textContent;
    if (h1) return h1.trim();
    return (doc.title || "")
      .replace(/\s*[-|—•]\s*(IMDb|Letterboxd).*$/i, "")
      .replace(/^\s*[‎‏]/, "")
      .trim();
  }

  /* ============================================================== IMDb =====
   *
   * Two page shapes, both with an authoritative __NEXT_DATA__ payload:
   *
   *   /list/ls…  props.pageProps.totalItems
   *              props.pageProps.mainColumnData.list.titleListItemSearch
   *                { total, pageInfo:{hasNextPage},
   *                  edges:[{ node:{absolutePosition},
   *                           listItem:{ id, titleText:{text}, titleType:{id},
   *                                      releaseYear:{year} } }] }
   *
   *   /chart/…   props.pageProps.pageData.chartTitles
   *                { edges:[{ currentRank, node:{ id, titleText, titleType,
   *                           releaseYear } }] }
   *
   * Reading the DOM for a[href*="/title/tt"] is deliberately NOT the primary
   * path: it over-captures recommendation rails, and the page renders
   * progressively (measured: a probe during load saw 150 of the eventual 500
   * links). A JSON-LD ItemList is the fallback if the shape above ever changes.
   */

  function imdbNextData(doc) {
    const el = doc.getElementById("__NEXT_DATA__");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      throw new Error(`IMDb page data could not be parsed: ${e.message}`);
    }
  }

  function imdbTitleToItem(t, position) {
    if (!t || !t.id) return null;
    return {
      imdbId: t.id,
      title: t.titleText?.text || null,
      year: t.releaseYear?.year ?? null,
      kind: t.titleType?.id || null, // movie | tvSeries | tvEpisode | …
      position,
    };
  }

  /* One IMDb document -> { items, declaredTotal, hasNextPage, source } */
  function imdbReadPage(doc) {
    const data = imdbNextData(doc);
    if (data) {
      const pp = data?.props?.pageProps;

      const search = pp?.mainColumnData?.list?.titleListItemSearch;
      if (search?.edges) {
        const items = search.edges
          .map((e, i) => imdbTitleToItem(e.listItem, e.node?.absolutePosition ?? i + 1))
          .filter(Boolean);
        return {
          items,
          declaredTotal: pp.totalItems ?? search.total ?? null,
          hasNextPage: !!search.pageInfo?.hasNextPage,
          listName: pp?.mainColumnData?.list?.name?.originalText || pageName(doc),
          source: "__NEXT_DATA__ (list)",
        };
      }

      const chart = pp?.pageData?.chartTitles;
      if (chart?.edges) {
        const items = chart.edges
          .map((e, i) => imdbTitleToItem(e.node, e.currentRank ?? i + 1))
          .filter(Boolean);
        return {
          items,
          declaredTotal: chart.total ?? items.length,
          hasNextPage: false, // charts are a single page
          listName: pageName(doc),
          source: "__NEXT_DATA__ (chart)",
        };
      }
    }

    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let j;
      try {
        j = JSON.parse(s.textContent);
      } catch {
        continue;
      }
      if (j?.["@type"] !== "ItemList" || !Array.isArray(j.itemListElement)) continue;
      const items = j.itemListElement
        .map((li, i) => {
          const m = (li.item?.url || "").match(/\/title\/(tt\d+)/);
          if (!m) return null;
          return {
            imdbId: m[1],
            title: li.item?.name || null,
            year: null,
            kind: null,
            position: i + 1,
          };
        })
        .filter(Boolean);
      if (items.length) {
        return {
          items,
          declaredTotal: items.length,
          hasNextPage: false,
          listName: j.name || pageName(doc),
          source: "JSON-LD (fallback)",
        };
      }
    }
    return null;
  }

  async function imdbExtract(onProgress) {
    const first = imdbReadPage(document);
    if (!first) {
      throw new Error(
        "this IMDb page does not look like a list or chart — open a /list/ or /chart/ page"
      );
    }

    const items = first.items.slice();
    const seen = new Set(items.map((i) => i.imdbId));
    const notes = [];
    let truncated = false;

    /* Verified: a same-origin fetch from the page context returns the full HTML
     * with a parseable __NEXT_DATA__.
     *
     * NOT verified: the pagination parameter for lists over 250 items — every
     * list tested fit on one page. So rather than trusting ?page=N, each fetched
     * page must actually produce new titles. If it does not, stop and say so,
     * instead of quietly returning a short list or one full of duplicates. */
    let page = 1;
    let more = first.hasNextPage;
    while (more && page < MAX_PAGES) {
      page += 1;
      onProgress?.(`Reading page ${page}…`);
      const url = new URL(location.href);
      url.searchParams.set("page", String(page));
      const next = imdbReadPage(await fetchDoc(url.toString()));
      if (!next || !next.items.length) {
        notes.push(`page ${page} returned nothing, so reading stopped there`);
        break;
      }
      const fresh = next.items.filter((i) => !seen.has(i.imdbId));
      if (!fresh.length) {
        notes.push(
          `IMDb returned page ${page} with no new titles (its pagination did not ` +
            `advance), so only the first ${items.length} could be read`
        );
        break;
      }
      for (const f of fresh) {
        seen.add(f.imdbId);
        items.push(f);
      }
      more = next.hasNextPage;
    }
    if (more && page >= MAX_PAGES) {
      truncated = true;
      notes.push(`stopped after ${MAX_PAGES} pages`);
    }

    items.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return {
      items,
      declaredTotal: first.declaredTotal,
      listName: first.listName || pageName(document),
      source: first.source,
      notes,
      truncated,
    };
  }

  /* ======================================================== Letterboxd =====
   *
   * List pages are server-rendered and not bot-protected. Each row carries:
   *
   *   data-item-slug="12-angry-men"
   *   data-item-name="12 Angry Men (1957)"
   *   data-item-link="/film/12-angry-men/"
   *   data-list-index="0"        <- GLOBAL, 0-based, continuous across pages
   *
   * Pagination is a plain <a class="next" href="…/page/2/">, 100 items per page.
   * Verified: page 2 of the top-500 list held indexes 100-199 and linked page 3.
   *
   * List pages carry no TMDB or IMDb id; individual film pages do. Note that
   * /film/{slug}/json/ is behind a Cloudflare challenge, so the HTML page is the
   * one to read.
   */

  function lbReadPage(doc) {
    const items = [];
    for (const n of doc.querySelectorAll("[data-item-slug]")) {
      const slug = n.getAttribute("data-item-slug");
      if (!slug) continue;
      const name =
        n.getAttribute("data-item-name") ||
        n.getAttribute("data-item-full-display-name") ||
        "";
      const m = name.match(/^(.*)\s+\((\d{4})\)\s*$/);
      const idxAttr = n.getAttribute("data-list-index");
      items.push({
        slug,
        link: n.getAttribute("data-item-link") || `/film/${slug}/`,
        title: m ? m[1] : name || slug,
        year: m ? Number(m[2]) : null,
        kind: "movie", // Letterboxd catalogues films only
        /* data-list-index is global and 0-based; +1 reads as a rank. Falls back
         * to DOM order for unordered lists, which omit the attribute. */
        position: idxAttr != null ? Number(idxAttr) + 1 : items.length + 1,
      });
    }
    const nextEl = doc.querySelector("a.next[href]");
    return { items, nextHref: nextEl ? nextEl.getAttribute("href") : null };
  }

  function lbDeclaredTotal(doc) {
    const meta = doc.querySelector('meta[name="description"]');
    const m = (meta?.getAttribute("content") || "").match(/^A list of ([\d,]+) films/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  }

  async function lbExtract(onProgress) {
    const first = lbReadPage(document);
    if (!first.items.length) {
      throw new Error(
        "no films found on this page — open a Letterboxd list (letterboxd.com/…/list/…)"
      );
    }

    const items = first.items.slice();
    const seen = new Set(items.map((i) => i.slug));
    const notes = [];
    let truncated = false;

    let href = first.nextHref;
    let page = 1;
    while (href && page < MAX_PAGES) {
      page += 1;
      onProgress?.(`Reading page ${page}…`);
      const next = lbReadPage(await fetchDoc(new URL(href, location.origin).toString()));
      const fresh = next.items.filter((i) => !seen.has(i.slug));
      if (!fresh.length) {
        notes.push(`page ${page} added no new films, so reading stopped there`);
        break;
      }
      for (const f of fresh) {
        seen.add(f.slug);
        items.push(f);
      }
      href = next.nextHref;
    }
    if (href && page >= MAX_PAGES) {
      truncated = true;
      notes.push(`stopped after ${MAX_PAGES} pages`);
    }

    items.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return {
      items,
      declaredTotal: lbDeclaredTotal(document),
      listName: pageName(document),
      source: "Letterboxd list markup",
      notes,
      truncated,
    };
  }

  /* Resolve one Letterboxd slug to real ids by reading its film page.
   *
   * data-tmdb-type matters: TMDB numbers movies and TV separately, so tmdb://550
   * means different titles in each namespace. It is carried through so the
   * matcher can refuse a cross-namespace hit. */
  async function lbResolveIds(item) {
    const doc = await fetchDoc(new URL(item.link, location.origin).toString());
    const tmdbEl = doc.querySelector("[data-tmdb-id]");
    const imdbMatch = (doc.body ? doc.body.innerHTML : "").match(/imdb\.com\/title\/(tt\d+)/);
    return {
      ...item,
      tmdbId: tmdbEl?.getAttribute("data-tmdb-id") || null,
      tmdbType: tmdbEl?.getAttribute("data-tmdb-type") || null, // "movie" | "tv"
      imdbId: imdbMatch ? imdbMatch[1] : null,
    };
  }

  async function lbEnrich(targets, onProgress) {
    const resolved = new Map();
    const failures = [];
    const queue = targets.slice();
    let done = 0;

    async function worker() {
      for (;;) {
        const it = queue.shift();
        if (!it) return;
        try {
          resolved.set(it.slug, await lbResolveIds(it));
        } catch (e) {
          failures.push({ slug: it.slug, message: e.message });
        }
        onProgress?.(`Looking up ${++done} of ${targets.length} films on Letterboxd…`);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(ENRICH_CONCURRENCY, targets.length) }, worker)
    );
    return { resolved, failures };
  }

  /* ================================================================ export */

  function extract(onProgress) {
    const site = detectSite();
    if (site === "imdb") return imdbExtract(onProgress);
    if (site === "letterboxd") return lbExtract(onProgress);
    return Promise.reject(new Error(`PlexList does not read ${location.hostname}`));
  }

  self.PlexListExtract = {
    detectSite,
    looksLikeList,
    extract,
    lbEnrich,
    lbResolveIds,
    /* exposed for test/extract-check.js */
    imdbReadPage,
    lbReadPage,
    lbDeclaredTotal,
  };
})();
