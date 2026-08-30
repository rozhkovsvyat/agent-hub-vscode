import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

function productionSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(fullPath);
    if (!/\.tsx?$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) {
      return [];
    }
    return [fullPath];
  });
}

describe("legacy full-screen history removal", () => {
  it("keeps legacy user-facing markers out of the production GUI graph", () => {
    const production = productionSources(sourceRoot)
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");

    for (const marker of [
      "Search past sessions",
      "Clear chats",
      "Chat history is saved to",
      "%USERPROFILE%/.continue",
    ]) {
      expect(production).not.toContain(marker);
    }
    expect(production).not.toMatch(/(?:components|pages)\/History/i);
  });

  it("keeps the compatibility route as a one-way chat redirect", () => {
    const app = fs.readFileSync(path.join(sourceRoot, "App.tsx"), "utf8");
    expect(app).toContain('path: "/history"');
    expect(app).toContain("<Navigate replace to={ROUTES.HOME} />");
    expect(app).toContain("<CukiiSessionNavigator />");
  });
});
