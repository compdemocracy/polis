import { jest } from '@jest/globals';

describe("Config", () => {
  beforeEach(() => {
    // reset module state so we can re-import with new env vars
    jest.resetModules();
  });

  afterEach(() => {
    // restore replaced properties
    jest.restoreAllMocks();
  });

  describe("getServerNameWithProtocol", () => {
    test('returns https://pol.is by default', async () => {
      jest.replaceProperty(process, 'env', {DEV_MODE: 'false'});

      const { default: Config } = await import('../src/config');
      const req = {
        protocol: 'http',
        headers: {
          host: 'localhost'
        }
      };

      expect(Config.getServerNameWithProtocol(req)).toBe('https://pol.is');
    });

    test('returns domain override value when DOMAIN_OVERRIDE is set', async () => {
      jest.replaceProperty(process, 'env', {DEV_MODE: 'false', DOMAIN_OVERRIDE: 'example.co'});

      const { default: Config } = await import('../src/config');
      const req = {
        protocol: 'http',
        headers: {
          host: 'localhost'
        }
      };

      expect(Config.getServerNameWithProtocol(req)).toBe('http://example.co');
    });

    test('returns given req domain when DEV_MODE is true', async () => {
      jest.replaceProperty(process, 'env', {DEV_MODE: 'true', DOMAIN_OVERRIDE: 'example.co'});

      const { default: Config } = await import('../src/config');
      const req = {
        protocol: 'https',
        headers: {
          host: 'mydomain.xyz'
        }
      };

      expect(Config.getServerNameWithProtocol(req)).toBe('https://mydomain.xyz');
    });
  });
});
