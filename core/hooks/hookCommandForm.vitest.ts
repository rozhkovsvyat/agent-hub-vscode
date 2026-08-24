import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { runToolHooks } from "./toolHooks";

// Диагностика, а не приёмка: показать, ЧТО именно происходит с hook-командой.
// Нужна потому, что `blocked: false` одинаково выглядит и когда хук разрешил, и когда он
// не запускался, — то есть положительные проверки без этого могут быть ложно зелёными.
describe("форма hook-команды на Windows", () => {
  it('pwsh -File "<путь с кавычками>" реально исполняется, сломанная форма — нет', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-probe-"));
    console.log("tmpdir:", os.tmpdir());
    console.log("песочница:", dir);

    // A. Эталон: ровно та форма, что работает в toolHooks.vitest.ts.
    const nodeMarker = path.join(dir, "node-ran.txt");
    const nodeScript = path.join(dir, "hook.cjs");
    fs.writeFileSync(
      nodeScript,
      `require("node:fs").writeFileSync(${JSON.stringify(nodeMarker)}, "ran"); process.exit(0);`,
    );
    const settingsA = path.join(dir, "a.json");
    fs.writeFileSync(
      settingsA,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: `node ${nodeScript}` }] },
          ],
        },
      }),
    );

    // B. Подозреваемая форма: pwsh -File.
    const pwshMarker = path.join(dir, "pwsh-ran.txt");
    const wrapper = path.join(dir, "wrap.ps1");
    fs.writeFileSync(
      wrapper,
      `'ran' | Set-Content -LiteralPath '${pwshMarker.replace(/\\/g, "/")}'\n`,
      "utf8",
    );
    const settingsB = path.join(dir, "b.json");
    fs.writeFileSync(
      settingsB,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: `pwsh -NoProfile -ExecutionPolicy Bypass -File "${wrapper}"`,
                },
              ],
            },
          ],
        },
      }),
    );

    const ra = await runToolHooks(
      "PreToolUse",
      "Read",
      {},
      "p-a",
      dir,
      {},
      [settingsA],
      "probe",
    );
    const rb = await runToolHooks(
      "PreToolUse",
      "Read",
      {},
      "p-b",
      dir,
      {},
      [settingsB],
      "probe",
    );

    console.log(
      "node-хук запускался:",
      fs.existsSync(nodeMarker),
      JSON.stringify(ra),
    );
    console.log(
      "pwsh-хук запускался:",
      fs.existsSync(pwshMarker),
      JSON.stringify(rb),
    );

    expect(fs.existsSync(nodeMarker), "эталонный node-хук не запустился").toBe(
      true,
    );
    expect(
      fs.existsSync(pwshMarker),
      'pwsh -File "<путь>" не запустился — именно в этой форме записаны все боевые хуки',
    ).toBe(true);

    // C. Свидетель самого дефекта: тот же вызов БЕЗ windowsVerbatimArguments, как было
    // раньше. Отдельный маркер — иначе проверка увидела бы файл, созданный шагом B, и
    // молча позеленела бы на сломанном вызове.
    const witness = path.join(dir, "witness.ps1");
    const witnessMarker = path.join(dir, "witness-ran.txt");
    fs.writeFileSync(
      witness,
      `'ran' | Set-Content -LiteralPath '${witnessMarker.replace(/\\/g, "/")}'\n`,
      "utf8",
    );
    let brokenExit: number | undefined;
    try {
      execFileSync(
        "cmd.exe",
        ["/c", `pwsh -NoProfile -ExecutionPolicy Bypass -File "${witness}"`],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      brokenExit = 0;
    } catch (e) {
      brokenExit = (e as { status?: number }).status;
      console.log(
        "сломанная форма: код",
        brokenExit,
        "stderr:",
        String((e as { stderr?: string }).stderr).slice(0, 200),
      );
    }
    console.log("маркер сломанной формы:", fs.existsSync(witnessMarker));
    expect(
      brokenExit === 0 && fs.existsSync(witnessMarker),
      "неэкранированная форма внезапно заработала — дефект перестал воспроизводиться, " +
        "проверь, нужна ли ещё правка в executeCommand",
    ).toBe(false);
  }, 90_000);
});
