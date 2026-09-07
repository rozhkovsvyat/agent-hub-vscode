import { describe, expect, it } from "vitest";
import { maskCukiiReportText } from "./cukiiReportMasking";

describe("maskCukiiReportText", () => {
  it("ports the Portal 5 secret boundary", () => {
    expect(maskCukiiReportText("Authorization: Bearer abc.def_123")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(maskCukiiReportText("token=super-secret")).toBe("token=[REDACTED]");
    expect(maskCukiiReportText('{"token":"super-secret","ok":true}')).toBe(
      '{"token":"[REDACTED]","ok":true}',
    );
    expect(maskCukiiReportText("postgres://svc:secret@db/app")).toBe(
      "postgres://svc:[REDACTED]@db/app",
    );
  });

  it("masks structured identity, contact data and OS user paths", () => {
    expect(
      maskCukiiReportText(
        '{"authorFullName":"Иванов Иван","email":"owner@example.com"} C:\\Users\\svyat\\repo',
      ),
    ).toBe('{"authorFullName":"[NAME]","email":"[EMAIL]"} [PATH]');
    expect(maskCukiiReportText("call +7 (999) 123-45-67")).toBe("call [PHONE]");
  });

  it("removes absolute Windows, UNC and POSIX paths", () => {
    const text = [
      "at D:\\Brain\\clients\\secret\\a.ts:12",
      "copy \\\\fileserver\\customer-share\\private.log",
      "open /srv/customer/acme/private.log",
      'file="C:\\Program Files\\Cukii\\runtime.log"',
      "at D:\\Client Alpha\\SecretProject\\src\\a.ts:12",
      "copy \\\\fileserver\\Customer Share\\Private Folder\\dump.log",
      "open /srv/Client Alpha/private.log",
    ].join("\n");
    const masked = maskCukiiReportText(text);
    expect(masked).not.toContain("D:\\Brain");
    expect(masked).not.toContain("\\\\fileserver");
    expect(masked).not.toContain("/srv/customer");
    expect(masked).not.toContain("C:\\Program Files");
    expect(masked).not.toContain("Client Alpha");
    expect(masked).not.toContain("Customer Share");
    expect(masked.match(/\[PATH\]/g)).toHaveLength(7);
  });

  it("does not destroy ordinary diagnostic text", () => {
    const text = "POST /tasks returned 502 after 812 ms";
    expect(maskCukiiReportText(text)).toBe(text);
  });
});
