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

    test('returns https://embed.pol.is when req domain contains embed.pol.is', async () => {
      jest.replaceProperty(process, 'env', {DEV_MODE: 'true', DOMAIN_OVERRIDE: 'example.co'});

      const { default: Config } = await import('../src/config');
      const req = {
        protocol: 'https',
        headers: {
          host: 'embed.pol.is'
        }
      };

      expect(Config.getServerNameWithProtocol(req)).toBe('https://embed.pol.is');
    });
  });

  describe("getServerUrl", () => {
    test('returns API_PROD_HOSTNAME when DEV_MODE is false', async () => {
      jest.replaceProperty(process, 'env', {DEV_MODE: 'false', API_PROD_HOSTNAME: 'example.com'});

      const { default: Config } = await import('../src/config');

      expect(Config.getServerUrl()).toBe('https://example.com');
    });

    test('returns https://pol.is when DEV_MODE is false and API_PROD_HOSTNAME is not set', async () => {
      jest.replaceProperty(process, 'env', {DEV_MODE: 'false'});

      const { default: Config } = await import('../src/config');

      expect(Config.getServerUrl()).toBe('https://pol.is');
    });

    test('returns API_DEV_HOSTNAME when DEV_MODE is true', async () => {
      jest.replaceProperty(process, 'env', {DEV_MODE: 'true', API_DEV_HOSTNAME: 'dev.example.com'});

      const { default: Config } = await import('../src/config');

      expect(Config.getServerUrl()).toBe('http://dev.example.com');
    });

    test('returns http://localhost:5000 when DEV_MODE is true and DEV_URL is not set', async () => {
      jest.replaceProperty(process, 'env', {DEV_MODE: 'true'});

      const { default: Config } = await import('../src/config');

      expect(Config.getServerUrl()).toBe('http://localhost:5000');
    });
  });

  describe("whitelistItems", () => {
    test('returns an array of whitelisted items', async () => {
      jest.replaceProperty(process, 'env', {
        DOMAIN_WHITELIST_ITEM_01: 'item1',
        DOMAIN_WHITELIST_ITEM_02: '',
        DOMAIN_WHITELIST_ITEM_03: 'item3',
      });

      const { default: Config } = await import('../src/config');

      expect(Config.whitelistItems).toEqual(['item1', 'item3']);
    });
  });
});
