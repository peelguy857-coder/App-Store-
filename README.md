# App Store

A web App Store where **anyone can be a developer**: publish your apps, and other people can
find them, get them, and **use them right inside the store**. Nobody needs developer mode,
sideloading or installs on their device.

## Run it

Requires Node.js 18+ and has no dependencies.

```bash
npm start            # http://localhost:3000
npm test             # API tests
```

Options: `PORT=8080` and `DATA_DIR=/path/to/data` (default `./data`).

To let other people use your store, run it on any server or host that runs Node
(Render, Railway, Fly.io, a VPS, …) and keep `DATA_DIR` on persistent storage.

## What you can do

**As a user**
- Browse **Discover** (featured, popular, new, top rated), browse categories, or search for apps and developers.
- Tap **Get** to add an app to **My Apps**, then **Open** to use it in the store. **Try it** works without getting the app first.
- Rate and review apps, or download an app's `.html` file.

**As a developer** (any account)
- Open **Developer → Publish new app**, then fill in the name, tagline, category, icon (emoji or image) and description.
- Add your app's code: upload a `.html` file, paste it in, or start from the starter template. Use **Preview** to test it before publishing.
- See downloads, opens and ratings in your dashboard.
- **Release a new version**: edit the code right in the browser or upload a new file. Everyone gets the update the next time they open the app.

## Making an app

An app is a single HTML file (inline CSS and JavaScript, up to 2 MB). Embed images as data URLs.
`localStorage` works normally: the store gives each app its own storage per user.

## Security

- Apps run in a sandboxed iframe with an opaque origin. They can't read the store's cookies, call its API,
  or touch other apps' data. `/run/:id` and `/download/:id` also send a `Content-Security-Policy: sandbox` header.
- Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Lax cookies.
- Write API calls require an `X-Store-Client` header (CSRF guard).

## Project layout

```
server.js          HTTP server + REST API
lib/db.js          JSON-file storage (data/db.json + data/apps/<id>/<version>.html)
lib/seed.js        sample apps added on first run
lib/samples/       sample apps' HTML (Star Catcher, Quick Notes, Calculator, Pixel Paint, Focus Timer)
public/            the store front end (vanilla JS single-page app)
test/              API tests (node:test)
```

## Hosted version (claude.ai link)

`hosted/app-store.html` is a single-page version of the store that runs as a claude.ai Artifact,
so it opens on any phone or computer with a link. It uses the artifact's shared database instead of
the Node server and claude.ai sign-in instead of store accounts. Each developer's apps live under
`devs/<their id>`, with app code at `devs/<id>/code/<appId>`. Each person's downloads, reviews and opens
live under `installs/`, `reviews/` and `opens/` in documents only they can write. Data an app saves is
kept privately per person.
