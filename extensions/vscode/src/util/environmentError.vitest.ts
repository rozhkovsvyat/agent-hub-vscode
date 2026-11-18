import { describe, expect, it } from "vitest";

import { describeCukiiEnvironmentError } from "./environmentError";

describe("describeCukiiEnvironmentError", () => {
  it("names a denied Windows watcher and its path", () => {
    expect(
      describeCukiiEnvironmentError(
        {
          code: "EPERM",
          syscall: "watch",
          path: "C:\\Users\\owner\\.cukii\\rules",
          message:
            "EPERM: operation not permitted, watch 'C:\\Users\\owner\\.cukii\\rules'",
        },
        "win32",
      ),
    ).toBe(
      "Cukii cannot watch “C:\\Users\\owner\\.cukii\\rules” for changes: the operating system denied permission (EPERM). Allow this path in Windows Controlled Folder Access/antivirus, or grant your Windows account write permission, then reload the window.",
    );
  });

  it("identifies a storage write even when only the Node message has a path", () => {
    const receipt = describeCukiiEnvironmentError(
      {
        message:
          "EACCES: permission denied, open '/Users/owner/.cukii/history.sqlite3'",
      },
      "darwin",
    );
    expect(receipt).toContain("write Cukii storage");
    expect(receipt).toContain("/Users/owner/.cukii/history.sqlite3");
    expect(receipt).toContain("read/write permission");
  });

  it("does not relabel unrelated failures as permission errors", () => {
    expect(
      describeCukiiEnvironmentError({ code: "ENOENT", message: "missing" }),
    ).toBeUndefined();
    expect(
      describeCukiiEnvironmentError(new Error("network failed")),
    ).toBeUndefined();
  });
});
