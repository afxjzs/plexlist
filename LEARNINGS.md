# Plex + IMDb: what I learned building the episode-ranking pages

Notes for building a Chrome extension that reads an IMDb list page and creates a Plex
playlist from it. Everything here came out of building the Simpsons and South Park
ranking pages at `doug.is/building/stuff/`, which do the same job from a different
source.

Every claim below is marked **verified** (I ran it against a live Plex server on
2026-08-20) or **unverified** (reasoned, needs checking). Don't trust the unverified
ones without testing.

---

## 1. The one thing that decides your whole design

**Plex stores IMDb ids, and you can pull them for an entire library in a single
request.** This is the finding that makes an IMDb-driven extension straightforward
instead of miserable.

```
GET {server}/library/sections/{sectionId}/all?type=1&includeGuids=1
```

**Verified:** returned all 5,879 movies in 6.9 seconds, 5,871 of them carrying a
`Guid` array:

```json
{ "title": "The 'Burbs", "ratingKey": "12345",
  "Guid": [{"id":"imdb://tt0096734"}, {"id":"tmdb://11974"}, {"id":"tvdb://5869"}] }
```

So: fetch once, build `imdb id -> ratingKey`, then every IMDb list becomes an exact
lookup. No fuzzy title matching, no year disambiguation, no "Part One" vs "(1)".

Three things to know about it:

- **Without `includeGuids=1` the listing has no `Guid` array at all.** You'd be
  forced into one full-metadata request per item. On that library that's 5,879
  requests versus 1.
- **You cannot search by guid.** *Verified:* both
  `/library/sections/{id}/all?guid=imdb://tt0701122` and
  `/library/all?guid=imdb://tt0701122` returned `size=0`. There is no server-side
  id lookup — you must build the index yourself.
- **`type=1` is movies, `type=2` is shows, `type=4` is episodes.** An IMDb list can
  mix films and TV, so you may need more than one section and more than one type.
  Episodes carry their own IMDb id (*verified:* `imdb://tt0701122` for
  S8E23 "Homer's Enemy"), so episode-level lists work too.

Batching also works if you need it: `/library/metadata/{key1,key2,key3}` accepts
comma-separated rating keys and returns all of them with `Guid` arrays (*verified*
with 5 keys).

**Cache the index.** It's the expensive part. Key it on the server's
`machineIdentifier` and re-fetch when the library's item count changes.

---

## 2. Do not match on titles

*Verified* against a real library: matching 50 episodes by season/episode number
succeeded **50/50**; matching the same 50 by exact title succeeded **47/50**.

The failures weren't near-misses, they were formatting:

| Plex | IMDb-sourced data |
|---|---|
| `Round Springfield` | `'Round Springfield` |
| `Who Shot Mr. Burns? (1)` | `Who Shot Mr. Burns? Part One` |
| `Summer of 4 Ft. 2` | `Summer of 4'2"` |

Apostrophes, part numbering, and unicode punctuation all differ. Title matching will
work for most items and then quietly drop a few — the worst failure mode, because the
playlist looks fine.

Match on IMDb id. Fall back to season/episode number for TV. Never fall back to title
without telling the user which items it guessed at.

---

## 3. Plex authentication

### Getting a token (PIN flow)

```
POST https://plex.tv/api/v2/pins?strong=true
     headers: Accept: application/json
              X-Plex-Product: <your product name>
              X-Plex-Client-Identifier: <stable per-install uuid>
```

*Verified:* returns HTTP 201 and
`{id, code, authToken: null, expiresIn: 1800, clientIdentifier, product, qr, ...}`.

Then send the user to approve it:

```
https://app.plex.tv/auth#?clientID=<clientId>
    &code=<pin.code>
    &context%5Bdevice%5D%5Bproduct%5D=<product>
```

and poll `GET https://plex.tv/api/v2/pins/{id}` (same `X-Plex-Client-Identifier`
header) until `authToken` is non-null. The PIN lasts 30 minutes.

**Unverified:** the interactive approval step. A headless browser can't click through
it, so I only exercised PIN creation and polling. The approval URL format above is
what the shipped pages use, but nobody has confirmed the round trip end to end. Test
this first — it's the one link in the chain I couldn't close.

`X-Plex-Client-Identifier` must be **stable per install**. Generate a UUID once and
persist it. Changing it orphans the authorization and shows up as a new device in the
user's Plex account every time.

### Two different tokens, and the 401 that teaches you

- The **account token** (from the PIN flow, or on macOS
  `defaults read com.plexapp.plexmediaserver PlexOnlineToken`) authenticates you to
  **plex.tv only**.
- Each server in the resources list has its **own `accessToken`**. Use that one for
  requests to that server.

*Verified:* sending the account token to a server the user doesn't own returns
**HTTP 401**. For an owned server the account token happens to work, so this bug hides
until someone points the extension at a shared server — which, for media libraries, is
extremely common. Always use the per-server `accessToken`.

### Send the token as a header

`X-Plex-Token` works as a request header (*verified:* the CORS preflight returns
`Access-Control-Allow-Headers: X-Plex-Token`, and reads and writes both succeed).
Prefer it over the `?X-Plex-Token=` query parameter, which leaks the token into
console logs, browser history, and referrers.

---

## 4. Finding and reaching servers

```
GET https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1
    headers: X-Plex-Token, X-Plex-Client-Identifier
```

Filter to `provides` containing `"server"`. Each entry has `name`, `owned`,
`accessToken`, and a `connections` array.

**Ignore the `presence` field.** *Verified:* the server holding the entire media
library reported `presence: false` while being perfectly reachable and serving
requests. I nearly reported it as offline. The only reliable test is an actual
request.

**Race the connections, don't iterate them.** *Verified:* one server advertised 16
connections, of which 15 were unroutable LAN addresses and 1 worked. Serially, at an
8-second timeout each, that's a two-minute wait; raced with `Promise.any` it's under a
second.

Confirm the connection with `GET {uri}/` and read `machineIdentifier` from the
response — you need it for playlist creation anyway.

---

## 5. Creating the playlist

```
POST {server}/playlists
  ?type=video
  &title=<name>
  &smart=0
  &uri=server://<machineIdentifier>/com.plexapp.plugins.library/library/metadata/<k1,k2,k3>
```

- ***Verified:* order is preserved exactly as the rating keys are sent.** I passed five
  episodes deliberately scrambled and they came back in that order. This is what makes
  a "ranked" playlist possible, and it's worth re-checking after any Plex update.
- Append with `PUT {server}/playlists/{id}/items?uri=<same server:// form>`.
- Delete with `DELETE {server}/playlists/{id}`.
- `GET {server}/playlists` lists them; `GET {server}/playlists/{id}/items` reads one.

I batch **150 keys per request** and append the rest. That was a conservative guess to
keep URLs short — I never found the real limit, so treat 150 as untested-but-safe
rather than a known maximum.

**Read the playlist back after creating it** and compare the item count and order to
what you sent. It's one extra request and it's the difference between "created" and
"probably created".

---

## 6. The IMDb side

**IMDb blocks automated browsers.** *Verified* three ways on 2026-08-20: `curl` with a
real User-Agent gets **HTTP 202 with a zero-byte body**; headless Chromium gets **403**
with a 49-byte document; Playwright likewise. What *does* work is **`browse --headed`**
— a visible Chromium with `navigator.webdriver` masked renders the page in full (3.7MB,
500 `tt` links). Use that for any IMDb work, including the extractor tests.

This is the argument for the extension being an extension. Running as a content script
in the user's real, logged-in browser means the page is already rendered and there's
nothing to fetch. Don't build a scraper that fetches IMDb server-side; it will be
blocked, and working around that is both fragile and rude.

### Don't scrape the DOM — read `__NEXT_DATA__`

IMDb is Next.js and ships the whole list as JSON in `#__NEXT_DATA__`. *Verified* shapes:

```
/list/ls…   props.pageProps.totalItems                  <- declared total
            props.pageProps.mainColumnData.list.name.originalText
            props.pageProps.mainColumnData.list.titleListItemSearch
              { total, pageInfo:{hasNextPage, endCursor},
                edges:[{ node:{absolutePosition},
                         listItem:{ id, titleText:{text}, titleType:{id},
                                    releaseYear:{year}, series } }] }

/chart/…    props.pageProps.pageData.chartTitles
              { edges:[{ currentRank, node:{ id, titleText, titleType,
                         releaseYear } }] }
```

That gives the `tt` id, the display title, the year, the **rank**, and the **type**
(`movie` / `tvSeries` / `tvEpisode`) without a single CSS selector. A JSON-LD
`ItemList` is also present on both page types and is a good fallback.

**Do not use `a[href*="/title/tt"]` as the primary path.** Two measured reasons: it
over-captures recommendation rails, and the page renders progressively — a probe taken
during load saw **150 of the eventual 500** links. That race is exactly how you ship a
playlist containing the first chunk of a list.

- *Verified:* a **same-origin `fetch` from the page context returns full HTML with a
  parseable `__NEXT_DATA__`** — so a content script can page through a list itself.
- *Unverified:* the pagination parameter for lists over 250 items. Every list tested fit
  on one page (`hasNextPage: false`), and `?page=2` on a 250-item list clamps back to
  page 1. Don't trust `?page=N` blindly — require each fetched page to yield new ids and
  stop loudly if it doesn't.
- Lists mix films and episodes, and `titleType.id` tells you which, so you can skip the
  expensive Plex episode pull unless a list actually needs it.

---

## 6b. The Letterboxd side

Much easier than IMDb: **no bot protection at all** on list and film pages (*verified:*
plain `curl` gets HTTP 200 with complete HTML). Only `/film/{slug}/json/` is behind a
Cloudflare challenge — avoid that endpoint and read the HTML page instead.

List rows carry everything except an id:

```html
<div data-item-slug="12-angry-men"
     data-item-name="12 Angry Men (1957)"
     data-item-link="/film/12-angry-men/"
     data-list-index="0">          <!-- GLOBAL, 0-based, continuous across pages -->
```

- **`data-list-index` is global, not per-page.** *Verified:* page 2 of the 500-film list
  held indexes 100–199. It is the ordering key; no need to track page offsets.
- Pagination is a plain `<a class="next" href="…/page/2/">`, 100 items per page.
- The declared total lives only in `meta[name="description"]` — `"A list of 500 films…"`.
- **List pages carry no TMDB or IMDb id.** Film pages do: `data-tmdb-id`,
  `data-tmdb-type`, and an `imdb.com/title/tt…` link (*verified:* `12-angry-men` →
  `tmdb:389`, `tt0050083`).

So Letterboxd needs a two-stage match: title+year against the Plex index first, then
resolve only the misses and ambiguities by fetching their film pages. Resolving all 500
up front is hundreds of requests for no gain.

**Watch the TMDB namespace.** TMDB numbers movies and TV separately, and Plex stores
both as a bare `tmdb://<n>`, so `tmdb://550` means different titles depending on which
namespace it came from. Matching a film list's TMDB id without checking the Plex item's
`type` will silently attach the wrong item. IMDb `tt` ids don't have this problem.

---

## 7. Extension-specific notes

All *unverified* — I built a web page, not an extension. Flagging what I'd check first:

- **CORS stops mattering.** With `host_permissions` for `https://plex.tv/*` and the
  server's origin, an extension's fetches aren't subject to page CORS. The web page
  needed CORS to be open; you probably won't.
- **Private Network Access: the extension CAN reach a server with no remote access.**
  *Verified 2026-08-21* against a Plex server that has Remote Access switched off — the
  extension signed in, listed it, read its library and matched titles against a list.
  For a web page on a public origin Chrome blocks private addresses outright
  (*verified*, and why the doug.is page skips LAN connections), so this is the single
  biggest functional difference between the two: the extension works for users whose
  Plex is not reachable from the internet, and the web page never can.
- Store the token in `chrome.storage.local`, not `localStorage`, and never in a
  content script's page context.
- Do the Plex work in the background service worker; use the content script only to
  read the DOM and hand back ids.
- MV3 service workers are killed aggressively. Keep the library index in
  `chrome.storage.local` rather than in memory.

---

## 8. Gotchas worth carrying over

- **Report what didn't match, prominently, before creating.** The single most useful
  thing in the web version is telling the user "142 of 150 episodes are on your server,
  8 will be skipped" *before* they commit, rather than after. A playlist that silently
  contains 60% of what you asked for is worse than an error.
- **Never let a status line outrun reality.** Read back, compare, and say so if the
  numbers disagree.
- **A finished action must not look like an idle one.** Leaving a "Create playlist"
  button live and unchanged after a successful create hides that anything happened and
  invites duplicates.
- **Guard against stale async responses.** Switching servers mid-lookup let a slow
  reply for the old server overwrite the new one's result. Stamp each request and
  discard superseded replies.
- **Verify in the environment that matters.** Two real bugs in this project were
  invisible on `localhost` and only appeared from a public HTTPS origin. If you can't
  deploy to test, serve your local build at the production URL via request
  interception — that gives the page a genuinely public origin and the browser applies
  the real rules.

---

## 9. Verified endpoint reference

| Purpose | Request |
|---|---|
| Create auth PIN | `POST https://plex.tv/api/v2/pins?strong=true` |
| Poll PIN | `GET https://plex.tv/api/v2/pins/{id}` |
| List servers | `GET https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1` |
| Confirm connection | `GET {server}/` → `machineIdentifier` |
| List libraries | `GET {server}/library/sections` |
| **Library + IMDb ids** | `GET {server}/library/sections/{id}/all?type=1&includeGuids=1` |
| Filter by title | `GET {server}/library/sections/{id}/all?type=2&title=<name>` |
| All episodes of a show | `GET {server}/library/metadata/{showKey}/allLeaves` |
| Batch metadata | `GET {server}/library/metadata/{k1,k2,k3}` |
| Search | `GET {server}/hubs/search?query=<q>&limit=<n>` |
| Create playlist | `POST {server}/playlists?type=video&title=&smart=0&uri=…` |
| Append items | `PUT {server}/playlists/{id}/items?uri=…` |
| Read playlist | `GET {server}/playlists/{id}/items` |
| Delete playlist | `DELETE {server}/playlists/{id}` |

All server requests take `X-Plex-Token` (that server's `accessToken`) as a header and
`Accept: application/json`, without which Plex returns XML.

`?title=` filtering is worth using: *verified* 0.5s for a filtered lookup versus 1.3s
to pull all 925 shows in a section.

---

## 10. What the extension now verifies for itself

`test/run-extract-check.sh <url>` runs the real extractor against a live page and
asserts item count, strict ordering, id shape, no duplicates, a clean list name, and
that IMDb is still coming from `__NEXT_DATA__` rather than the JSON-LD fallback. It
drives `browse --headed` because headless would report a false failure on IMDb.

Passing as of 2026-08-20: IMDb chart (250), IMDb list (250), Letterboxd MCU (60),
Letterboxd top-500 (500 across 5 pages, 416ms).

`test/run-ui-smoke.sh <url>` drives the dialog on a real page against a stubbed
`chrome.*`, so the panel, coverage rendering and post-create parked state are exercised
without touching Plex. `npm test` covers the matcher, including the TMDB
namespace-collision case above.

---

## 11. Working code to crib from

In the sibling `simpsons/` directory:

- **`plex_playlist.py`** — the whole flow in Python: server discovery with connection
  racing, matching, batched creation, read-back verification. Dry-run by default.
- **`fetch_show.py`** — unrelated to Plex, but the same "fail loudly on a shape change"
  posture.
- The `Save to Plex` panel inside
  `doug-is/src/content/stuff/simpsons-episodes-ranked.html` is the browser version of
  the same flow: PIN auth, connection racing, coverage preview, batched create,
  read-back. It's plain ES5-ish JavaScript with no build step, so it ports to a service
  worker with little more than copy and paste.
