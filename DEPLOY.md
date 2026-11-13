# Put the App Store online

These steps give the store its own web address (like `https://app-store-xxxx.onrender.com`).
Anyone can open it on their phone, create an account with a username and password, and stay signed in.

You can do all of this from a phone browser. It takes about 10 minutes.

## 1. Create a Render account

1. Go to **render.com** and tap **Get Started**.
2. Choose **Sign up with GitHub** and allow access to the `App-Store-` repository.

## 2. Create the store from this repository

1. In the Render dashboard tap **New +**, then **Blueprint**.
2. Pick the **App-Store-** repository. Render reads `render.yaml` and shows two things to create:
   - **app-store**: the website
   - **app-store-db**: the database that keeps accounts, apps and reviews
3. Tap **Apply** (or **Deploy Blueprint**). The first build takes a few minutes.

## 3. Open your store

When the website shows **Live**, tap its name. Its address is near the top of the page, ending in `.onrender.com`.
Open that link on your phone and share it with anyone.

Add it to your home screen so it opens like an app: in Safari tap **Share → Add to Home Screen**,
in Chrome tap **⋮ → Add to Home screen**.

## Good to know

- **Free website plan:** after about 15 minutes without visitors the site goes to sleep, so the next visit can take
  up to a minute to load. A paid plan keeps it awake.
- **Free database plan:** Render's free databases have had a time limit (30 days). Check the database page on Render.
  To keep your data, upgrade the database to a paid plan before then. Paid plans start at a few dollars a month.
- **Updates:** every time new code is pushed to the repository, Render rebuilds the store automatically.
  Accounts and apps stay in the database.
- **Using a different database:** the store works with any PostgreSQL database. Set the website's `DATABASE_URL`
  setting to that database's connection string (for example one from Neon or Supabase).
