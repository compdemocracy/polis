/*
 * The comment text one TopicMap holds for its tooltips. No DOM and no Solid
 * here, so the tests run in Node.
 *
 * A reader is the report, the conversation id and moderation level the host
 * gave (if any), and the token (none for the public page). The text read for
 * one reader is kept for that reader only: asked again by the same reader it
 * is the same answer, and asked by any other (a token added, changed or
 * removed; another report) the old answer is dropped and the text is read
 * again. Nothing is shared between two components, so a signed-in placement
 * and an anonymous one in the same document never see each other's text.
 * A host whose own fetch carries a credential of its own (a cookie) keeps
 * one reader per component: it changes the token, or mounts another.
 */
export function commentTextFor(read) {
  let held = null;
  return function textFor({ reportId, conversationId = null, modLevel = null, token = null, ids }) {
    // ids, when given: the comment ids of the map the text is for (the read
    // keeps nothing else), so another map's ids make another reader too.
    const reader = JSON.stringify([reportId, conversationId || null, modLevel ?? null, token || null, ids ?? null]);
    const asked = { reportId, conversationId, modLevel, token };
    if (ids !== undefined) asked.ids = ids;
    // a revoked read (its map went: deepZoom.js readerData) is read afresh
    if (!held || held.reader !== reader || (held.text && held.text.revoked === true)) held = { reader, text: read(asked) };
    return held.text;
  };
}
