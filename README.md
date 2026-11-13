# App Store

A web App Store where **anyone can be a developer**: publish your apps, and other people can
find them, get them, and **use them right inside the store**. Nobody needs developer mode,
sideloading or installs on their device.

## Run it

Requires Node.js 18+.

```bash
npm install
npm start            # http://localhost:3000
npm test             # API tests (set TEST_DATABASE_URL to also test against Postgres)
```

Settings:
- `PORT`: the port to listen on (default 3000).
- `DATABASE_URL`: a PostgreSQL connection string. Accounts, apps and reviews are saved there.
- `DATA_DIR`: when there's no `DATABASE_URL`, data is saved as files here (default `./data`).

**To put it online, follow [DEPLOY.md](DEPLOY.md)** (Render, with a one-click `render.yaml`).

## Accounts

- People create an account with a **username and password**.
- Passwords are hashed with scrypt and never stored or shown in plain text. They need at least 8 characters.
- **Keep me signed in on this device** (on by default) saves a secure, HttpOnly cookie for 60 days, renewed while
  the person keeps using the store. With it off, the sign-in lasts until the browser closes.
- Ten wrong passwords for one username from one place block more tries for 15 minutes.
- People can change their password, which signs out their other devices, or sign out of all devices.

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
- Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Lax cookies, marked Secure over HTTPS.
- Write API calls require an `X-Store-Client` header (CSRF guard).

## Project layout

```
server.js          HTTP server + REST API
lib/db.js          storage: PostgreSQL (DATABASE_URL) or files (data/db.json + data/apps/<id>/<version>.html)
lib/seed.js        sample apps added on first run
lib/samples/       sample apps' HTML (Star Catcher, Quick Notes, Calculator, Pixel Paint, Focus Timer)
public/            the store front end (vanilla JS single-page app)
render.yaml        one-click Render setup (website + database)
test/              API tests (node:test)
```

## Hosted version (claude.ai link)

`hosted/app-store.html` is a single-page version of the store that runs as a claude.ai Artifact,
so it opens on any phone or computer with a link. It uses the artifact's shared database instead of
the Node server and claude.ai sign-in instead of store accounts. Each developer's apps live under
`devs/<their id>`, with app code at `devs/<id>/code/<appId>`. Each person's downloads, reviews and opens
live under `installs/`, `reviews/` and `opens/` in documents only they can write. Data an app saves is
kept privately per person.
