import { act } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { renderWithProviders } from "../../../util/test/render";
import { Chat } from "../Chat";

const canonicalCss = () =>
  readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

/**
 * Tailwind is not compiled during unit tests, so a sticky toolbar's layer is
 * only observable through its class tokens. Reading `z-<n>` off the rendered
 * node is therefore the honest measurement here: it is exactly the number the
 * compiled stylesheet emits for that element.
 */
const tailwindZIndex = (element: Element): number => {
  const token = Array.from(element.classList).find((cls) =>
    /^z-\d+$/.test(cls),
  );
  return token ? Number(token.slice(2)) : 0;
};

const declaredZIndex = (css: string, selector: string): number => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1];
  if (!rule) {
    throw new Error(`selector ${selector} is missing from index.css`);
  }
  const value = rule.match(/z-index:\s*(-?\d+)/)?.[1];
  if (!value) {
    throw new Error(`${selector} declares no z-index`);
  }
  return Number(value);
};

const renderTranscriptWithCodeBlock = async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "sticky-layering",
        title: "Sticky layering",
        history: [
          {
            message: { id: "u1", role: "user", content: "Purge the request" },
            contextItems: [],
          },
          {
            message: {
              id: "a1",
              role: "assistant",
              content: "Running it now:\n\n```ts\nconst a = 1;\n```\n",
            },
            contextItems: [],
          },
        ],
      },
    });
  });

  const transcript = container.querySelector(".cukii-transcript");
  if (!transcript) {
    throw new Error("transcript is missing");
  }
  const stickyRow = transcript.querySelector(".cukii-user-row--sticky");
  if (!stickyRow) {
    throw new Error("sticky user row is missing");
  }
  return { transcript, stickyRow };
};

test("keeps every in-transcript sticky toolbar below the sticky user capsule", async () => {
  const { transcript, stickyRow } = await renderTranscriptWithCodeBlock();

  // Only toolbars that scroll underneath the capsule matter. Anything nested
  // inside the capsule shares its stacking context and cannot overlap it.
  const scrollingToolbars = Array.from(
    transcript.querySelectorAll(".sticky"),
  ).filter((node) => !stickyRow.contains(node));

  // Negative control: a vacuous pass here would hide the regression entirely,
  // because the reported defect only exists when a code block is on screen.
  expect(scrollingToolbars.length).toBeGreaterThan(0);

  const css = canonicalCss();
  const capsuleLayer = declaredZIndex(css, ".cukii-user-row--sticky");

  expect(
    scrollingToolbars
      .filter((toolbar) => tailwindZIndex(toolbar) >= capsuleLayer)
      .map((toolbar) => toolbar.className),
  ).toEqual([]);
});

test("leaves no transcript layer at all above the sticky user capsule", async () => {
  const { transcript, stickyRow } = await renderTranscriptWithCodeBlock();

  const css = canonicalCss();
  const capsuleLayer = declaredZIndex(css, ".cukii-user-row--sticky");

  // The reported defect was a sticky toolbar, but any positioned descendant
  // carrying a high enough layer would overlap the capsule the same way. This
  // sweep is what turns the single fix into a standing invariant.
  const overlapping = Array.from(transcript.querySelectorAll("*"))
    .filter((node) => !stickyRow.contains(node))
    .filter((node) => tailwindZIndex(node) >= capsuleLayer)
    .map((node) => node.className);

  expect(overlapping).toEqual([]);
});

test("raises the capsule further while it owns an open popover", async () => {
  const css = canonicalCss();
  const capsuleLayer = declaredZIndex(css, ".cukii-user-row--sticky");
  const openLayer = declaredZIndex(
    css,
    '.cukii-user-row--sticky:has([aria-expanded="true"])',
  );

  expect(openLayer).toBeGreaterThan(capsuleLayer);
});

/**
 * The DOM sweep above only sees what the fixture happens to render. Code block
 * toolbars and tool-call headers share the same `sticky -top-2 z-10` recipe, so
 * a source sweep of the two trees that render inside the transcript is what
 * keeps a new sibling header from reintroducing the overlap unnoticed.
 */
const collectTsx = (dir: string): string[] => {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return collectTsx(full);
    }
    return full.endsWith(".tsx") && !full.includes(".test.") ? [full] : [];
  });
};

test("keeps every sticky header in the transcript trees below the capsule", () => {
  const css = canonicalCss();
  const capsuleLayer = declaredZIndex(css, ".cukii-user-row--sticky");

  const roots = [
    join(process.cwd(), "src", "components", "StyledMarkdownPreview"),
    join(process.cwd(), "src", "pages", "gui", "ToolCallDiv"),
  ];
  const files = roots.flatMap(collectTsx);
  expect(files.length).toBeGreaterThan(0);

  const offenders: string[] = [];
  let stickyHeadersSeen = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [className] of source.matchAll(/className=\{?`?"?([^`"}]*)/g)) {
      if (!/\bsticky\b/.test(className)) {
        continue;
      }
      stickyHeadersSeen += 1;
      const layer = Number(className.match(/\bz-(\d+)\b/)?.[1] ?? 0);
      if (layer >= capsuleLayer) {
        offenders.push(`${file}: z-${layer}`);
      }
    }
  }

  // Negative control: the two known headers must actually be found, otherwise
  // a rename would turn this guard into a silent no-op.
  expect(stickyHeadersSeen).toBeGreaterThanOrEqual(2);
  expect(offenders).toEqual([]);
});

test("confines the raised capsule to the transcript stacking context", async () => {
  const css = canonicalCss();

  // Without `isolation: isolate` the capsule's higher layer would escape the
  // transcript and paint over the composer shell and the message gradient.
  const transcriptRule = css.match(/\.cukii-transcript\s*\{([^}]*)\}/s)?.[1];
  expect(transcriptRule).toContain("isolation: isolate");

  const capsuleLayer = declaredZIndex(css, ".cukii-user-row--sticky");
  const openLayer = declaredZIndex(
    css,
    '.cukii-user-row--sticky:has([aria-expanded="true"])',
  );
  const composerLayer = declaredZIndex(css, ".cukii-main-input-shell");

  // The composer is a sibling of the transcript, so this is a documentation
  // guard rather than a cascade rule: if the capsule ever outgrows the
  // composer's own layer, removing `isolation` would silently invert them.
  expect(Math.max(capsuleLayer, openLayer)).toBeLessThanOrEqual(composerLayer);
});
