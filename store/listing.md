# Chrome Web Store listing

The source of truth for everything typed into the Developer Dashboard. Edit here
first, then paste — otherwise the live listing and the repo drift apart and
nobody can tell which is right.

Fields marked **(from package)** are read out of `manifest.json` and cannot be
edited in the dashboard; change them in the manifest and re-upload.

---

## Product details

**Title (from package):**

```
PlexList
```

**Summary (from package — `manifest.json` `description`, 132 char limit):**

```
Turn an IMDb or Letterboxd list into a playlist on your own Plex server, in list order.
```

**Category:** Entertainment
**Language:** English

**Description** (16,000 char limit; currently well under, which is fine — the
limit is a cap, not a target):

```
PlexList adds a "Save to Plex" button to IMDb and Letterboxd lists. Click it, pick your server, and the list becomes a playlist on your own Plex — in the same order it appears on the page.

How to use it:
1. Open a list — an IMDb chart, an IMDb user list, or a Letterboxd list.
2. Click "Save to Plex" at the bottom right of the page.
3. Sign in to Plex once, pick which of your servers to use, name the playlist, and create it.

Works on:
• IMDb charts, such as the Top 250
• IMDb user lists
• Letterboxd lists, including ones that run across several pages

Matching you can trust. Films are matched by their IMDb and TMDB ids, not by title. Titles disagree on punctuation constantly — "WALL·E", "Se7en", "Who Shot Mr. Burns? Part One" — and title matching quietly drops those. Matching on ids does not.

It tells you before it acts. Before creating anything, the panel shows how many of the list's titles are actually in your library and names the ones it will skip. Anything it cannot pin to exactly one film is skipped rather than guessed. After creating, it reads the playlist back and checks the length and order against what it sent.

No account, no tracking. There is no PlexList server. Your Plex token is stored in your browser and sent only to Plex. No analytics, no data collection.

Requires a Plex account and a Plex Media Server. Works with servers on your local network as well as ones reachable over the internet.

Open source: https://github.com/afxjzs/plexlist
```

---

## Graphic assets

| Slot | File | Requirement |
|---|---|---|
| Store icon | `icons/icon-128.png` | 128×128 |
| Screenshot 1 | `store/screenshot-1-imdb.png` | 1280×800 |
| Screenshot 2 | `store/screenshot-2-letterboxd.png` | 1280×800 |
| Screenshot 3 | `store/screenshot-3-created.png` | 1280×800 |
| Small promo tile | `store/promo-small-440x280.png` | 440×280, no alpha |
| Marquee promo tile | `store/promo-marquee-1400x560.png` | 1400×560, no alpha |

Regenerate with `npm run icons`, `npm run shots`, and `tools/promo-tiles.sh`.
The promo tiles must be 24-bit PNG with no alpha channel; `promo-tiles.sh`
flattens and then verifies both size and alpha, so a bad file fails the run
rather than the upload.

---

## Privacy tab

**Single purpose description:**

```
PlexList reads the list of films or shows from an IMDb or Letterboxd list page the user is already viewing, and creates a matching playlist on the user's own Plex Media Server, in the same order the list appears. That is its only function. It has no other features, no accounts, no backend service, and no analytics.
```

**storage justification:**

```
Stores three things locally via chrome.storage.local, all on the user's own machine: (1) the Plex authentication token returned by Plex's PIN sign-in flow, so the user does not have to sign in again on every visit; (2) a randomly generated client identifier, which Plex requires to remain stable across sessions — a changing one registers a new device in the user's Plex account on every sign-in; (3) a cached index of the user's own Plex library (titles, years, and external IDs), so a list can be matched without re-reading the entire library every time, which on a large library is a multi-second request. Signing out deletes the token and the cached index.
```

**Host permission justification** (one field covering every match pattern in
`host_permissions` and `content_scripts`):

Note the **1,000 character limit** on this field — the first draft ran to 1,180
and would not have pasted.

```
plex.tv — signs the user in to their own Plex account via Plex's standard PIN authorization flow, and lists the servers on that account. Plex's own API, and the only way to discover a user's servers.

*.plex.direct — the address at which a Plex Media Server is reached. Plex issues every server a *.plex.direct hostname, for both internet and LAN connections. The address comes from the user's own Plex account, never from the extension. Used to read their libraries and create the playlist.

www.imdb.com and letterboxd.com — content scripts that read the list of titles from the page the user is already viewing, and inject the "Save to Plex" panel. They act only on list and chart pages, and read the list only when the user opens the panel. Letterboxd list pages carry no film IDs, so the extension also reads a film's own Letterboxd page to get its TMDB/IMDb ID, making the match exact rather than a title guess.

No wildcard or all-sites access is requested.
```

**Are you using remote code?** → **No, I am not using remote code.**

All JavaScript ships inside the package. No external `<script>` tags, no modules
pointing at external files, no `eval()`. The extension fetches IMDb and
Letterboxd HTML, but that is data, not code, and `DOMParser` does not execute
scripts in what it parses.

**Data usage — tick:**

- **Authentication information** — the Plex token leaves the device (it goes to
  Plex, and to the user's own server).
- **Website content** — a judgment call, ticked deliberately. The only
  page-derived value that leaves the device is the playlist name, which defaults
  to the list's title and is sent to the user's own Plex server. Declaring it
  costs a line on the listing; under-declaring is the version that becomes a
  takedown later.

**Do not tick:** personally identifiable information, health, financial,
personal communications, location, web history, user activity.

**Certifications:** tick all three.

**Privacy policy URL:**

```
https://github.com/afxjzs/plexlist/blob/main/PRIVACY.md
```

---

## Test instructions

**Username and password: leave both blank.**

PlexList signs the reviewer in to *their own* Plex account. Handing over the
developer's credentials would give reviewers access to a personal media library
and account, and it would not demonstrate anything the reviewer cannot see with
a free account of their own. There is no PlexList account to provide.

**Additional instructions** (500 char limit):

```
No credentials needed: PlexList signs in to the reviewer's own Plex account; a developer login would only expose a personal library.

1. Open https://www.imdb.com/chart/top/
2. Click "Save to Plex", bottom right.
3. Click "Sign in with Plex" and approve in the tab that opens. A free plex.tv account suffices for sign-in and server discovery.
4. With a Plex Media Server on the account, the panel reports how many of the 250 titles are in your library, then creates the playlist.
```

---

## Adding a new source site

The listing is not the only thing that changes when a site is added, and several
of these are easy to forget. In rough order:

1. **`manifest.json`** — add the origin to `content_scripts.matches`, and update
   `description` if the summary no longer covers it. Bump `version`.
2. **`src/extract.js`** — add the site to `detectSite()` and `looksLikeList()`,
   write its `<site>ReadPage(doc)` and `<site>Extract(onProgress)`, and wire it
   into `extract()`. Read from whatever structured data the page already carries
   in preference to CSS selectors.
3. **Identifiers** — if the site's list pages carry no IMDb/TMDB id, add a
   resolver in the shape of `lbResolveIds`, and make sure the type it reports
   feeds `expectedTypes()` in `src/plex.js`. TMDB numbers movies and TV
   separately, so a film-only source must say so or it can match a show.
4. **`test/extract-check.js`** — add any site-specific assertions, and a
   `check:<site>` script in `package.json` pointing at a real list.
5. **`PRIVACY.md`** — add the origin to the permissions table.
6. **`README.md`** — add it to the supported-pages table.
7. **This file** — update the summary, the "Works on" list in the description,
   and the host permission justification.
8. **Verify**: `npm test`, every `npm run check:*`, and `npm run smoke:*`.
9. **Rebuild assets**: `npm run shots`, `tools/promo-tiles.sh` if the tiles
   mention the site by name.
10. **Package**: `npm run package`, then upload and re-paste anything above that
    changed.
