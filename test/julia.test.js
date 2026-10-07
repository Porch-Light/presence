import { expect } from 'chai';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { createApp } from '../src/server.js';
import { newKeys, signed, sign } from './helpers.js';

// Runs only when JULIA_URL points at a local Julia (see ARCHITECTURE.md §7 for the two fixes it needs).
const JULIA_URL = process.env.JULIA_URL;
const describeJulia = JULIA_URL ? describe : describe.skip;

describeJulia('presence with a real Julia', () => {
  let server, base, dataDir;

  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'presence-'));
    server = createApp({ dataDir }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const createJuliaUser = async (keys) => {
    const timestamp = Date.now() + '';
    const res = await fetch(`${JULIA_URL}user/create`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp,
        pubKey: keys.pubKey,
        user: { pubKey: keys.pubKey },
        signature: sign(keys.privateKey, timestamp + keys.pubKey)
      })
    });
    return res.json();
  };

  const julia = async (method, route, body) => {
    const res = await fetch(JULIA_URL + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json();
  };

  const getJuliaUser = async (user, keys) => {
    const timestamp = Date.now() + '';
    const signature = sign(keys.privateKey, timestamp + user.uuid);
    return julia('GET', `user/${user.uuid}?timestamp=${timestamp}&signature=${signature}`);
  };

  it('connects two friends through Julia and sets a status whose allow-list comes from interactingKeys', async () => {
    const aKeys = await newKeys();
    const bKeys = await newKeys();
    const a = await createJuliaUser(aKeys);
    const b = await createJuliaUser(bKeys);
    expect(a.uuid).to.have.length(36);

    // A prompts, B signs, A associates
    let ts = Date.now() + '';
    const withPrompt = await julia('GET', `user/${a.uuid}/associate/prompt?timestamp=${ts}&signature=${sign(aKeys.privateKey, ts + a.uuid)}`);
    const code = Object.keys(withPrompt.pendingPrompts)[0];

    ts = Date.now() + '';
    const signedPrompt = await julia('POST', `user/${b.uuid}/associate/signedPrompt`, {
      timestamp: ts, uuid: b.uuid, pubKey: bKeys.pubKey, prompt: code,
      signature: sign(bKeys.privateKey, ts + b.uuid + bKeys.pubKey + code)
    });
    expect(signedPrompt.success).to.equal(true);

    const pending = (await getJuliaUser(a, aKeys)).pendingPrompts[code];
    const msg = pending.newTimestamp + pending.newUUID + pending.newPubKey + code;
    await julia('POST', `user/${a.uuid}/associate`, {
      timestamp: Date.now() + '',
      newTimestamp: pending.newTimestamp, newUUID: pending.newUUID, newPubKey: pending.newPubKey,
      prompt: code, newSignature: pending.newSignature,
      signature: sign(aKeys.privateKey, msg)
    });

    const { keys } = await getJuliaUser(a, aKeys);
    const allow = Object.entries(keys.interactingKeys).filter(([k]) => k !== 'julia').map(([, pk]) => pk);
    expect(allow).to.deep.equal([bKeys.pubKey]);

    const body = { pubKey: aKeys.pubKey, state: 'blue', ttlSeconds: 3600, nickname: 'A', allow };
    const res = await fetch(base + '/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...signed(aKeys, 'status', [body.pubKey, body.state, body.ttlSeconds, body.nickname, '', allow.join(',')]) })
    });
    expect(res.status).to.equal(200);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'status', `${aKeys.pubKey}.json`), 'utf8'));
    expect(saved.allow).to.deep.equal([bKeys.pubKey]);
  });
});
