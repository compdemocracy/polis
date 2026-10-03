// OFFLINE=1 skips the hosted services the server would otherwise call. Each
// case loads the real module under a stubbed Config with the flag on and off;
// no network, database or app startup is involved.
import { afterEach, describe, expect, jest, test } from "@jest/globals";

type AnyConfig = Record<string, unknown>;

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// jest.doMock registrations outlive resetModules, so every one made here is
// undone after each test (Akismet's case stubs modules the others load).
const mocked = new Set<string>();
function mock(path: string, factory: () => unknown): void {
  mocked.add(path);
  jest.doMock(path, factory);
}

function load<T>(
  path: string,
  config: AnyConfig,
  mocks: () => void = () => {}
): T {
  let mod: T;
  jest.isolateModules(() => {
    mock("../../src/config", () => ({ __esModule: true, default: config }));
    mock("../../src/utils/logger", () => ({
      __esModule: true,
      default: logger,
    }));
    mocks();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require(path);
  });
  return mod;
}

afterEach(() => {
  for (const path of mocked) jest.dontMock(path);
  mocked.clear();
  jest.resetModules();
  jest.clearAllMocks();
});

describe("Config.offline", () => {
  const read = (value: string | undefined) => {
    const saved = process.env.OFFLINE;
    if (value === undefined) delete process.env.OFFLINE;
    else process.env.OFFLINE = value;
    let offline: unknown;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      offline = require("../../src/config").default.offline;
    });
    if (saved === undefined) delete process.env.OFFLINE;
    else process.env.OFFLINE = saved;
    return offline;
  };

  test.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["yes", false],
    ["on", false],
    ["y", false],
    ["t", false],
    ["1", true],
    ["true", true],
    ["TRUE", true],
    [" 1 ", true],
  ])("OFFLINE=%p reads as %p", (value, expected) => {
    expect(read(value)).toBe(expected);
  });
});

describe("startup announcement", () => {
  const base = {
    nodeEnv: "production",
    SESEndpoint: undefined,
    shouldUseTranslationAPI: true,
  };

  test("flag unset: nothing is skipped and nothing is logged", () => {
    const offline = load<typeof import("../../src/utils/offline")>(
      "../../src/utils/offline",
      { ...base, offline: false }
    );
    expect(offline.offlineSkips({ ...base, offline: false })).toEqual([]);
    offline.logOfflineSkips({ ...base, offline: false });
    expect(logger.info).not.toHaveBeenCalled();
  });

  test("flag set: one line per skip, logged once however often it is called", () => {
    const config = { ...base, offline: true };
    const offline = load<typeof import("../../src/utils/offline")>(
      "../../src/utils/offline",
      config
    );
    offline.logOfflineSkips(config);
    offline.logOfflineSkips(config);
    const lines = logger.info.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(5);
    for (const name of [
      "Auth0",
      "Akismet",
      "dd-trace",
      "Google Translate",
      "SES",
    ]) {
      expect(lines.filter((l) => l.includes(name))).toHaveLength(1);
    }
  });

  test("flag set: only the services this configuration would call are announced", () => {
    const config = {
      offline: true,
      nodeEnv: "development",
      SESEndpoint: "http://ses-local:8005",
      shouldUseTranslationAPI: false,
    };
    const offline = load<typeof import("../../src/utils/offline")>(
      "../../src/utils/offline",
      config
    );
    const skips = offline.offlineSkips(config).join("\n");
    expect(skips).toMatch(/Auth0/);
    expect(skips).toMatch(/Akismet/);
    expect(skips).not.toMatch(/dd-trace|Google Translate|SES/);
  });
});

describe("dd-trace", () => {
  const offline = () =>
    load<typeof import("../../src/utils/offline")>(
      "../../src/utils/offline",
      {}
    );

  test.each([
    ["production", false, true],
    ["production", true, false],
    ["development", false, false],
    ["development", true, false],
  ])("NODE_ENV=%s OFFLINE=%p: init is %p", (nodeEnv, flag, expected) => {
    expect(
      offline().shouldInitTracer({ nodeEnv, offline: flag } as never)
    ).toBe(expected);
  });

  test("index.ts initialises the tracer only through shouldInitTracer", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../index.ts"),
      "utf8"
    );
    expect(source).toMatch(
      /if \(shouldInitTracer\(Config\)\) \{\s*\n[^\n]*\n\s*const tracer = require\("dd-trace"\)\.init\(\);/
    );
    expect(source.match(/dd-trace/g)).toHaveLength(2); // the comment and the require
  });
});

describe("Akismet key check", () => {
  // server.ts is large; load it with its heavy dependencies stubbed.
  const verifyKey = jest.fn();
  const loadServer = (offline: boolean) =>
    load(
      "../../src/server",
      {
        offline,
        adminEmails: "[]",
        isDevMode: false,
        getServerUrl: () => "https://example.invalid",
        awsRegion: "local",
      },
      () => {
        mock("akismet", () => ({ client: () => ({ verifyKey }) }));
        mock("../../src/db/pg-query", () => ({
          __esModule: true,
          default: { queryP: jest.fn() },
        }));
        mock("../../src/auth", () => ({
          generateAndRegisterZinvite: jest.fn(),
        }));
        mock("../../src/utils/pca", () => ({
          fetchAndCacheLatestPcaData: jest.fn(),
        }));
        mock("../../src/utils/participants", () => ({
          getPidsForGid: jest.fn(),
        }));
        mock("../../src/utils/file-fetcher", () => ({
          fetchIndex: jest.fn(),
          makeFileFetcher: jest.fn(),
        }));
        mock("../../src/comment", () => ({ detectLanguage: jest.fn() }));
        mock("../../src/email/senders", () => ({
          emailTeam: jest.fn(),
          sendMultipleTextEmails: jest.fn(),
          sendTextEmail: jest.fn(),
        }));
      }
    );

  test("flag unset: the key is verified at load", () => {
    loadServer(false);
    expect(verifyKey).toHaveBeenCalledTimes(1);
  });

  test("flag set: the key check is not run", () => {
    loadServer(true);
    expect(verifyKey).not.toHaveBeenCalled();
  });
});

describe("isProConvo (Auth0 Management API)", () => {
  const getByEmail = jest.fn();
  const getRoles = jest.fn();
  const loadComments = (offline: boolean) =>
    load<typeof import("../../src/routes/comments")>(
      "../../src/routes/comments",
      { offline },
      () => {
        mock("auth0", () => ({
          ManagementClient: jest.fn().mockImplementation(() => ({
            usersByEmail: { getByEmail },
            users: { getRoles },
          })),
        }));
        mock("../../src/user", () => ({
          getUserInfoForUid2: jest
            .fn()
            .mockResolvedValue({ email: "owner@example.invalid" } as never),
          getPidPromise: jest.fn(),
        }));
        mock("../../src/db/pg-query", () => ({
          __esModule: true,
          default: { queryP: jest.fn() },
        }));
        mock("../../src/utils/moderation", () => ({}));
        mock("../../src/utils/zinvite", () => ({}));
        mock("../../src/utils/metered", () => ({}));
        mock("../../src/nextComment", () => ({}));
        mock("@google-cloud/translate", () => ({
          v2: { Translate: jest.fn() },
        }));
      }
    );

  test("flag unset: the Management API decides", async () => {
    getByEmail.mockResolvedValue({ data: [{ user_id: "auth0|1" }] } as never);
    getRoles.mockResolvedValue({ data: [{ name: "delphi-enabled" }] } as never);
    await expect(loadComments(false).isProConvo(7)).resolves.toBe(true);
    expect(getByEmail).toHaveBeenCalledTimes(1);
  });

  test("flag set: false, and the Management API is never called", async () => {
    getByEmail.mockResolvedValue({ data: [{ user_id: "auth0|1" }] } as never);
    getRoles.mockResolvedValue({ data: [{ name: "delphi-enabled" }] } as never);
    await expect(loadComments(true).isProConvo(7)).resolves.toBe(false);
    expect(getByEmail).not.toHaveBeenCalled();
    expect(getRoles).not.toHaveBeenCalled();
  });
});

describe("Google Translate", () => {
  const detect = jest.fn();
  const Translate = jest
    .fn()
    .mockImplementation(() => ({ detect, translate: jest.fn() }));
  const loadComment = (offline: boolean) =>
    load<typeof import("../../src/comment")>(
      "../../src/comment",
      { offline, shouldUseTranslationAPI: true },
      () => {
        mock("@google-cloud/translate", () => ({ v2: { Translate } }));
        mock("../../src/db/pg-query", () => ({
          __esModule: true,
          default: { queryP: jest.fn() },
        }));
        mock("../../src/routes/comments", () => ({ isProConvo: jest.fn() }));
      }
    );

  test("flag unset: SHOULD_USE_TRANSLATION_API builds the client and detects", async () => {
    detect.mockResolvedValue([{ language: "fr", confidence: 0.9 }] as never);
    const { detectLanguage } = loadComment(false);
    expect(Translate).toHaveBeenCalledTimes(1);
    await expect(detectLanguage("bonjour")).resolves.toEqual([
      { language: "fr", confidence: 0.9 },
    ]);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  test("flag set: no client is built and the provider is never called", async () => {
    const { detectLanguage } = loadComment(true);
    expect(Translate).not.toHaveBeenCalled();
    await detectLanguage("bonjour");
    expect(detect).not.toHaveBeenCalled();
  });
});

describe("SES email", () => {
  const send = jest.fn();
  const loadSenders = (config: AnyConfig) =>
    load<typeof import("../../src/email/senders")>(
      "../../src/email/senders",
      { awsRegion: "us-east-1", ...config },
      () => {
        mock("@aws-sdk/client-sesv2", () => ({
          SESv2Client: jest.fn().mockImplementation(() => ({ send })),
          SendEmailCommand: jest
            .fn()
            .mockImplementation((input) => ({ input })),
        }));
      }
    );

  test("flag unset: the message goes to SES", async () => {
    send.mockResolvedValue({ MessageId: "id-1" } as never);
    const { sendTextEmail } = loadSenders({ offline: false });
    await expect(
      sendTextEmail("a@example.invalid", "b@example.invalid", "S", "T")
    ).resolves.toEqual({ MessageId: "id-1" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("flag set, no SES_ENDPOINT: not sent; subject logged at debug, no recipient", async () => {
    const { sendTextEmail } = loadSenders({ offline: true });
    await expect(
      sendTextEmail("a@example.invalid", "b@example.invalid", "Subject", "Body")
    ).resolves.toEqual({ $metadata: {} });
    expect(send).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith("polis_email_not_sent_offline", {
      subject: "Subject",
    });
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(
      "b@example.invalid"
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  test("flag set with SES_ENDPOINT (a local inbox): the message is sent there", async () => {
    send.mockResolvedValue({ MessageId: "id-2" } as never);
    const { sendTextEmail } = loadSenders({
      offline: true,
      SESEndpoint: "http://ses-local:8005",
    });
    await sendTextEmail("a@example.invalid", "b@example.invalid", "S", "T");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
