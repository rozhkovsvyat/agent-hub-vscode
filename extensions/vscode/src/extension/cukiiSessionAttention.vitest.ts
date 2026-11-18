import { describe, expect, it, vi } from "vitest";
import { CukiiSessionAttentionRegistry } from "./cukiiSessionAttention";

describe("CukiiSessionAttentionRegistry", () => {
  it("reports nothing for a session it has never heard of", () => {
    expect(new CukiiSessionAttentionRegistry().attentionFor("s1")).toBe("none");
  });

  it("keeps a session working until the last overlapping run ends", () => {
    const attention = new CukiiSessionAttentionRegistry();
    attention.runStarted("s1", "run-1");
    // A replacement run overlaps its predecessor for as long as the old vendor
    // process takes to die.
    attention.runStarted("s1", "run-2");
    attention.runEnded("s1", "run-1");
    expect(attention.attentionFor("s1")).toBe("streaming");

    attention.runEnded("s1", "run-2");
    expect(attention.attentionFor("s1")).toBe("none");
  });

  it("lets a prompt outrank the run that raised it, then falls back", () => {
    const attention = new CukiiSessionAttentionRegistry();
    attention.runStarted("s1", "run-1");
    attention.promptsChanged("s1", ["req-1"]);
    expect(attention.attentionFor("s1")).toBe("pending-permission");

    attention.promptsChanged("s1", []);
    expect(attention.attentionFor("s1")).toBe("streaming");
  });

  it("follows the broker's own set, including prompts it settled itself", () => {
    const attention = new CukiiSessionAttentionRegistry();
    attention.promptsChanged("s1", ["req-1", "req-2"]);
    // The broker timed req-1 out on its own and re-reported what is left; a
    // registry that only counted openings would still say two.
    attention.promptsChanged("s1", ["req-2"]);
    expect(attention.attentionFor("s1")).toBe("pending-permission");
    attention.promptsChanged("s1", []);
    expect(attention.attentionFor("s1")).toBe("none");
  });

  it("keeps sessions apart", () => {
    const attention = new CukiiSessionAttentionRegistry();
    attention.runStarted("s1", "run-1");
    attention.promptsChanged("s2", ["req-1"]);
    expect(attention.attentionFor("s1")).toBe("streaming");
    expect(attention.attentionFor("s2")).toBe("pending-permission");
    expect(attention.attentionFor("s3")).toBe("none");
  });

  it("drops everything for a closed panel's session", () => {
    const attention = new CukiiSessionAttentionRegistry();
    attention.runStarted("s1", "run-1");
    attention.promptsChanged("s1", ["req-1"]);
    attention.forgetSession("s1");
    expect(attention.attentionFor("s1")).toBe("none");
  });

  it("notifies on a visible transition and stays quiet otherwise", () => {
    const attention = new CukiiSessionAttentionRegistry();
    const listener = vi.fn();
    attention.onChange(listener);

    attention.runStarted("s1", "run-1");
    expect(listener).toHaveBeenCalledTimes(1);

    // Second concurrent run: still "streaming", nothing for the drawer to
    // repaint. Waking it per stream frame is what this guards against.
    attention.runStarted("s1", "run-2");
    expect(listener).toHaveBeenCalledTimes(1);

    attention.promptsChanged("s1", ["req-1"]);
    expect(listener).toHaveBeenCalledTimes(2);

    attention.runEnded("s1", "run-1");
    expect(listener).toHaveBeenCalledTimes(2);

    attention.promptsChanged("s1", []);
    expect(listener).toHaveBeenCalledTimes(3);
    attention.runEnded("s1", "run-2");
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("does not notify when forgetting a session it never tracked", () => {
    const attention = new CukiiSessionAttentionRegistry();
    const listener = vi.fn();
    attention.onChange(listener);
    attention.forgetSession("never-seen");
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops calling a disposed listener", () => {
    const attention = new CukiiSessionAttentionRegistry();
    const listener = vi.fn();
    const subscription = attention.onChange(listener);
    attention.runStarted("s1", "run-1");
    subscription.dispose();
    attention.runEnded("s1", "run-1");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores a blank session id instead of inventing a bucket for it", () => {
    const attention = new CukiiSessionAttentionRegistry();
    const listener = vi.fn();
    attention.onChange(listener);
    attention.runStarted("", "run-1");
    expect(attention.attentionFor("")).toBe("none");
    expect(listener).not.toHaveBeenCalled();
  });
});
