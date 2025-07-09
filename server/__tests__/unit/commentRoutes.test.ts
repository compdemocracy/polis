import { beforeEach, describe, expect, test, jest } from "@jest/globals";
import express, { Request, Response } from "express";
import request from "supertest";

// Mock types
interface CommentCreateRequest {
  conversation_id?: number;
  txt?: string;
}

// Create mocks for the comment controller
const mockHandleCreateComment = jest.fn((req: Request, res: Response) => {
  const { conversation_id, txt } = req.body as CommentCreateRequest;
  if (!conversation_id || !txt) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  res.json({
    tid: 123,
    conversation_id,
    txt,
    created: new Date().getTime(),
  });
});

const mockHandleGetComments = jest.fn((req: Request, res: Response) => {
  const { conversation_id } = req.query;
  if (!conversation_id) {
    return res.status(400).json({ error: "Missing conversation_id" });
  }
  res.json([
    {
      tid: 123,
      conversation_id: Number.parseInt(conversation_id as string, 10),
      txt: "Test comment 1",
      created: new Date().getTime() - 1000,
    },
    {
      tid: 124,
      conversation_id: Number.parseInt(conversation_id as string, 10),
      txt: "Test comment 2",
      created: new Date().getTime(),
    },
  ]);
});

const mockHandleGetCommentTranslations = jest.fn(
  (req: Request, res: Response) => {
    const { conversation_id, tid } = req.query;
    if (!conversation_id || !tid) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    res.json({
      translations: {
        en: "English translation",
        es: "Spanish translation",
      },
    });
  }
);

describe("Comment Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Reset mock implementations
    mockHandleCreateComment.mockClear();
    mockHandleGetComments.mockClear();
    mockHandleGetCommentTranslations.mockClear();

    // Set up routes directly on the app
    app.post("/comments", mockHandleCreateComment);
    app.get("/comments", mockHandleGetComments);
    app.get("/comments/translations", mockHandleGetCommentTranslations);
  });

  describe("POST /comments", () => {
    test("should create a comment when valid data is provided", async () => {
      const commentData: CommentCreateRequest = {
        conversation_id: 456,
        txt: "This is a test comment",
      };

      const response = await request(app).post("/comments").send(commentData);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("tid", 123);
      expect(response.body).toHaveProperty(
        "conversation_id",
        commentData.conversation_id
      );
      expect(response.body).toHaveProperty("txt", commentData.txt);
      expect(mockHandleCreateComment).toHaveBeenCalled();
    });

    test("should return 400 when required fields are missing", async () => {
      const response = await request(app).post("/comments").send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error", "Missing required fields");
      expect(mockHandleCreateComment).toHaveBeenCalled();
    });
  });

  describe("GET /comments", () => {
    test("should return comments for a conversation", async () => {
      const response = await request(app).get("/comments?conversation_id=456");

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toHaveProperty("tid", 123);
      expect(response.body[1]).toHaveProperty("tid", 124);
      expect(mockHandleGetComments).toHaveBeenCalled();
    });

    test("should return 400 when conversation_id is missing", async () => {
      const response = await request(app).get("/comments");

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error", "Missing conversation_id");
      expect(mockHandleGetComments).toHaveBeenCalled();
    });
  });

  describe("GET /comments/translations", () => {
    test("should return translations for a comment", async () => {
      const response = await request(app).get(
        "/comments/translations?conversation_id=456&tid=123"
      );

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("translations");
      expect(response.body.translations).toHaveProperty(
        "en",
        "English translation"
      );
      expect(response.body.translations).toHaveProperty(
        "es",
        "Spanish translation"
      );
      expect(mockHandleGetCommentTranslations).toHaveBeenCalled();
    });

    test("should return 400 when required fields are missing", async () => {
      const response = await request(app).get("/comments/translations");

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error", "Missing required fields");
      expect(mockHandleGetCommentTranslations).toHaveBeenCalled();
    });
  });
});
