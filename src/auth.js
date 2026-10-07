import sessionless from 'sessionless-node';

export const WINDOW_MS = 60 * 1000;

const PUBKEY_RE = /^[0-9a-f]{66}$/;

export const isPubKey = (s) => typeof s === 'string' && PUBKEY_RE.test(s);

// Message format: [tag, timestamp, ...fields].join('|'). The tag binds a signature to one route.
// Free-text fields can contain '|', so '\\' and '|' inside a field are backslash-escaped. Without
// that, "a|b" + "c" and "a" + "b|c" would sign the same string.
const escapeField = (field) => String(field).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

export const buildMessage = (tag, timestamp, fields) =>
  [tag, timestamp, ...fields.map(escapeField)].join('|');

export const timestampFresh = (timestamp, now = Date.now()) => {
  const t = +timestamp;
  return Number.isFinite(t) && Math.abs(now - t) <= WINDOW_MS;
};

export const signatureValid = (signature, message, pubKey) => {
  if(typeof signature !== 'string' || !isPubKey(pubKey)) {
    return false;
  }
  try {
    return !!sessionless.verifySignature(signature, message, pubKey);
  } catch(err) {
    return false;
  }
};

// Returns null when ok, otherwise {status, error}. Stale timestamps and bad signatures are both 401.
export const checkRequest = ({ tag, timestamp, fields, signature, pubKey }) => {
  if(!timestampFresh(timestamp)) {
    return { status: 401, error: 'stale timestamp' };
  }
  if(!signatureValid(signature, buildMessage(tag, timestamp, fields), pubKey)) {
    return { status: 401, error: 'bad signature' };
  }
  return null;
};
