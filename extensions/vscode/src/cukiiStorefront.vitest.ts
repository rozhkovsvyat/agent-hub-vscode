import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// The Marketplace listing is assembled from package.json plus README.md, and
// both were inherited wholesale from Continue. The owner found Continue's
// bugs address, its docs links, its GIFs and finally its competitor tags still
// sitting on our public card. These are the fields a visitor actually reads,
// so they get a test rather than another manual sweep.

const extensionRoot = join(__dirname, "..");

const manifest = JSON.parse(
  readFileSync(join(extensionRoot, "package.json"), "utf8"),
) as {
  name: string;
  displayName: string;
  description: string;
  publisher: string;
  icon: string;
  keywords: string[];
  categories: string[];
  repository?: { url?: string };
  homepage?: string;
  bugs?: { url?: string; email?: string };
  qna?: string | boolean;
};

const OWN_REPOSITORY = "https://github.com/rozhkovsvyat/agent-hub-vscode";

describe("cukii storefront card", () => {
  it("is published as cukii.cukii-vscode with our own name", () => {
    expect(manifest.publisher).toBe("cukii");
    expect(manifest.name).toBe("cukii-vscode");
    expect(manifest.displayName).toBe("Cukii");
    expect(manifest.description).not.toMatch(/continue/i);
  });

  it("points every visitor-facing link at our repository", () => {
    expect(manifest.repository?.url).toBe(OWN_REPOSITORY);
    expect(manifest.homepage).toBe(OWN_REPOSITORY);
    expect(manifest.bugs?.url).toBe(`${OWN_REPOSITORY}/issues`);
    // nate@continue.dev shipped on the card until 2.0.126.
    expect(manifest.bugs?.email).toBeUndefined();
  });

  it("carries no inherited Continue tag or category", () => {
    // Continue's card advertised competitors (chatgpt/copilot/cline/roo) and
    // model vendors we do not route (mistral/codestral); our tags must name
    // the CLIs Cukii actually bridges.
    const inherited = [
      "chatgpt",
      "cline",
      "roo",
      "copilot",
      "github",
      "mistral",
      "codestral",
    ];
    for (const tag of inherited) {
      expect(manifest.keywords).not.toContain(tag);
    }
    for (const vendor of [
      "claude",
      "codex",
      "qwen",
      "grok",
      "cursor",
      "kimi",
    ]) {
      expect(manifest.keywords).toContain(vendor);
    }
    // Education/Machine Learning/Snippets described Continue, not this product.
    expect(manifest.categories).toEqual([
      "AI",
      "Chat",
      "Programming Languages",
    ]);
  });

  it("says nothing about Continue in any card field", () => {
    for (const field of [
      manifest.description,
      manifest.homepage ?? "",
      manifest.repository?.url ?? "",
      manifest.bugs?.url ?? "",
      typeof manifest.qna === "string" ? manifest.qna : "",
      ...manifest.keywords,
      ...manifest.categories,
    ]) {
      expect(field).not.toMatch(/continue(dev)?\.dev|continuedev/i);
    }
  });

  it("ships a README that is ours and an icon that exists", () => {
    const readme = readFileSync(join(extensionRoot, "README.md"), "utf8");
    expect(readme).not.toMatch(/continue/i);
    // The old card embedded four Continue demo GIFs from a docs/ tree that no
    // longer exists, so every image was a broken link.
    for (const image of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      expect(image[1]).toMatch(/^https:\/\//);
    }

    expect(manifest.icon).toBe("media/icon.png");
    expect(existsSync(join(extensionRoot, manifest.icon))).toBe(true);
  });
});
