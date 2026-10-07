import sessionless from 'sessionless-node';
import { secp256k1 } from 'ethereum-cryptography/secp256k1';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes } from 'ethereum-cryptography/utils.js';
import { buildMessage } from '../src/auth.js';

// sessionless-node holds a single global keypair, so tests that need several identities
// sign directly with the same keccak256 + secp256k1 scheme it uses.
export const newKeys = async () => {
  let keys;
  await sessionless.generateKeys((k) => { keys = k; }, () => keys);
  return keys;
};

export const sign = (privateKey, message) =>
  secp256k1.sign(keccak256(utf8ToBytes(message)), privateKey).toCompactHex();

export const signed = (keys, tag, fields, timestamp = Date.now() + '') => ({
  timestamp,
  signature: sign(keys.privateKey, buildMessage(tag, timestamp, fields))
});

// A GET signed by `keys` for a primary-key route: `/feed`, `/status`.
export const primaryQuery = (keys, tag, overrides = {}) => new URLSearchParams({
  pubKey: keys.pubKey,
  ...signed(keys, tag, [keys.pubKey]),
  ...overrides
});
