import express from 'express';
import { checkRequest, isPubKey } from './auth.js';
import { createStore } from './store.js';

export const STATES = ['purple', 'green', 'blue', 'orange'];
export const DEFAULT_TTL = 14400;
export const MAX_TTL = 86400;
export const MAX_TEXT = 255;
export const MAX_NICKNAME = 40;
const MAX_ALLOW = 500;
export const DELEGATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Length in code points, so it matches Rust's `chars().count()` and an emoji counts as one.
const length = (s) => Array.from(s).length;

const validAllow = (allow) =>
  Array.isArray(allow) && allow.length <= MAX_ALLOW && allow.every(isPubKey);

export const createApp = ({ dataDir }) => {
  const store = createStore(dataDir);
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  const fail = (res, err) => {
    console.warn(err);
    res.status(500).send({ error: 'internal error' });
  };

  // Verifies a primary-signed request. `fields` is everything signed after the tag and timestamp.
  const primaryDenied = (tag, { timestamp, signature }, pubKey, fields) =>
    checkRequest({ tag, timestamp, fields, signature, pubKey });

  // Verifies a web-key-signed GET and resolves its delegate. Returns {primaryPubKey} or {denied}.
  // Unknown, revoked and expired delegates are all the same 401. Use refreshes the delegate.
  const authenticateWeb = async (tag, query) => {
    const { webPubKey } = query;
    const denied = primaryDenied(tag, query, webPubKey, [webPubKey]);
    if(denied) {
      return { denied };
    }
    const delegate = await store.get('delegates', webPubKey);
    const now = Date.now();
    if(!delegate || now - delegate.lastSeenAt > DELEGATE_TTL_MS) {
      return { denied: { status: 401, error: 'not authorized' } };
    }
    await store.put('delegates', webPubKey, { ...delegate, lastSeenAt: now });
    return { primaryPubKey: delegate.primaryPubKey };
  };

  // Everything the viewer may see: owners whose allow-list includes the viewer. Owners who
  // haven't allowed the viewer are omitted, never reported as forbidden.
  const visibleTo = async (viewer) => {
    const now = Date.now();
    const statuses = {};
    for(const owner of await store.list('status')) {
      const saved = await store.get('status', owner);
      if(!saved || owner === viewer || !saved.allow.includes(viewer)) {
        continue;
      }
      const expired = now > saved.updatedAt + saved.ttlSeconds * 1000;
      statuses[owner] = {
        state: expired ? 'unknown' : saved.state,
        nickname: saved.nickname,
        text: expired ? '' : saved.text,
        updatedAt: saved.updatedAt
      };
    }
    return statuses;
  };

  app.get('/health', (req, res) => res.send({ ok: true }));

  app.put('/status', async (req, res) => {
    try {
      const { pubKey, state } = req.body;
      const nickname = req.body.nickname ?? '';
      const text = req.body.text ?? '';
      const ttlSeconds = req.body.ttlSeconds ?? DEFAULT_TTL;
      const allow = req.body.allow ?? [];

      if(!isPubKey(pubKey) || !STATES.includes(state) ||
         typeof nickname !== 'string' || length(nickname) > MAX_NICKNAME ||
         typeof text !== 'string' || length(text) > MAX_TEXT ||
         !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL ||
         !validAllow(allow)) {
        return res.status(400).send({ error: 'invalid request' });
      }

      const denied = primaryDenied('status', req.body, pubKey,
        [pubKey, state, ttlSeconds, nickname, text, allow.join(',')]);
      if(denied) {
        return res.status(denied.status).send({ error: denied.error });
      }

      const updatedAt = Date.now();
      await store.put('status', pubKey, { pubKey, state, ttlSeconds, updatedAt, nickname, text, allow });
      res.send({ ok: true, updatedAt });
    } catch(err) {
      fail(res, err);
    }
  });

  // Updates only who may see the status. Keeps updatedAt, so unfriending someone can't
  // extend how long the status stays fresh.
  app.put('/allow', async (req, res) => {
    try {
      const { pubKey } = req.body;
      const allow = req.body.allow ?? [];
      if(!isPubKey(pubKey) || !validAllow(allow)) {
        return res.status(400).send({ error: 'invalid request' });
      }
      const denied = primaryDenied('allow', req.body, pubKey, [pubKey, allow.join(',')]);
      if(denied) {
        return res.status(denied.status).send({ error: denied.error });
      }
      const saved = await store.get('status', pubKey);
      if(!saved) {
        return res.status(404).send({ error: 'no status yet' });
      }
      await store.put('status', pubKey, { ...saved, allow });
      res.send({ ok: true });
    } catch(err) {
      fail(res, err);
    }
  });

  // The caller's own saved status (never the allow-list), or null before the first one.
  app.get('/status', async (req, res) => {
    try {
      const { pubKey } = req.query;
      const denied = primaryDenied('mystatus', req.query, pubKey, [pubKey]);
      if(denied) {
        return res.status(denied.status).send({ error: denied.error });
      }
      const saved = await store.get('status', pubKey);
      res.send({
        status: saved && {
          state: saved.state, ttlSeconds: saved.ttlSeconds, nickname: saved.nickname,
          text: saved.text, updatedAt: saved.updatedAt
        }
      });
    } catch(err) {
      fail(res, err);
    }
  });

  // What the desktop app shows: the same view the website gets, read as the primary user.
  app.get('/feed', async (req, res) => {
    try {
      const { pubKey } = req.query;
      const denied = primaryDenied('feed', req.query, pubKey, [pubKey]);
      if(denied) {
        return res.status(denied.status).send({ error: denied.error });
      }
      res.send({ statuses: await visibleTo(pubKey) });
    } catch(err) {
      fail(res, err);
    }
  });

  app.put('/delegate', async (req, res) => {
    try {
      const { primaryPubKey, webPubKey } = req.body;
      if(!isPubKey(primaryPubKey) || !isPubKey(webPubKey) || primaryPubKey === webPubKey) {
        return res.status(400).send({ error: 'invalid request' });
      }
      const denied = primaryDenied('delegate', req.body, primaryPubKey, [primaryPubKey, webPubKey]);
      if(denied) {
        return res.status(denied.status).send({ error: denied.error });
      }
      const existing = await store.get('delegates', webPubKey);
      if(existing && existing.primaryPubKey !== primaryPubKey) {
        return res.status(409).send({ error: 'web key already delegated' });
      }
      const now = Date.now();
      await store.put('delegates', webPubKey, {
        webPubKey, primaryPubKey, createdAt: existing?.createdAt ?? now, lastSeenAt: now
      });
      res.send({ ok: true });
    } catch(err) {
      fail(res, err);
    }
  });

  app.delete('/delegate/:webPubKey', async (req, res) => {
    try {
      const { webPubKey } = req.params;
      const { primaryPubKey } = req.body;
      if(!isPubKey(primaryPubKey) || !isPubKey(webPubKey)) {
        return res.status(400).send({ error: 'invalid request' });
      }
      const denied = primaryDenied('undelegate', req.body, primaryPubKey, [primaryPubKey, webPubKey]);
      if(denied) {
        return res.status(denied.status).send({ error: denied.error });
      }
      const existing = await store.get('delegates', webPubKey);
      // Only the owner can revoke; anyone else gets the same answer as for a missing delegate.
      if(existing && existing.primaryPubKey === primaryPubKey) {
        await store.remove('delegates', webPubKey);
      }
      res.send({ ok: true });
    } catch(err) {
      fail(res, err);
    }
  });

  app.get('/whoami', async (req, res) => {
    try {
      const { primaryPubKey, denied } = await authenticateWeb('whoami', req.query);
      if(denied) {
        return res.status(denied.status).send({ error: denied.error });
      }
      res.send({ primaryPubKey });
    } catch(err) {
      fail(res, err);
    }
  });

  app.get('/statuses', async (req, res) => {
    try {
      const { primaryPubKey, denied } = await authenticateWeb('statuses', req.query);
      if(denied) {
        return res.status(denied.status).send({ error: denied.error });
      }
      res.send({ statuses: await visibleTo(primaryPubKey) });
    } catch(err) {
      fail(res, err);
    }
  });

  return app;
};

if(process.argv[1] === new URL(import.meta.url).pathname) {
  const port = process.env.PORT || 3010;
  createApp({ dataDir: process.env.PRESENCE_DATA || 'data/presence' }).listen(port);
  console.log(`presence ready on port ${port}`);
}
