import { act } from "@testing-library/react";
import { renderWithProviders } from "../../../util/test/render";
import {
  messageContentToEditorDoc,
  plainTextToEditorDoc,
} from "../../../components/cukii/userMessageEditorDoc";
import { Chat } from "../Chat";
import { newSession } from "../../../redux/slices/sessionSlice";

describe("plainTextToEditorDoc", () => {
  it("creates one paragraph per line", () => {
    const doc = plainTextToEditorDoc("first\nsecond\n\nthird");
    expect(doc.type).toBe("doc");
    const paragraphs = (doc.content as any[]).filter(
      (node) => node.type === "paragraph",
    );
    expect(paragraphs).toHaveLength(4);
    expect(paragraphs[0].content[0].text).toBe("first");
    expect(paragraphs[1].content[0].text).toBe("second");
    expect(paragraphs[2].content).toBeUndefined();
    expect(paragraphs[3].content[0].text).toBe("third");
  });
});

describe("messageContentToEditorDoc", () => {
  it("converts plain-string content", () => {
    const doc = messageContentToEditorDoc("a\nb");
    expect((doc.content as any[])[1].content[0].text).toBe("b");
  });

  it("extracts text from multimodal parts", () => {
    const doc = messageContentToEditorDoc([
      { type: "text", text: "line1\nline2" },
      {
        type: "imageUrl",
        imageUrl: { url: "data:image/svg+xml;base64,AAAA" },
      } as any,
    ]);
    const paragraphs = doc.content as any[];
    expect(paragraphs[0].content[0].text).toBe("line1");
    expect(paragraphs[1].content[0].text).toBe("line2");
  });
});

describe("user message newlines in the transcript", () => {
  it("renders broker-injected plain-text prompts with their line breaks", async () => {
    const { store, container } = await renderWithProviders(<Chat />);
    await act(async () => {
      store.dispatch(
        newSession({
          sessionId: "newline-session",
          title: "Newlines",
          history: [
            {
              message: {
                id: "plain-multiline",
                role: "user",
                content: "строка один\nстрока два\nстрока три",
              },
              contextItems: [],
            } as any,
          ],
        } as any),
      );
    });

    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-plain-multiline"]',
    );
    expect(bubble).not.toBeNull();
    const paragraphs = bubble!.querySelectorAll(".ProseMirror p");
    expect(paragraphs.length).toBe(3);
    expect(paragraphs[0].textContent).toBe("строка один");
    expect(paragraphs[1].textContent).toBe("строка два");
    expect(paragraphs[2].textContent).toBe("строка три");
  });
});
