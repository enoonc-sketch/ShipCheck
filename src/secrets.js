// Secret storage helpers — Marketplace security fix (2026-11-21).
//
// The app's secrets (CoArena API key, Bitbucket API token, Slack webhook
// URL) must live in Forge's encrypted secret store
// (storage.setSecret / getSecret / deleteSecret), never as plain KVS
// values. Versions up to 0.9.5 wrote them with plain storage.set under
// the same key names; reads here fall back to those legacy plain keys
// and migrate them into the secret store on first read, so an upgrade
// never loses a saved key. Secret values and plain values live in
// separate namespaces in Forge KVS, so reusing the key names is safe.
//
// Every helper degrades gracefully when the secret API is unavailable
// (e.g. a test double): reads fall back to plain get, writes to plain
// set. In the Forge runtime the secret API is always present.

/** Read a secret, migrating a legacy plain value into the secret store. */
export async function getSecret(storage, key) {
  if (typeof storage.getSecret === 'function') {
    const secret = await storage.getSecret(key);
    if (secret !== undefined && secret !== null) return secret;
  }
  const legacy = await storage.get(key);
  if (legacy !== undefined && legacy !== null && typeof storage.setSecret === 'function') {
    try {
      await storage.setSecret(key, legacy);
      await storage.delete(key);
    } catch (e) { /* best-effort migration; the value is still returned */ }
  }
  return legacy;
}

/** Store a secret in the encrypted secret store; clear any legacy plain copy. */
export async function setSecret(storage, key, value) {
  if (typeof storage.setSecret === 'function') {
    await storage.setSecret(key, value);
    try { await storage.delete(key); } catch (e) { /* best-effort cleanup */ }
  } else {
    await storage.set(key, value);
  }
}

/** Delete a secret from both the secret store and any legacy plain key. */
export async function deleteSecret(storage, key) {
  if (typeof storage.deleteSecret === 'function') {
    try { await storage.deleteSecret(key); } catch (e) { /* best-effort */ }
  }
  try { await storage.delete(key); } catch (e) { /* best-effort */ }
}
