import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { runToolHooks } from "./toolHooks.js";

/**
 * Runtime-доказательство паритета memory lifecycle для расширения (DeepSeek).
 *
 * 🔴 Зачем отдельно от toolHooks.vitest.ts. Тот проверяет, что hook-runner работает
 * вообще. Здесь проверяется другое утверждение: расширение исполняет ТОТ ЖЕ канонический
 * `memory-first-guard.ps1`, что Claude Code и Codex, и ПОДЧИНЯЕТСЯ его вердикту. Без этого
 * «одинаковая runtime-проводка» остаётся заявлением: hook-runner может быть безупречным и
 * при этом не звать ни один memory-хук.
 *
 * Профиль изолирован: `overrideSettingsPaths` уводит настройки в temp, а маркеры сессии
 * пишутся в свой `USERPROFILE`, поэтому боевое состояние memory-first не затрагивается.
 */
// 🔴 Литерал, а НЕ path.join("D:", ...). `path.join("D:", "Brain")` на Windows даёт
// диск-относительный `D:Brain`, который разрешается от текущего каталога на этом диске, —
// путь молча уезжает в несуществующий, хук падает без вывода, и проверка «не заблокировано»
// становится ложно зелёной. Поймано на этом самом тесте.
const GUARD =
  "D:/Brain/repo/personal/agent-hub/harness/memory/memory-first-guard.ps1";

const hasPwsh = (() => {
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPwsh || !fs.existsSync(GUARD))(
  "memory-first parity в расширении",
  () => {
    function sandbox() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-parity-"));
      const settings = path.join(dir, "settings.json");
      const ran = path.join(dir, "ran.txt");

      // 🔴 Обёртка, а не прямой вызов guard'а. Она пишет маркер запуска и только потом
      // передаёт stdin канонический скрипт. Без маркера `blocked: false` означает одно и то
      // же в двух разных случаях — «хук разрешил» и «хук не исполнился», — и положительные
      // проверки становятся ложно зелёными. Такое уже случалось на этом файле.
      // Пути — одинарными кавычками и со слэшами вперёд: в PowerShell обратный слэш НЕ
      // escape-символ, поэтому `JSON.stringify` пути ("C:\\a\\b") даёт буквальный двойной
      // слэш и портит путь. stdin не перехватываем — guard читает `[Console]::In` сам,
      // а через конвейер туда ничего не попадёт.
      const wrapper = path.join(dir, "wrap.ps1");
      const ps = (p: string) => `'${p.replace(/\\/g, "/")}'`;
      fs.writeFileSync(
        wrapper,
        [
          `'ran' | Set-Content -LiteralPath ${ps(ran)} -Encoding utf8`,
          `& ${ps(GUARD)} -Harness deepseek`,
          `exit $LASTEXITCODE`,
          "",
        ].join("\n"),
        "utf8",
      );

      fs.writeFileSync(
        settings,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `pwsh -NoProfile -ExecutionPolicy Bypass -File "${wrapper}"`,
                    timeout: 30,
                  },
                ],
              },
            ],
          },
        }),
        "utf8",
      );
      return { dir, settings, ran };
    }

    /** Проваливает тест, если хук не исполнялся: иначе любой `blocked: false` — ложь. */
    function expectHookRan(ran: string) {
      expect(
        fs.existsSync(ran),
        "hook-команда не исполнилась — результат ничего не значит",
      ).toBe(true);
    }

    const sessionId = `parity-${process.pid}`;

    it("без расписки о memory_search содержательный инструмент отвергается", async () => {
      const { dir, settings, ran } = sandbox();
      const prevHome = process.env.USERPROFILE;
      process.env.USERPROFILE = dir;
      try {
        const result = await runToolHooks(
          "PreToolUse",
          "Read",
          { file_path: "D:/v/x.md" },
          "use-1",
          dir,
          {},
          [settings],
          sessionId,
        );
        expectHookRan(ran);
        expect(result.blocked).toBe(true);
        expect(result.reason ?? "").toContain("СНАЧАЛА ПАМЯТЬ");
      } finally {
        process.env.USERPROFILE = prevHome;
      }
    }, 60_000);

    it("с распиской тот же инструмент проходит", async () => {
      const { dir, settings, ran } = sandbox();
      const markers = path.join(dir, ".claude", "state", "memory-first");
      fs.mkdirSync(markers, { recursive: true });
      fs.writeFileSync(
        path.join(markers, `${sessionId}.ok`),
        "test-receipt",
        "utf8",
      );
      const prevHome = process.env.USERPROFILE;
      process.env.USERPROFILE = dir;
      try {
        const result = await runToolHooks(
          "PreToolUse",
          "Read",
          { file_path: "D:/v/x.md" },
          "use-2",
          dir,
          {},
          [settings],
          sessionId,
        );
        expectHookRan(ran);
        expect(result.blocked).toBe(false);
      } finally {
        process.env.USERPROFILE = prevHome;
      }
    }, 60_000);

    it("ToolSearch разрешён всегда — иначе замок нечем снять", async () => {
      const { dir, settings, ran } = sandbox();
      const prevHome = process.env.USERPROFILE;
      process.env.USERPROFILE = dir;
      try {
        const result = await runToolHooks(
          "PreToolUse",
          "ToolSearch",
          {},
          "use-3",
          dir,
          {},
          [settings],
          sessionId,
        );
        expectHookRan(ran);
        expect(result.blocked).toBe(false);
      } finally {
        process.env.USERPROFILE = prevHome;
      }
    }, 60_000);
  },
);
