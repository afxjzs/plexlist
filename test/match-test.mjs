/* Unit tests for the matcher in src/plex.js.
 *
 *   node test/match-test.mjs
 *
 * Matching is where a bug is invisible: a wrong item still produces a playlist
 * that looks fine. These cases exist to make the dangerous ones loud.
 *
 * Fixtures are built through the exported newIndex/indexAdd, the same code path
 * buildIndex uses, so a change to the index shape breaks these too.
 */
import { newIndex, indexAdd, matchItems } from "../src/plex.js";

let failed = 0;
let ran = 0;

function t(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || "value"}: expected ${b}, got ${a}`);
}

/* A small library standing in for a real one. */
function library() {
  const ix = newIndex();
  indexAdd(ix, {
    ratingKey: 101,
    title: "The Shawshank Redemption",
    year: 1994,
    type: "movie",
    Guid: [{ id: "imdb://tt0111161" }, { id: "tmdb://278" }],
  });
  indexAdd(ix, {
    ratingKey: 102,
    title: "Amélie",
    year: 2001,
    type: "movie",
    Guid: [{ id: "imdb://tt0211915" }],
  });
  indexAdd(ix, {
    ratingKey: 103,
    title: "WALL·E",
    year: 2008,
    type: "movie",
    Guid: [],
  });
  /* Same TMDB number as Shawshank but in the TV namespace — the collision the
   * type check exists to stop. */
  indexAdd(ix, {
    ratingKey: 201,
    title: "Some Series",
    year: 2015,
    type: "show",
    Guid: [{ id: "tmdb://278" }],
  });
  /* Two library items with the same normalized title and year. */
  indexAdd(ix, { ratingKey: 301, title: "The Thing", year: 1982, type: "movie", Guid: [] });
  indexAdd(ix, { ratingKey: 302, title: "The Thing", year: 1982, type: "movie", Guid: [] });
  return ix;
}

const ix = library();

console.log("matchItems");

t("matches on IMDb id", () => {
  const r = matchItems([{ imdbId: "tt0111161", kind: "movie" }], ix);
  eq(r.matched.length, 1, "matched count");
  eq(r.matched[0].ratingKey, "101", "ratingKey");
  eq(r.matched[0].how, "imdb", "how");
});

t("matches on TMDB id when the type agrees", () => {
  const r = matchItems([{ tmdbId: "278", tmdbType: "movie" }], ix);
  eq(r.matched.length, 1, "matched count");
  eq(r.matched[0].ratingKey, "101", "ratingKey");
  eq(r.matched[0].how, "tmdb", "how");
});

/* The dangerous one. TMDB numbers movies and TV separately, and Plex stores both
 * as a bare tmdb://278. Without the type check this silently returns the show. */
t("refuses a TMDB id that resolves to the wrong namespace", () => {
  const showOnly = newIndex();
  indexAdd(showOnly, {
    ratingKey: 201,
    title: "Some Series",
    year: 2015,
    type: "show",
    Guid: [{ id: "tmdb://278" }],
  });
  const r = matchItems([{ tmdbId: "278", tmdbType: "movie", title: "Nope", year: 1999 }], showOnly);
  eq(r.matched.length, 0, "matched count");
  eq(r.missing.length, 1, "missing count");
});

t("matches on title and year when no id is available", () => {
  const r = matchItems([{ title: "Amelie", year: 2001, kind: "movie" }], ix);
  eq(r.matched.length, 1, "matched count");
  eq(r.matched[0].ratingKey, "102", "ratingKey");
  eq(r.matched[0].how, "title", "how");
});

t("normalizes punctuation when matching titles", () => {
  const r = matchItems([{ title: "WALL-E", year: 2008, kind: "movie" }], ix);
  eq(r.matched.length, 1, "matched count");
  eq(r.matched[0].ratingKey, "103", "ratingKey");
});

t("reports an ambiguous title instead of guessing", () => {
  const r = matchItems([{ title: "The Thing", year: 1982, kind: "movie" }], ix);
  eq(r.matched.length, 0, "matched count");
  eq(r.ambiguous.length, 1, "ambiguous count");
  eq(r.missing.length, 0, "missing count");
});

t("does not match a film against a show of the same name", () => {
  const r = matchItems([{ title: "Some Series", year: 2015, kind: "movie" }], ix);
  eq(r.matched.length, 0, "matched count");
  eq(r.missing.length, 1, "missing count");
});

t("a wrong year is a miss, not a match", () => {
  const r = matchItems([{ title: "Amelie", year: 2002, kind: "movie" }], ix);
  eq(r.matched.length, 0, "matched count");
  eq(r.missing.length, 1, "missing count");
});

t("id wins over title when both are present", () => {
  const r = matchItems([{ imdbId: "tt0111161", title: "The Thing", year: 1982 }], ix);
  eq(r.matched.length, 1, "matched count");
  eq(r.matched[0].ratingKey, "101", "ratingKey");
  eq(r.matched[0].how, "imdb", "how");
});

/* Order is the whole point of a ranked list. */
t("preserves input order", () => {
  const r = matchItems(
    [
      { imdbId: "tt0211915" },
      { imdbId: "tt0111161" },
      { title: "WALL-E", year: 2008, kind: "movie" },
    ],
    ix
  );
  eq(
    r.matched.map((m) => m.ratingKey),
    ["102", "101", "103"],
    "order"
  );
});

t("unknown items land in missing, never dropped", () => {
  const r = matchItems([{ imdbId: "tt9999999" }, { imdbId: "tt0111161" }], ix);
  eq(r.matched.length, 1, "matched count");
  eq(r.missing.length, 1, "missing count");
  eq(r.matched.length + r.missing.length + r.ambiguous.length, 2, "nothing lost");
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
