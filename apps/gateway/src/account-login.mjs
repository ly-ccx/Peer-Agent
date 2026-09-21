import * as oidc from 'openid-client';
import { createHash, randomBytes } from 'node:crypto';

/** OIDC callback validation. HTTP host must set browserBinding in a Secure/HttpOnly
 * SameSite cookie, never accept it from callback query parameters. This module
 * returns an identity only; a separate session store must issue revocable cookies.
 */
export function createAccountLogin({ configuration, redirectUri, allowedSubject, now = Date.now, capacity = 1000 }) {
  const redirect = new URL(redirectUri);
  const issuer = configuration.serverMetadata().issuer;
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash
      || new URL(issuer).protocol !== 'https:' || typeof allowedSubject !== 'string' || !allowedSubject
      || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error('INVALID_LOGIN_CONFIG');
  const pending = new Map();
  const clock = () => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('INVALID_CLOCK');
    return time;
  };
  return {
    // Exposed so the web surface can whitelist the identity provider in its
    // `form-action` CSP: the login POST 303s to the issuer and `form-action` is
    // re-checked on that redirect hop. Reading it from here keeps one source of
    // truth — whatever issuer login actually uses is the one the page allows.
    issuer,
    async begin() {
      const time = clock();
      for (const [state, record] of pending) if (record.expiresAt <= time) pending.delete(state);
      if (pending.size >= capacity) throw new Error('RATE_LIMITED');
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const browserBinding = randomBytes(32).toString('base64url');
      // Reserve synchronously before await so simultaneous starts respect capacity.
      pending.set(state, { nonce, verifier, browserBinding, expiresAt: time + 300_000 });
      try {
        const challenge = await oidc.calculatePKCECodeChallenge(verifier);
        const url = oidc.buildAuthorizationUrl(configuration, {
          redirect_uri: redirect.href, scope: 'openid', response_type: 'code',
          code_challenge: challenge, code_challenge_method: 'S256', state, nonce,
        });
        return { url: url.href, browserBinding, expiresAt: time + 300_000 };
      } catch (error) { pending.delete(state); throw error; }
    },
    async finish(callbackUrl, browserBinding) {
      const time = clock();
      const url = new URL(callbackUrl);
      if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.hash
          || url.username || url.password || url.searchParams.getAll('state').length !== 1) throw new Error('LOGIN_DENIED');
      const state = url.searchParams.get('state');
      const record = pending.get(state);
      pending.delete(state);
      if (!record || record.expiresAt <= time || record.browserBinding !== browserBinding) throw new Error('LOGIN_DENIED');
      const tokens = await oidc.authorizationCodeGrant(configuration, url, {
        pkceCodeVerifier: record.verifier, expectedState: state,
        expectedNonce: record.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || claims.iss !== issuer || claims.sub !== allowedSubject) throw new Error('LOGIN_DENIED');
      // Stable identity, independent of browser and display names. Never return IdP tokens.
      const ownerId = createHash('sha256').update(JSON.stringify([issuer, claims.sub])).digest('hex');
      return Object.freeze({ ownerId, issuer, subject: claims.sub });
    },
  };
}

/** No insecure discovery override: production issuer and callback require HTTPS. */
export async function discoverAccountLogin({ issuer, clientId, clientSecret, ...options }) {
  const server = new URL(issuer);
  if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) {
    throw new Error('INVALID_ISSUER');
  }
  const configuration = await oidc.discovery(server, clientId, clientSecret);
  return createAccountLogin({ configuration, ...options });
}
