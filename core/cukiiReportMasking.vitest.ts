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
    ).toBe(
      '{"authorFullName":"[NAME]","email":"[EMAIL]"} C:\\Users\\[USER]\\repo',
    );
    expect(maskCukiiReportText("call +7 (999) 123-45-67")).toBe("call [PHONE]");
  });

  it("does not destroy ordinary diagnostic text", () => {
    const text = "POST /tasks returned 502 after 812 ms";
    expect(maskCukiiReportText(text)).toBe(text);
  });
});
