import { describe, expect, it } from "vitest";
import { findSuggestionContainer } from "./suggestionContainer";

describe("findSuggestionContainer", () => {
  it("keeps the active composer popup out of an earlier historical editor", () => {
    document.body.innerHTML = `
      <div class="cukii-input-box">
        <div class="ProseMirror" data-editor="history"></div>
        <div data-cukii-tippy-container data-owner="history"></div>
      </div>
      <div class="cukii-input-box">
        <div class="ProseMirror" data-editor="main"></div>
        <div data-cukii-tippy-container data-owner="main"></div>
      </div>
    `;

    const activeEditor = document.querySelector<HTMLElement>(
      '[data-editor="main"]',
    )!;

    expect(findSuggestionContainer(activeEditor)?.dataset.owner).toBe("main");
  });

  it("fails closed when the editor is detached from its input shell", () => {
    const detachedEditor = document.createElement("div");
    expect(findSuggestionContainer(detachedEditor)).toBeNull();
  });
});
