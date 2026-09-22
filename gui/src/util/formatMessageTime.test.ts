import { describe, expect, it } from "vitest";

import { formatMessageTime } from "./formatMessageTime";

/**
 * Наблюдение 22.09.2026 в живом окне плагина: сессия, продолженная через два дня,
 * показывала сверху `21:34` (реплики от 20.09), а ниже сегодняшнюю `20:15` — лента
 * читалась как разговор из будущего в прошлое. Час без дня однозначен ровно сутки.
 */
describe("formatMessageTime", () => {
  const at = (iso: string) => new Date(iso).getTime();

  it("оставляет одно только время для сегодняшней реплики", () => {
    const now = at("2026-09-22T20:15:00");
    expect(formatMessageTime(at("2026-09-22T09:05:00"), now)).toBe("09:05");
    expect(formatMessageTime(at("2026-09-22T20:15:00"), now)).toBe("20:15");
  });

  it("добавляет дату к реплике другого дня", () => {
    const now = at("2026-09-22T20:15:00");
    const shown = formatMessageTime(at("2026-09-20T21:34:00"), now);
    expect(shown).toContain("21:34");
    expect(shown).toContain("20");
    expect(shown).not.toBe("21:34");
  });

  it("считает границей КАЛЕНДАРНЫЙ день, а не 24 часа", () => {
    const now = at("2026-09-22T00:10:00");
    // Двадцать минут назад — но уже вчера: без даты это читалось бы как «сегодня».
    expect(formatMessageTime(at("2026-09-21T23:50:00"), now)).not.toBe("23:50");
    // И наоборот: почти сутки назад, но тот же календарный день — даты не нужно.
    expect(formatMessageTime(at("2026-09-22T00:01:00"), now)).toBe("00:01");
  });

  it("молчит на отсутствующем и нечисловом времени", () => {
    expect(formatMessageTime(undefined)).toBeUndefined();
    expect(formatMessageTime(Number.NaN)).toBeUndefined();
  });
});
