import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  generateRandomXid,
  setupAuthAndConvo,
} from "../setup/api-test-helpers";
import {
  createXidRecord,
  getXidRecord,
  getXids,
  isXidAllowed,
  xidExists,
} from "../../src/xids";
import { getZidFromConversationId } from "../../src/conversation";
import pg from "../../src/db/pg-query";

/**
 * Core XID function tests
 * Tests the fundamental XID CRUD operations and lookup strategies
 */
describe("Core XID Functions", () => {
  let ownerUid: number;
  let conversationId: string;
  let zid: number;

  beforeAll(async () => {
    const setup = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 1,
    });

    ownerUid = setup.userId;
    conversationId = setup.conversationId;
    zid = await getZidFromConversationId(conversationId);
  });

  describe("createXidRecord()", () => {
    test("should create XID record with all fields", async () => {
      const xid = generateRandomXid();

      await createXidRecord(
        xid,
        ownerUid,
        ownerUid,
        zid,
        "https://example.com/avatar.jpg",
        "Test User",
        "test@example.com"
      );

      const records = await getXidRecord(xid, zid);
      expect(records).toHaveLength(1);
      expect(records[0].xid).toBe(xid);
      expect(records[0].owner).toBe(ownerUid);
      expect(records[0].uid).toBe(ownerUid);
      expect(records[0].zid).toBe(zid);
      expect(records[0].x_profile_image_url).toBe(
        "https://example.com/avatar.jpg"
      );
      expect(records[0].x_name).toBe("Test User");
      expect(records[0].x_email).toBe("test@example.com");
    });

    test("should handle UPSERT on conflict", async () => {
      const xid = generateRandomXid();

      // Create initial record
      await createXidRecord(xid, ownerUid, ownerUid, zid);

      // Create again with new data (should upsert)
      await createXidRecord(
        xid,
        ownerUid,
        ownerUid,
        zid,
        "https://new-avatar.com"
      );

      // Should still have only one record with updated data
      const records = await getXidRecord(xid, zid);
      expect(records).toHaveLength(1);
      expect(records[0].x_profile_image_url).toBe("https://new-avatar.com");
    });
  });

  describe("getXidRecord()", () => {
    test("should lookup XID by zid", async () => {
      const xid = generateRandomXid();
      await createXidRecord(xid, ownerUid, ownerUid, zid);

      const records = await getXidRecord(xid, zid);
      expect(records).toHaveLength(1);
      expect(records[0].xid).toBe(xid);
    });

    test("should lookup XID by owner", async () => {
      const xid = generateRandomXid();
      await createXidRecord(xid, ownerUid, ownerUid); // No zid

      const records = await getXidRecord(xid, undefined, ownerUid);
      expect(records).toHaveLength(1);
      expect(records[0].xid).toBe(xid);
      expect(records[0].zid).toBeNull();
    });

    test("should return empty array when XID not found", async () => {
      const nonExistentXid = "non-existent-xid-12345";
      const records = await getXidRecord(nonExistentXid, zid);
      expect(records).toHaveLength(0);
    });

    test("should handle null values correctly", async () => {
      const xid = generateRandomXid();
      await createXidRecord(xid, ownerUid, ownerUid);

      // Null should fallback to owner lookup
      const records = await getXidRecord(xid, null, ownerUid);
      expect(records).toHaveLength(1);
    });
  });

  describe("isXidAllowed()", () => {
    test("should check allow list by zid", async () => {
      const xid = generateRandomXid();

      // Add to allow list
      await pg.queryP(
        "INSERT INTO xid_whitelist (xid, zid, owner) VALUES ($1, $2, $3)",
        [xid, zid, ownerUid]
      );

      const isAllowed = await isXidAllowed(xid, zid);
      expect(isAllowed).toBe(true);

      // Clean up
      await pg.queryP("DELETE FROM xid_whitelist WHERE xid = $1 AND zid = $2", [
        xid,
        zid,
      ]);
    });

    test("should return false for non-allowed XID", async () => {
      const nonAllowedXid = "not-allowed-xid-123";
      const isAllowed = await isXidAllowed(nonAllowedXid, zid);
      expect(isAllowed).toBe(false);
    });
  });

  describe("xidExists()", () => {
    test("should return true when XID exists", async () => {
      const xid = generateRandomXid();
      await createXidRecord(xid, ownerUid, ownerUid, zid);

      const exists = await xidExists(xid, ownerUid, ownerUid);
      expect(exists).toBeTruthy();
    });

    test("should return false when XID does not exist", async () => {
      const nonExistentXid = "non-existent-123";
      const exists = await xidExists(nonExistentXid, ownerUid, ownerUid);
      expect(exists).toBeFalsy();
    });
  });

  describe("getXids()", () => {
    test("should return empty array for conversation with no XID participants", async () => {
      const { conversationId: newConvId } = await setupAuthAndConvo({
        createConvo: true,
        commentCount: 0,
      });
      const newZid = await getZidFromConversationId(newConvId);

      const xids = await getXids(newZid);
      expect(Array.isArray(xids)).toBe(true);
      expect(xids).toHaveLength(0);
    });
  });
});
