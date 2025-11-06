import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import pg from "../../src/db/pg-query";
import { failJson } from "../../src/utils/fail";

// Mock DB and helpers used by the route
jest.mock("../../src/db/pg-query", () => {
  return {
    __esModule: true,
    default: {
      queryP_readOnly: jest.fn(),
    },
  };
});

jest.mock("../../src/utils/common", () => ({
  // Keep other exports untouched if needed
  __esModule: true,
  isPolisDev: jest.fn(),
}));

jest.mock("../../src/server-helpers", () => ({
  __esModule: true,
  // Pass-through other helpers if ever imported elsewhere in the file under test
  addConversationIds: jest.fn((rows: any[]) => Promise.resolve(rows)),
  buildConversationUrl: jest.fn(
    (req: any, id: string) => `https://pol.is/${id}`
  ),
  finishOne: jest.fn(),
  getOneConversation: jest.fn(),
  sendEmailByUid: jest.fn(),
  updateConversationModifiedTime: jest.fn(),
}));

jest.mock("../../src/utils/fail", () => ({
  __esModule: true,
  failJson: jest.fn(),
}));

// Import after mocks so they take effect
import { handle_GET_all_conversations } from "../../src/routes/conversations";
import { isPolisDev } from "../../src/utils/common";

function createRes() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { status, json } as any;
}

describe("conversations routes - handle_GET_all_conversations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 403 for non-admin users", async () => {
    (isPolisDev as jest.Mock).mockReturnValue(false);

    const req = { p: { uid: 123, limit: 10, offset: 0 } } as any;
    const res = createRes();

    await handle_GET_all_conversations(req, res);

    expect(failJson).toHaveBeenCalledWith(
      res,
      403,
      "polis_err_no_access_for_this_user"
    );
    expect(pg.queryP_readOnly).not.toHaveBeenCalled();
  });

  it("returns paginated conversations for admin users", async () => {
    (isPolisDev as jest.Mock).mockReturnValue(true);

    // First call: main SELECT query (page rows), Second call: COUNT query
    (pg.queryP_readOnly as jest.Mock)
      .mockResolvedValueOnce([
        {
          zid: 1,
          owner: 999,
          created: Date.now(),
          modified: Date.now(),
          conversation_id: "abc",
          is_active: true,
          is_draft: false,
          is_public: true,
          context: null,
        },
        {
          zid: 2,
          owner: 888,
          created: Date.now(),
          modified: Date.now(),
          conversation_id: "def",
          is_active: true,
          is_draft: false,
          is_public: true,
          context: null,
        },
      ])
      .mockResolvedValueOnce([{ count: "3" }]);

    const req = { p: { uid: 1, limit: 2, offset: 0 } } as any;
    const res = createRes();

    await handle_GET_all_conversations(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.status as jest.Mock).mock.results[0].value.json.mock
      .calls[0][0];

    expect(payload).toHaveProperty("conversations");
    expect(Array.isArray(payload.conversations)).toBe(true);
    expect(payload.conversations.length).toBe(2);

    expect(payload).toHaveProperty("pagination");
    expect(payload.pagination).toMatchObject({
      limit: 2,
      offset: 0,
      total: 3,
      hasMore: true,
    });

    // Validate that DB was called twice: count and page
    expect(pg.queryP_readOnly).toHaveBeenCalledTimes(2);
  });
});
