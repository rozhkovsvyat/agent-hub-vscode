/**
 * Время реплики в ленте.
 *
 * 🔴 Раньше здесь было голое `HH:MM` без дня. Наблюдение 22.09.2026 в живом окне
 * плагина: сессия, продолженная через два дня, показывала сверху реплики `21:34`
 * (на самом деле 20.09), а под ними сегодняшнюю `20:15` — и лента читалась как
 * будто разговор идёт из будущего в прошлое. Час и минута без дня однозначны
 * ровно один день; на второй они начинают врать, и тем сильнее, чем дольше живёт
 * сессия. Поэтому у чужого дня время печатается вместе с датой.
 *
 * `now` — параметр, а не `Date.now()` внутри: иначе поведение на границе суток
 * нечем проверить, а именно на ней оно и ломается.
 */
export function formatMessageTime(
  ms: number | undefined,
  now: number = Date.now(),
): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const at = new Date(ms!);
  const time = at.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (isSameLocalDay(at, new Date(now))) return time;
  // День недели не годится: через неделю он повторяется и снова становится
  // двусмысленным. Число и месяц — короткие и однозначные в пределах года.
  const day = at.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
  return `${day}, ${time}`;
}

/** Календарный день в ЛОКАЛЬНОЙ зоне: сравнение по UTC сдвинуло бы границу суток. */
function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
