import { describe, expect, it } from "vitest";
import { projectedHistoryMatches } from "../src/target/v2/history.js";

describe("projectedHistoryMatches", () => {
  it("matches complete projected turn items and plans without depending on event IDs", () => {
    const expected = [
      { id: "new-message-event-id", type: "message.updated", payload: { id: "expected-message", threadId: "expected-thread", role: "user", text: "hello", attachments: [] } },
      { id: "new-event-id", type: "turn-item.updated", payload: { id: "expected-item", threadId: "expected-thread", messageId: "expected-message", ordinal: 1, type: "user_message", text: "hello" } },
      { id: "new-plan-event-id", type: "plan.updated", payload: { id: "plan-1", threadId: "thread-1", kind: "proposed_plan", markdown: "do it" } },
    ];
    const actual = {
      messages: [{ id: "built-in-message", threadId: "built-in-thread", role: "user", text: "hello", attachments: [] }],
      turnItems: [{ id: "built-in-item", threadId: "built-in-thread", messageId: "built-in-message", ordinal: 17, type: "user_message", text: "hello" }],
      plans: [{ id: "plan-1", threadId: "thread-1", kind: "proposed_plan", markdown: "do it" }],
    };

    expect(projectedHistoryMatches(actual, expected, { identity: "semantic" })).toBe(true);
  });

  it("rejects missing, extra, or changed projected history", () => {
    const expected = [
      { type: "turn-item.updated", payload: { id: "item-1", text: "hello" } },
    ];

    expect(projectedHistoryMatches({ messages: [], turnItems: [], plans: [] }, expected, { identity: "semantic" })).toBe(false);
    expect(projectedHistoryMatches({ messages: [], turnItems: [{ id: "item-1", text: "changed" }], plans: [] }, expected)).toBe(false);
    expect(projectedHistoryMatches({ messages: [], turnItems: [{ id: "item-1", text: "hello" }, { id: "extra" }], plans: [] }, expected)).toBe(false);
  });

  it("requires the plan projection to match and be present", () => {
    const expected = [{ type: "plan.updated", payload: { id: "plan-1", markdown: "plan" } }];

    expect(projectedHistoryMatches({ messages: [], turnItems: [], plans: [{ id: "plan-1", markdown: "different" }] }, expected)).toBe(false);
    expect(projectedHistoryMatches({ messages: [], turnItems: [] }, expected)).toBe(false);
  });

  it("keeps deterministic projected identities strict in exact mode", () => {
    const expected = [{ type: "turn-item.updated", payload: { id: "item-1", threadId: "thread-1", ordinal: 1, text: "hello" } }];

    expect(projectedHistoryMatches({ messages: [], turnItems: [{ id: "item-1", threadId: "thread-1", ordinal: 9, text: "hello" }], plans: [] }, expected)).toBe(true);
    expect(projectedHistoryMatches({ messages: [], turnItems: [{ id: "built-in-item", threadId: "thread-1", ordinal: 9, text: "hello" }], plans: [] }, expected)).toBe(false);
  });

  it("rejects a projected message change even when its turn item still matches", () => {
    const expected = [
      { type: "message.updated", payload: { id: "message-1", threadId: "thread-1", role: "user", text: "hello", attachments: [] } },
      { type: "turn-item.updated", payload: { id: "item-1", threadId: "thread-1", messageId: "message-1", type: "user_message", text: "hello" } },
    ];
    const item = { id: "item-1", threadId: "thread-1", messageId: "message-1", type: "user_message", text: "hello" };

    for (const message of [
      { id: "message-1", threadId: "thread-1", role: "user", text: "changed", attachments: [] },
      { id: "message-1", threadId: "thread-1", role: "assistant", text: "hello", attachments: [] },
      { id: "message-1", threadId: "thread-1", role: "user", text: "hello", attachments: [{ id: "image-1" }] },
    ]) {
      expect(projectedHistoryMatches({ messages: [message], turnItems: [item], plans: [] }, expected)).toBe(false);
      expect(projectedHistoryMatches({ messages: [message], turnItems: [item], plans: [] }, expected, { identity: "semantic" })).toBe(false);
    }
  });
});
