import { describe, expect, it } from "vitest";
import {
  CUKII_SNAPSHOT_TEXT_BUDGET,
  pruneCukiiSnapshotToViewport,
  sanitizeCukiiSnapshotClone,
} from "./captureChatSnapshot";

function rect(top: number, bottom: number, left = 0, right = 800): DOMRect {
  return {
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("sanitizeCukiiSnapshotClone", () => {
  it("removes overlays and every externally loadable URL", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="cukii-report-overlay">form contents</div>
      <div class="cukii-command-menu">menu contents</div>
      <a href="https://secret.example/path">open</a>
      <img src="https://secret.example/image.png"
           srcset="https://secret.example/2x.png 2x"
           alt="token=super-secret-token" />
      <video poster="https://secret.example/poster.png"></video>
      <form action="https://secret.example/submit">
        <button formaction="https://secret.example/button">submit</button>
      </form>
      <iframe src="https://secret.example/frame"
              srcdoc="&lt;img src=https://secret.example/srcdoc&gt;"></iframe>
      <object data="https://secret.example/object"></object>
      <embed src="https://secret.example/embed" />
      <blockquote cite="https://secret.example/citation">quote</blockquote>
      <table background="https://secret.example/table.png"><tr><td>cell</td></tr></table>
      <svg xmlns="http://www.w3.org/2000/svg"
           xmlns:xlink="http://www.w3.org/1999/xlink">
        <use xlink:href="https://secret.example/icons.svg#check"></use>
        <image href="https://secret.example/svg-image.png"></image>
      </svg>
      <div style="background-image:url(https://secret.example/bg.png);color:red">safe</div>
    `;

    sanitizeCukiiSnapshotClone(root);

    expect(root.querySelector(".cukii-report-overlay")).toBeNull();
    expect(root.querySelector(".cukii-command-menu")).toBeNull();
    expect(
      root.querySelector("iframe,object,embed,svg use,svg image"),
    ).toBeNull();
    expect(root.innerHTML).not.toContain("secret.example");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("[image omitted]");
  });

  it("masks secrets and personal data in text and attributes", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>email=user@example.com Authorization: Bearer abc.def.ghi</p>
      <input value="api_key=plain-secret" placeholder="user@example.com" />
      <button aria-label="token=another-secret">Action</button>
    `;

    sanitizeCukiiSnapshotClone(root);

    expect(root.textContent).not.toContain("user@example.com");
    expect(root.textContent).not.toContain("abc.def.ghi");
    expect(root.querySelector("input")?.getAttribute("value")).not.toContain(
      "plain-secret",
    );
    expect(
      root.querySelector("input")?.getAttribute("placeholder"),
    ).not.toContain("user@example.com");
    expect(
      root.querySelector("button")?.getAttribute("aria-label"),
    ).not.toContain("another-secret");
  });

  it("keeps only the transcript turns painted inside the scrollport", () => {
    const source = document.createElement("div");
    const transcript = document.createElement("div");
    transcript.className = "cukii-transcript";
    source.appendChild(transcript);
    const positions = [
      rect(-900, -700),
      rect(-40, 100),
      rect(100, 300),
      rect(700, 900),
    ];
    for (const [index, position] of positions.entries()) {
      const turn = document.createElement("div");
      turn.textContent = `turn-${index}`;
      turn.getBoundingClientRect = () => position;
      transcript.appendChild(turn);
    }
    transcript.getBoundingClientRect = () => rect(0, 600);
    const clone = source.cloneNode(true) as HTMLElement;

    expect(pruneCukiiSnapshotToViewport(source, clone)).toBe(true);
    expect(clone.textContent).toBe("turn-1turn-2");
    expect(
      clone.querySelector<HTMLElement>(".cukii-transcript > div")?.style
        .transform,
    ).toBe("translateY(-40px)");
  });

  it("caps hidden tool output before serializing the snapshot SVG", () => {
    const root = document.createElement("div");
    root.textContent = `visible ${"x".repeat(CUKII_SNAPSHOT_TEXT_BUDGET * 3)}`;

    sanitizeCukiiSnapshotClone(root);

    expect(root.textContent?.length).toBeLessThanOrEqual(
      CUKII_SNAPSHOT_TEXT_BUDGET,
    );
    expect(root.textContent).toContain("[snapshot truncated]");
  });
});
