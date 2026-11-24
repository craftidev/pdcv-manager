# Deploy PDCV Step 2 on Heroku

Deploy this folder as its own source repository. It contains only the client application, validated client dataset, small shared runtime helpers, and Heroku configuration. It excludes Drupal authentication, collection scripts, operator progress, raw snapshots, local databases, and development tests. Playwright is not a deployment dependency.

The included dataset contains the validated contexts and initial automatic classifications. Local Step 2 trial decisions are not copied; Heroku decisions are stored in its database.

## 1. Attach PostgreSQL

Replace `YOUR_APP` with your existing Heroku app name. First check its add-ons:

```bash
heroku addons -a YOUR_APP
```

If there is no Postgres database, attach one from **Resources → Add-ons → Heroku Postgres**, or use the CLI. This is a paid add-on; Essential-0 is a small-plan example:

```bash
heroku addons:create heroku-postgresql:essential-0 -a YOUR_APP
heroku pg:wait -a YOUR_APP
```

Heroku normally sets `DATABASE_URL` automatically. If another database is already the primary attachment, ensure the intended database is the one designated by `DATABASE_URL`; do not overwrite an existing app's database configuration blindly. No manual tables, users, or SQL imports are needed: the release command creates the app's tables and initial classifications.

Runtime JSON/SQLite writes on a Heroku dyno do not provide persistent shared progress. PostgreSQL stores that progress independently of application restarts and redeployments. See [Heroku Postgres provisioning](https://devcenter.heroku.com/articles/provisioning-heroku-postgres) and [SQLite on Heroku](https://devcenter.heroku.com/articles/sqlite3).

## 2. Set two config vars

In **Settings → Reveal Config Vars**, add:

| Name | Value |
|---|---|
| `SECRET_KEY` | A long random string, kept stable across redeployments. |
| `PDCV_ACCESS_CODE` | The access code you will give the client team. |

`DATABASE_URL` should already exist after attaching Postgres. Keep these values in Heroku config, not in source files. Reviewers enter the shared access code and their own name/team label.

## 3. Deploy this folder

Use the Python buildpack for this app. If using Heroku Git, initialize a repository here and connect it to your existing app:

```bash
git init -b codex/step2
git add .
git commit -m "Deploy PDCV Step 2"
heroku git:remote -a YOUR_APP
git push heroku HEAD:main
```

The `Procfile` initializes the database in the release phase, then starts Gunicorn. The same dataset can be redeployed without resetting choices. A different dataset version is deliberately rejected to protect existing work.

If a web process is not already running, scale it:

```bash
heroku ps:scale web=1 -a YOUR_APP
heroku logs --tail -a YOUR_APP
```

Open the HTTPS app URL. Try two separate browser sessions, verify one automatic result, and reload to confirm persistence. All automatic results still need explicit verification. Initial queues are 167 manual classifications and 239 automatic verifications.

Export decisions from the app for an additional portable copy. Keep normal database backups as well. Before deploying a new source bundle, retain the previous artifact and do not replace the dataset while client review is underway without a migration plan.

## Local check

```bash
python -m pip install -r requirements.txt
python -m client.app
```

Open `http://localhost:8770`. Without `DATABASE_URL`, local development uses SQLite in `data/client-review.sqlite`; it is not used for Heroku production.
