import { randomUUID } from 'node:crypto';

/** Main-owned, ephemeral observation identity. Never derives a public value from a secret. */
export function createAccountUsageRevisions() {
  const entries = new Map();
  return {
    invalidate(groupId) { entries.delete(groupId); },
    revision(item) {
      const groupId = item.groupId || item.id;
      const identity = JSON.stringify([groupId, item.channelId, item.provider, item.authMethod, item.baseUrl,
        item.apiKeyConfigured, item.oauthConfigured, item.oauthAccountId, item.oauthEmail, item.oauthExpires]);
      const previous = entries.get(groupId);
      if (previous?.identity === identity) return previous.revision;
      const revision = randomUUID();
      entries.set(groupId, { identity, revision });
      return revision;
    },
  };
}

export function accountUsageIdentity(provider) {
  return JSON.stringify([provider?.id, provider?.groupId, provider?.channelId, provider?.authMethod, provider?.baseUrl,
    provider?.accountUsageRevision, provider?.oauthStatus]);
}
