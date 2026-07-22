import { describe, expect, test } from 'bun:test';

import {
  parseSystemProxyConfig,
  readMacosSystemProxy,
  type SystemProxyCommand,
} from './macos-system-proxy.ts';

describe('parseSystemProxyConfig', () => {
  test('parses enabled HTTP and HTTPS proxies from scutil output', () => {
    const output = `<dictionary> {
  ExcludeSimpleHostnames : 0
  HTTPEnable : 1
  HTTPPort : 9674
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 9675
  HTTPSProxy : 10.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`;
    expect(parseSystemProxyConfig(output)).toEqual({
      http: 'http://127.0.0.1:9674',
      https: 'http://10.0.0.1:9675',
    });
  });

  test('ignores proxies that are not enabled', () => {
    const output = `<dictionary> {
  HTTPEnable : 0
  HTTPPort : 9674
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 9675
  HTTPSProxy : 10.0.0.1
}`;
    expect(parseSystemProxyConfig(output)).toEqual({
      https: 'http://10.0.0.1:9675',
    });
  });

  test('returns empty config when no proxies are configured', () => {
    const output = `<dictionary> {
  ExcludeSimpleHostnames : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`;
    expect(parseSystemProxyConfig(output)).toEqual({});
  });

  test('ignores enabled proxy that has no host', () => {
    const output = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 9674
}`;
    expect(parseSystemProxyConfig(output)).toEqual({});
  });

  test('builds proxy url without port when port is absent', () => {
    const output = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : proxy.internal
}`;
    expect(parseSystemProxyConfig(output)).toEqual({
      http: 'http://proxy.internal',
    });
  });
});

describe('readMacosSystemProxy', () => {
  test('returns empty config on non-darwin platforms without running the command', () => {
    let called = false;
    const runCommand: SystemProxyCommand = () => {
      called = true;
      return '';
    };
    expect(readMacosSystemProxy({ platform: 'linux', runCommand })).toEqual({});
    expect(called).toBe(false);
  });

  test('parses scutil output on darwin using injected command', () => {
    const runCommand: SystemProxyCommand = (command, args) => {
      expect(command).toBe('/usr/sbin/scutil');
      expect(args).toEqual(['--proxy']);
      return `<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : 127.0.0.1
}`;
    };
    expect(readMacosSystemProxy({ platform: 'darwin', runCommand })).toEqual({
      https: 'http://127.0.0.1:8443',
    });
  });

  test('returns empty config when the command throws', () => {
    const runCommand: SystemProxyCommand = () => {
      throw new Error('scutil not found');
    };
    expect(readMacosSystemProxy({ platform: 'darwin', runCommand })).toEqual({});
  });
});
