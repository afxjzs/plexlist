# PlexList privacy policy

Last updated: 2026-08-21

PlexList has no backend. There is no PlexList server, no account, no analytics,
and no telemetry. Nothing is sent anywhere except to Plex and to the site you
are already looking at.

## What is stored, and where

Everything is stored with `chrome.storage.local` on your own machine. Nothing
syncs to another device or to any server.

| Stored | Why | Cleared when |
|---|---|---|
| Your Plex auth token | So you do not sign in on every visit | You click **Sign out**, or remove the extension |
| A random client identifier (UUID) | Plex requires a stable per-install id; a changing one would register a new device in your Plex account on every sign-in | You remove the extension |
| A cached index of your Plex library | Titles, years, rating keys and external ids, so a list can be matched without re-reading the whole library each time | You sign out, or switch to a different server |

The client identifier is generated locally with `crypto.randomUUID()`. It is sent
only to Plex, and is not derived from anything about you or your hardware.

## What leaves your machine

Only these hosts are ever contacted:

- **`plex.tv`** — to create and poll a sign-in PIN, and to list the servers on
  your account.
- **`app.plex.tv`** — the page you are sent to in order to approve sign-in.
- **your own Plex server** — to read your libraries and create the playlist. The
  address comes from your Plex account's own server list.
- **`imdb.com` / `letterboxd.com`** — only the site whose page you already have
  open, and only to read further pages of the list you asked to import. These
  requests are same-origin, and the extension refuses to fetch any other host.

Your Plex token is sent only to Plex, always as an `X-Plex-Token` request header
rather than in a URL, so it does not end up in browser history, referrers, or
server logs.

## What is not collected

No browsing history, no watch history, no page content beyond the list you asked
to import, no personal information, no advertising identifiers. Nothing is sold
or shared, because nothing is collected.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | To keep the token, client id and library cache described above |
| `https://plex.tv/*` | Sign-in and server discovery |
| `https://*.plex.direct/*` | Plex servers are reached over their signed `plex.direct` certificates |
| Content scripts on `imdb.com` / `letterboxd.com` | To read the list off the page and show the panel |
| *Optional* all-sites access | Only needed to reach a Plex server on your local network, or one on a custom address. Not requested at install; you grant it yourself if you need it |

## Removing your data

Click **Sign out** in the panel to delete the stored token and the cached
library index. Removing the extension deletes everything, including the client
identifier.

## Contact

Issues: https://github.com/afxjzs/plexlist/issues
