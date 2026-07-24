import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

import { loadMacosTrustedCertificates } from './macos-trusted-certificates.ts';
import { readMacosSystemProxy, type SystemProxyConfig } from './macos-system-proxy.ts';
import { fetchWithConnectionRecovery } from './recovering-fetch.ts';

export interface TuiProviderTransportEnvironment {
  readonly [key: string]: string | undefined;
  readonly HTTP_PROXY?: string;
  readonly http_proxy?: string;
  readonly HTTPS_PROXY?: string;
  readonly https_proxy?: string;
  readonly ALL_PROXY?: string;
  readonly all_proxy?: string;
  readonly NO_PROXY?: string;
  readonly no_proxy?: string;
  readonly PEER_EXTRA_CA_CERTS?: string;
  readonly NODE_EXTRA_CA_CERTS?: string;
}

interface NoProxyRule {
  readonly hostname: string;
  readonly port?: string;
  readonly suffix: boolean;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function parseNoProxy(value: string | undefined): NoProxyRule[] {
  if (!value) return [];
  const rules: NoProxyRule[] = [];
  for (const entry of value.split(/[\s,]+/)) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed === '*') {
      rules.push({ hostname: '*', suffix: true });
      continue;
    }

    const bracketed = trimmed.match(/^\[([^\]]+)](?::(\d+))?$/);
    if (bracketed) {
      rules.push({ hostname: bracketed[1] ?? '', port: bracketed[2], suffix: false });
      continue;
    }

    const separator = trimmed.lastIndexOf(':');
    const hasPort = separator > -1 && /^\d+$/.test(trimmed.slice(separator + 1));
    const rawHostname = hasPort ? trimmed.slice(0, separator) : trimmed;
    rules.push({
      hostname: rawHostname.replace(/^\*?\./, ''),
      port: hasPort ? trimmed.slice(separator + 1) : undefined,
      suffix: rawHostname.startsWith('.') || rawHostname.startsWith('*.'),
    });
  }
  return rules;
}

export function shouldBypassProxy(url: URL, noProxy: string | undefined): boolean {
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return parseNoProxy(noProxy).some((rule) => {
    if (rule.hostname === '*') return true;
    if (rule.port && rule.port !== port) return false;
    if (hostname === rule.hostname) return true;
    return rule.suffix && hostname.endsWith(`.${rule.hostname}`);
  });
}

export function proxyForUrl(
  url: URL,
  env: TuiProviderTransportEnvironment,
  systemProxy: SystemProxyConfig = {},
): string | undefined {
  const noProxy = firstNonEmpty(env.NO_PROXY, env.no_proxy);
  if (shouldBypassProxy(url, noProxy)) return undefined;
  const allProxy = firstNonEmpty(env.ALL_PROXY, env.all_proxy);
  if (url.protocol === 'https:') {
    return firstNonEmpty(env.HTTPS_PROXY, env.https_proxy, allProxy, systemProxy.https);
  }
  if (url.protocol === 'http:') {
    return firstNonEmpty(env.HTTP_PROXY, env.http_proxy, allProxy, systemProxy.http);
  }
  return allProxy;
}

export function resolveExtraCaPath(
  env: TuiProviderTransportEnvironment,
): string | undefined {
  return firstNonEmpty(env.PEER_EXTRA_CA_CERTS, env.NODE_EXTRA_CA_CERTS);
}

export interface CreateTuiProviderFetchOptions {
  readonly env?: TuiProviderTransportEnvironment;
  readonly readFile?: typeof readFileSync;
  readonly systemRootCertificates?: readonly string[];
  readonly macosTrustedCertificates?: readonly string[];
  /**
   * Optional fixed system proxy. When omitted, macOS system proxy is re-read
   * on each request so network/proxy recovery after jitter does not require
   * restarting the CLI.
   */
  readonly systemProxy?: SystemProxyConfig;
  /** Optional system-proxy reader used when `systemProxy` is not fixed. */
  readonly readSystemProxy?: () => SystemProxyConfig;
  readonly fetch?: typeof globalThis.fetch;
  /** Disable connect/request recovery (useful in focused unit tests). */
  readonly connectionRecovery?: boolean;
}

export function mergeTrustedCertificates(
  builtInRoots: readonly string[],
  macosTrusted: readonly string[],
  explicitExtraCa?: string,
): string[] {
  const certificates = new Set([...builtInRoots, ...macosTrusted]);
  if (explicitExtraCa?.trim()) certificates.add(explicitExtraCa);
  return [...certificates];
}

/**
 * Creates the TUI provider transport. Proxy routing stays in this adapter and
 * additional CAs extend, rather than replace, the platform trust store.
 *
 * Transient connection failures (reset / timeout / fetch failed) are retried
 * once with a short backoff so network jitter does not force a CLI restart.
 */
export function createTuiProviderFetch(
  options: CreateTuiProviderFetchOptions = {},
): typeof globalThis.fetch {
  const env = options.env ?? process.env;
  const extraCaPath = resolveExtraCaPath(env);
  const extraCa = extraCaPath
    ? (options.readFile ?? readFileSync)(extraCaPath, 'utf8')
    : undefined;
  const macosTrusted = options.macosTrustedCertificates ?? loadMacosTrustedCertificates();
  const ca = mergeTrustedCertificates(
    options.systemRootCertificates ?? rootCertificates,
    macosTrusted,
    extraCa,
  );
  const underlyingFetch = options.fetch ?? globalThis.fetch;
  const fixedSystemProxy = options.systemProxy;
  const readSystemProxy = options.readSystemProxy ?? readMacosSystemProxy;
  const connectionRecovery = options.connectionRecovery !== false;

  const providerFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    );
    // Re-read system proxy unless the caller fixed one. This avoids sticky
    // proxy/no-proxy state after VPN or network recovery without restarting.
    const systemProxy = fixedSystemProxy ?? readSystemProxy();
    const proxy = proxyForUrl(url, env, systemProxy);
    const requestInit = {
      ...init,
      proxy,
      tls: {
        ca,
        rejectUnauthorized: true,
      },
    } as RequestInit;

    if (!connectionRecovery) {
      return underlyingFetch(input, requestInit);
    }

    return fetchWithConnectionRecovery(input, requestInit, {
      fetchImpl: underlyingFetch,
    });
  };

  return Object.assign(providerFetch, {
    preconnect: typeof underlyingFetch.preconnect === 'function'
      ? underlyingFetch.preconnect.bind(underlyingFetch)
      : undefined,
  });
}
