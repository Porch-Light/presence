# Presence

The status service behind Porchlight: each user publishes a colour (purple, green, blue or orange), a nickname and a short
message, and only the friends they allow can read it. Node and Express, no database: state is JSON files.
Requests are signed with [sessionless](https://github.com/planet-nine-app/sessionless) keys, so there are no accounts or passwords here.
It identifies users by public key only; the Porchlight app registers users with Julia (allyabase) separately.

## Run

```
npm install
npm start                      # http://localhost:3010
npm test
```

| Variable | Default | |
|---|---|---|
| `PORT` | `3010` | listen port |
| `PRESENCE_DATA` | `data/presence` | where statuses, allow-lists and delegates are stored; delete it to reset everything |
| `JULIA_URL` | (unset) | only used by `test/julia.test.js`, which is skipped without it |

## Routes

Signed by the user (used by the app and the widgets): `PUT /status`, `PUT /allow`, `GET /status`, `GET /feed`.
Website login (built and tested, not used yet): `PUT /delegate`, `DELETE /delegate/:webPubKey`, `GET /whoami`, `GET /statuses`.
`GET /health` answers `{"ok":true}`.

## Deploy

```
docker build -t presence .
docker run -d --name presence -p 3010:3010 -v presence-data:/data presence
```

The container runs as the unprivileged `node` user (uid 1000), so `/data` must be writable by it. A volume created by an
earlier image of this repo is root-owned and fails with `500 internal error` on every save (the log shows `EACCES`); fix it once with
`docker run --rm -v presence-data:/data alpine chown -R 1000:1000 /data`, or recreate the volume. A bind mount needs the same ownership.

It speaks plain HTTP: put it behind a reverse proxy that terminates HTTPS (the phone apps refuse plain `http://` in release builds).
It has no path prefix of its own, so a proxy can serve it at `/presence/` as long as it strips that prefix. The Porchlight
apps get the URL baked in at build time (`PRESENCE_URL`, with a trailing slash).

Status text is stored unencrypted on the server, readable by whoever runs it. There is one process and one data directory, so
run a single instance.
