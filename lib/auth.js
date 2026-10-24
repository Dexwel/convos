'use strict';
/**
 * Accounts: email+password (scrypt) and OpenID Connect sign-in with Google and Microsoft.
 * No dependencies. Sessions are HMAC-signed cookies holding the user id.
 */
const crypto = require('crypto');

const PROVIDERS = {
  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    idEnv: 'GOOGLE_CLIENT_ID',
    secretEnv: 'GOOGLE_CLIENT_SECRET',
  },
  microsoft: {
    label: 'Microsoft',
    // "common" accepts work/school and personal Microsoft accounts. Override with MICROSOFT_TENANT.
    get authUrl() { return `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/authorize`; },
    get tokenUrl() { return `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/token`; },
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
    idEnv: 'MICROSOFT_CLIENT_ID',
    secretEnv: 'MICROSOFT_CLIENT_SECRET',
  },
};

const providerConfigured = (name) => {
  const p = PROVIDERS[name];
  return !!(p && process.env[p.idEnv] && process.env[p.secretEnv]);
};

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const want = Buffer.from(keyB64, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// used to equalise timing when the email does not exist
const DUMMY_HASH = hashPassword('not-a-real-password');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase().slice(0, 320) : '');
const validEmail = (e) => EMAIL_RE.test(e);
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use a password of at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

// ---------- session tokens ----------
function makeSessionTools(secret) {
  const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');
  const safeEq = (a, b) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  return {
    sign,
    makeSession(userId, ttlMs = 7 * 86400_000) {
      const body = `${userId}.${Date.now() + ttlMs}`;
      return `${body}.${sign('s:' + body)}`;
    },
    readSession(tok) {
      if (!tok || typeof tok !== 'string') return null;
      const parts = tok.split('.');
      if (parts.length !== 3) return null;
      const body = `${parts[0]}.${parts[1]}`;
      if (!safeEq(parts[2], sign('s:' + body))) return null;
      if (!(Number(parts[1]) > Date.now())) return null;
      return parts[0];
    },
    // short-lived signed OAuth state (binds the redirect to the browser that started it)
    makeState(provider) {
      const nonce = crypto.randomBytes(16).toString('base64url');
      const body = `${provider}.${nonce}.${Date.now() + 10 * 60_000}`;
      return { value: `${body}.${sign('o:' + body)}`, nonce };
    },
    checkState(value, provider) {
      if (!value) return false;
      const parts = value.split('.');
      if (parts.length !== 4) return false;
      const body = parts.slice(0, 3).join('.');
      return parts[0] === provider && safeEq(parts[3], sign('o:' + body)) && Number(parts[2]) > Date.now();
    },
  };
}

// ---------- OAuth / OIDC ----------
function authorizeUrl(name, redirectUri, state) {
  const p = PROVIDERS[name];
  const u = new URL(p.authUrl);
  u.searchParams.set('client_id', process.env[p.idEnv]);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', p.scope);
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

async function postForm(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(data),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `token request failed (${res.status})`);
  return json;
}

/** Exchange the code, then read the profile from the provider's userinfo endpoint over TLS. */
async function fetchProfile(name, code, redirectUri) {
  const p = PROVIDERS[name];
  const tok = await postForm(p.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: process.env[p.idEnv],
    client_secret: process.env[p.secretEnv],
  });
  if (!tok.access_token) throw new Error('no access token returned');
  const res = await fetch(p.userinfoUrl, { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`userinfo failed (${res.status})`);
  const info = await res.json();
  if (!info.sub) throw new Error('profile has no subject');
  const email = normEmail(info.email || (name === 'microsoft' && validEmail(normEmail(info.preferred_username)) ? info.preferred_username : ''));
  return {
    sub: String(info.sub),
    email,
    // Google states whether it verified the address. Microsoft's email claim is not proof of ownership.
    emailVerified: name === 'google' ? info.email_verified === true : false,
    name: typeof info.name === 'string' ? info.name.slice(0, 120) : '',
  };
}

module.exports = {
  PROVIDERS, providerConfigured,
  hashPassword, verifyPassword, DUMMY_HASH,
  normEmail, validEmail, passwordProblem,
  makeSessionTools, authorizeUrl, fetchProfile,
};
