// Provider registry. See README.md in this directory for the interface every
// provider implements and for how to add one.

import spypoint from './spypoint.mjs';
import moultrie from './moultrie.mjs';

export const PROVIDERS = { spypoint, moultrie };

export const providerIds = () => Object.keys(PROVIDERS);

// Implemented ones only — what the CLI should offer and what a "sync
// everything" run should attempt.
export const usableProviders = () =>
  Object.values(PROVIDERS).filter(p => p.implemented !== false);

export function getProvider(id) {
  const p = PROVIDERS[String(id ?? '').toLowerCase()];
  if (!p) {
    throw new Error(
      `unknown provider "${id}". Available: ${providerIds().join(', ')}`);
  }
  // A provider that exists but is not built yet explains itself, rather than
  // failing later with something cryptic from inside a fetch.
  if (p.implemented === false) throw new Error(p.why);
  return p;
}

// Credentials come from <PREFIX>_EMAIL / <PREFIX>_PASSWORD so several brands
// can be configured at once without colliding.
export function credentialsFor(provider, env = process.env) {
  return {
    email: env[`${provider.envPrefix}_EMAIL`] ?? null,
    password: env[`${provider.envPrefix}_PASSWORD`] ?? null,
  };
}
