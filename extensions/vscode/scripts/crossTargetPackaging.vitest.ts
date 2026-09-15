import fs from "fs";
import os from "os";
import path from "path";
import { fork } from "child_process";

import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  CROSS_TARGETS,
  ffmpegBinaryName,
  foreignLancedbDirectories,
  foreignRipgrepBinaries,
  lancedbDirectoryName,
  lancedbPackageName,
  lancedbVersionForTarget,
  pruneForeignNativeModules,
  ripgrepAssetUrl,
  ripgrepBinaryName,
  ripgrepExtractionPlan,
  sharpBindingName,
  sharpPlatformArch,
  stageFfmpegForTarget,
  stageRipgrepForTarget,
  stageSharpForTarget,
  targetPlatformAndArch,
} = require("./cross-target-packaging");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ensureLancedbForTarget, parseArgs } = require("./package-cross-target");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  UNIX_EXECUTABLE_ENTRIES,
  UNIX_EXECUTABLE_MODE,
  patchExecutableModesInBuffer,
} = require("./zip-executable-mode");

interface RecordedInstall {
  script: string;
  cwd: string;
  platform?: string;
  arch?: string;
}

function withTempExtensionDir<T>(run: (extensionDir: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-cross-target-"));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const VECTORDB_MANIFEST = {
  version: "0.4.20",
  optionalDependencies: {
    "@lancedb/vectordb-darwin-arm64": "0.4.20",
    "@lancedb/vectordb-darwin-x64": "0.4.20",
    "@lancedb/vectordb-linux-arm64-gnu": "0.4.20",
    "@lancedb/vectordb-linux-x64-gnu": "0.4.20",
    "@lancedb/vectordb-win32-x64-msvc": "0.4.20",
  },
};

function centralDirectoryOnlyZip(entries: string[]): Buffer {
  const centralEntries = entries.map((name) => {
    const encodedName = Buffer.from(name, "utf8");
    const header = Buffer.alloc(46 + encodedName.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(encodedName.length, 28);
    header.writeUInt32LE((0o100666 << 16) >>> 0, 38);
    encodedName.copy(header, 46);
    return header;
  });
  const directory = Buffer.concat(centralEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([directory, eocd]);
}

async function withTempExtensionDirAsync<T>(
  run: (extensionDir: string) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-cross-target-"));
  try {
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("ripgrep prebuilt selection", () => {
  it("extracts from a basename in cwd so Windows tar cannot parse drive:path", () => {
    const plan = ripgrepExtractionPlan(
      "D:\\a\\repo\\node_modules\\@vscode\\ripgrep\\bin",
      "D:\\a\\repo\\node_modules\\@vscode\\ripgrep\\bin\\rg.zip",
    );

    expect(plan).toEqual({
      command: "tar",
      args: ["-xf", "rg.zip", "-C", "."],
      cwd: "D:\\a\\repo\\node_modules\\@vscode\\ripgrep\\bin",
    });
    expect(plan.args.join(" ")).not.toContain(":");
  });

  it("rejects an archive outside the extraction directory", () => {
    expect(() =>
      ripgrepExtractionPlan(
        "D:\\a\\repo\\bin",
        "D:\\a\\repo\\other\\rg.zip",
      ),
    ).toThrow(/must be inside its extraction directory/);
  });

  it("passes only the archive basename to the tar invocation used by staging", async () => {
    const extensionDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cukii-cross-target-ripgrep-"),
    );
    try {
      const calls: Array<{
        command: string;
        args: string[];
        cwd?: string;
      }> = [];

      await stageRipgrepForTarget("win32-x64", {
        extensionDir,
        download: async (_url: string, archivePath: string) => {
          fs.writeFileSync(archivePath, "fixture");
          fs.writeFileSync(
            path.join(path.dirname(archivePath), "rg.exe"),
            "fixture",
          );
        },
        execute: (
          command: string,
          args: string[],
          options: { cwd?: string },
        ) => calls.push({ command, args, cwd: options.cwd }),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: "tar",
        args: ["-xf", "rg.zip", "-C", "."],
      });
      expect(calls[0].args.join(" ")).not.toContain(":");
      expect(calls[0].cwd).toBe(
        path.join(
          extensionDir,
          "node_modules",
          "@vscode",
          "ripgrep",
          "bin",
        ),
      );
    } finally {
      fs.rmSync(extensionDir, { recursive: true, force: true });
    }
  });

  it("names the asset @vscode/ripgrep would download natively on each target", () => {
    const base =
      "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v13.0.0-10/ripgrep-v13.0.0-10";
    expect(ripgrepAssetUrl("darwin-arm64")).toBe(
      `${base}-aarch64-apple-darwin.tar.gz`,
    );
    expect(ripgrepAssetUrl("darwin-x64")).toBe(
      `${base}-x86_64-apple-darwin.tar.gz`,
    );
    expect(ripgrepAssetUrl("linux-x64")).toBe(
      `${base}-x86_64-unknown-linux-musl.tar.gz`,
    );
    expect(ripgrepAssetUrl("linux-arm64")).toBe(
      `${base}-aarch64-unknown-linux-musl.tar.gz`,
    );
    expect(ripgrepAssetUrl("win32-x64")).toBe(
      `${base}-x86_64-pc-windows-msvc.zip`,
    );
  });

  it("only appends .exe for Windows targets", () => {
    expect(ripgrepBinaryName("darwin-arm64")).toBe("rg");
    expect(ripgrepBinaryName("linux-x64")).toBe("rg");
    expect(ripgrepBinaryName("win32-x64")).toBe("rg.exe");
  });

  it("refuses a target it has no mapping for instead of guessing", () => {
    expect(() => ripgrepAssetUrl("solaris-sparc")).toThrow(
      /No ripgrep prebuilt mapping/,
    );
    expect(() => ripgrepBinaryName("solaris-sparc")).toThrow(
      /No ripgrep prebuilt mapping/,
    );
  });
});

describe("LanceDB native package selection", () => {
  it("maps every supported target to its native package", () => {
    expect(lancedbPackageName("darwin-arm64")).toBe(
      "@lancedb/vectordb-darwin-arm64",
    );
    expect(lancedbPackageName("linux-x64")).toBe(
      "@lancedb/vectordb-linux-x64-gnu",
    );
    expect(lancedbDirectoryName("linux-arm64")).toBe(
      "vectordb-linux-arm64-gnu",
    );
    expect(CROSS_TARGETS).toContain("darwin-x64");
  });

  it("pins the version the installed wrapper declares", () => {
    expect(lancedbVersionForTarget("darwin-arm64", VECTORDB_MANIFEST)).toBe(
      "0.4.20",
    );
  });

  it("NEGATIVE CONTROL: an unpinned wrapper is refused rather than resolved to latest", () => {
    expect(() =>
      lancedbVersionForTarget("darwin-arm64", {
        version: "0.4.20",
        optionalDependencies: {},
      }),
    ).toThrow(/refusing to install an unversioned native module/);
    expect(() => lancedbVersionForTarget("darwin-arm64", undefined)).toThrow(
      /refusing to install an unversioned native module/,
    );
  });

  it("replaces a target package whose directory exists at the wrong ABI version", async () => {
    await withTempExtensionDirAsync(async (extensionDir) => {
      const wrapperDir = path.join(extensionDir, "node_modules", "vectordb");
      const nativeDir = path.join(
        extensionDir,
        "node_modules",
        "@lancedb",
        "vectordb-darwin-arm64",
      );
      fs.mkdirSync(wrapperDir, { recursive: true });
      fs.mkdirSync(nativeDir, { recursive: true });
      fs.writeFileSync(
        path.join(wrapperDir, "package.json"),
        JSON.stringify(VECTORDB_MANIFEST),
      );
      fs.writeFileSync(
        path.join(nativeDir, "package.json"),
        JSON.stringify({ version: "0.21.2" }),
      );

      const installs: string[][] = [];
      const removed: string[] = [];
      await ensureLancedbForTarget("darwin-arm64", {
        extensionRoot: extensionDir,
        remove: (target: string) => {
          removed.push(target);
          fs.rmSync(target, { recursive: true, force: true });
        },
        install: async (...args: string[]) => {
          installs.push(args);
          fs.mkdirSync(nativeDir, { recursive: true });
          fs.writeFileSync(
            path.join(nativeDir, "package.json"),
            JSON.stringify({ version: "0.4.20" }),
          );
        },
      });

      expect(removed).toEqual([nativeDir]);
      expect(installs).toEqual([
        ["@lancedb/vectordb-darwin-arm64", "@lancedb", "0.4.20"],
      ]);
    });
  });
});

describe("VSIX Unix executable metadata", () => {
  it("marks only the shipped Unix executables as 0100755", () => {
    const unrelated = "extension/out/extension.js";
    const buffer = centralDirectoryOnlyZip([
      ...UNIX_EXECUTABLE_ENTRIES,
      unrelated,
    ]);

    expect(patchExecutableModesInBuffer(buffer)).toEqual(
      [...UNIX_EXECUTABLE_ENTRIES].sort(),
    );

    let offset = 0;
    const modes = new Map<string, number>();
    const hosts = new Map<string, number>();
    for (let index = 0; index < 3; index += 1) {
      const nameLength = buffer.readUInt16LE(offset + 28);
      const name = buffer.toString(
        "utf8",
        offset + 46,
        offset + 46 + nameLength,
      );
      modes.set(name, buffer.readUInt32LE(offset + 38) >>> 16);
      hosts.set(name, buffer.readUInt16LE(offset + 4) >>> 8);
      offset += 46 + nameLength;
    }

    for (const executable of UNIX_EXECUTABLE_ENTRIES) {
      expect(modes.get(executable)).toBe(UNIX_EXECUTABLE_MODE);
      expect(hosts.get(executable)).toBe(3);
    }
    expect(modes.get(unrelated)).toBe(0o100666);
  });

  it("NEGATIVE CONTROL: refuses a VSIX missing either required executable", () => {
    expect(() =>
      patchExecutableModesInBuffer(
        centralDirectoryOnlyZip([UNIX_EXECUTABLE_ENTRIES[0]]),
      ),
    ).toThrow(/Executable entries missing/);
  });
});

describe("voice runtime binary naming", () => {
  it("uses sharp's own platform spelling, where arm64 is arm64v8", () => {
    expect(sharpPlatformArch("darwin-arm64")).toBe("darwin-arm64v8");
    expect(sharpPlatformArch("linux-arm64")).toBe("linux-arm64v8");
    expect(sharpPlatformArch("darwin-x64")).toBe("darwin-x64");
    expect(sharpBindingName("darwin-arm64")).toBe("sharp-darwin-arm64v8.node");
  });

  it("NEGATIVE CONTROL: the naive `sharp-<platform>-<arch>.node` name misses on ARM", () => {
    // This is the defect the mapping exists for: `sharp-${process.arch}.node`
    // builds `sharp-darwin-arm64.node`, which no sharp release ever ships.
    const naive = "sharp-darwin-arm64.node";
    expect(sharpBindingName("darwin-arm64")).not.toBe(naive);
    // ...while it happens to agree on x64, which is why a Windows-only build
    // never noticed.
    expect(sharpBindingName("darwin-x64")).toBe("sharp-darwin-x64.node");
  });

  it("only appends .exe to ffmpeg for Windows targets", () => {
    expect(ffmpegBinaryName("darwin-arm64")).toBe("ffmpeg");
    expect(ffmpegBinaryName("linux-x64")).toBe("ffmpeg");
    expect(ffmpegBinaryName("win32-x64")).toBe("ffmpeg.exe");
  });

  it("refuses a target it has no sharp mapping for", () => {
    expect(() => sharpPlatformArch("solaris-sparc")).toThrow(
      /No sharp platform mapping/,
    );
  });

  it("splits a target into the platform and arch npm expects", () => {
    expect(targetPlatformAndArch("darwin-arm64")).toEqual({
      platform: "darwin",
      arch: "arm64",
    });
    expect(() => targetPlatformAndArch("darwin")).toThrow(/Malformed target/);
  });
});

describe("voice runtime staging", () => {
  it("installs ffmpeg with npm's cross-install environment", () => {
    withTempExtensionDir((extensionDir) => {
      const packageDir = path.join(
        extensionDir,
        "node_modules",
        "ffmpeg-static",
      );
      fs.mkdirSync(packageDir, { recursive: true });
      const installs: RecordedInstall[] = [];

      const binaryPath = stageFfmpegForTarget("darwin-arm64", {
        extensionDir,
        execute: (_bin: string, args: string[], options: any) => {
          installs.push({
            script: args[0],
            cwd: options.cwd,
            platform: options.env.npm_config_platform,
            arch: options.env.npm_config_arch,
          });
          fs.writeFileSync(path.join(packageDir, "ffmpeg"), "mach-o");
        },
      });

      expect(installs).toHaveLength(1);
      expect(installs[0].script).toBe(path.join(packageDir, "install.js"));
      expect(installs[0].platform).toBe("darwin");
      expect(installs[0].arch).toBe("arm64");
      expect(binaryPath).toBe(path.join(packageDir, "ffmpeg"));
    });
  });

  it("clears the previous target's binary, which install.js would otherwise keep", () => {
    withTempExtensionDir((extensionDir) => {
      const packageDir = path.join(
        extensionDir,
        "node_modules",
        "ffmpeg-static",
      );
      fs.mkdirSync(packageDir, { recursive: true });
      // A Windows build ran before; ffmpeg-static exits early on an existing
      // binary, and darwin-arm64/darwin-x64 even share the name `ffmpeg`.
      fs.writeFileSync(path.join(packageDir, "ffmpeg.exe"), "pe");
      fs.writeFileSync(path.join(packageDir, "ffmpeg"), "stale-mach-o");

      stageFfmpegForTarget("darwin-arm64", {
        extensionDir,
        execute: () => {
          expect(fs.existsSync(path.join(packageDir, "ffmpeg.exe"))).toBe(
            false,
          );
          expect(fs.existsSync(path.join(packageDir, "ffmpeg"))).toBe(false);
          fs.writeFileSync(path.join(packageDir, "ffmpeg"), "fresh-mach-o");
        },
      });

      expect(fs.readFileSync(path.join(packageDir, "ffmpeg"), "utf8")).toBe(
        "fresh-mach-o",
      );
    });
  });

  it("NEGATIVE CONTROL: a silent installer fails the build instead of shipping no ffmpeg", () => {
    withTempExtensionDir((extensionDir) => {
      fs.mkdirSync(path.join(extensionDir, "node_modules", "ffmpeg-static"), {
        recursive: true,
      });
      expect(() =>
        stageFfmpegForTarget("darwin-arm64", {
          extensionDir,
          execute: () => {
            /* installer "succeeds" without downloading anything */
          },
        }),
      ).toThrow(/ffmpeg binary missing after install/);
    });
  });

  it("stages sharp through libvips + prebuild-install and skips dll-copy off Windows", () => {
    withTempExtensionDir((extensionDir) => {
      const packageDir = path.join(extensionDir, "node_modules", "sharp");
      const releaseDir = path.join(packageDir, "build", "Release");
      fs.mkdirSync(releaseDir, { recursive: true });
      fs.mkdirSync(path.join(packageDir, "vendor", "8.14.5", "win32-x64"), {
        recursive: true,
      });
      // Leftovers from a Windows build that must not reach a darwin VSIX.
      fs.writeFileSync(path.join(releaseDir, "sharp-win32-x64.node"), "pe");

      const installs: RecordedInstall[] = [];
      stageSharpForTarget("darwin-arm64", {
        extensionDir,
        execute: (_bin: string, args: string[], options: any) => {
          installs.push({
            script: args[0],
            cwd: options.cwd,
            platform: options.env.npm_config_platform,
            arch: options.env.npm_config_arch,
          });
          fs.mkdirSync(releaseDir, { recursive: true });
          fs.writeFileSync(
            path.join(releaseDir, "sharp-darwin-arm64v8.node"),
            "mach-o",
          );
        },
      });

      expect(installs.map((entry) => path.basename(entry.script))).toEqual([
        "libvips.js",
        "bin.js",
      ]);
      expect(installs.every((entry) => entry.platform === "darwin")).toBe(true);
      expect(fs.existsSync(path.join(releaseDir, "sharp-win32-x64.node"))).toBe(
        false,
      );
      expect(
        fs.existsSync(path.join(packageDir, "vendor", "8.14.5", "win32-x64")),
      ).toBe(false);
    });
  });

  it("runs dll-copy only for Windows targets", () => {
    withTempExtensionDir((extensionDir) => {
      const packageDir = path.join(extensionDir, "node_modules", "sharp");
      const releaseDir = path.join(packageDir, "build", "Release");
      fs.mkdirSync(releaseDir, { recursive: true });

      const scripts: string[] = [];
      stageSharpForTarget("win32-x64", {
        extensionDir,
        execute: (_bin: string, args: string[]) => {
          scripts.push(path.basename(args[0]));
          fs.mkdirSync(releaseDir, { recursive: true });
          fs.writeFileSync(path.join(releaseDir, "sharp-win32-x64.node"), "pe");
        },
      });

      expect(scripts).toEqual(["libvips.js", "bin.js", "dll-copy.js"]);
    });
  });

  it("NEGATIVE CONTROL: a missing binding fails rather than packaging sharp without one", () => {
    withTempExtensionDir((extensionDir) => {
      fs.mkdirSync(path.join(extensionDir, "node_modules", "sharp"), {
        recursive: true,
      });
      expect(() =>
        stageSharpForTarget("darwin-arm64", {
          extensionDir,
          execute: () => {
            /* no prebuilt produced */
          },
        }),
      ).toThrow(/sharp binding missing after install/);
    });
  });
});

describe("cross-packaging driver arguments", () => {
  it("requires a target it actually supports", () => {
    expect(parseArgs(["--target", "darwin-arm64"])).toEqual({
      target: "darwin-arm64",
      restoreHost: false,
      preRelease: false,
      guiPrepared: false,
    });
    expect(
      parseArgs([
        "--target",
        "darwin-arm64",
        "--pre-release",
        "--gui-prepared",
      ]),
    ).toEqual({
      target: "darwin-arm64",
      restoreHost: false,
      preRelease: true,
      guiPrepared: true,
    });
    expect(() => parseArgs([])).toThrow(/--target is required/);
    expect(() => parseArgs(["--target", "solaris-sparc"])).toThrow(
      /Unsupported target/,
    );
    expect(() => parseArgs(["--oops"])).toThrow(/Unsupported argument/);
  });

  it("offers an explicit way back to the host, because packaging mutates shared trees", () => {
    // A cross build overwrites core/node_modules/sqlite3 and ffmpeg-static in
    // place, so after one the host's own tests cannot load them at all. The way
    // back has to be a command, not a thing to remember.
    const parsed = parseArgs(["--restore-host"]);
    expect(parsed.restoreHost).toBe(true);
    expect(parsed.target).toBe(`${process.platform}-${process.arch}`);
    expect(parsed.preRelease).toBe(false);
    expect(parsed.guiPrepared).toBe(false);
    expect(() =>
      parseArgs(["--restore-host", "--target", "linux-x64"]),
    ).toThrow(/cannot be combined/);
  });
});

describe("foreign native module pruning", () => {
  it("keeps the target's modules and reports the rest", () => {
    expect(
      foreignLancedbDirectories(
        ["vectordb-win32-x64-msvc", "vectordb-darwin-arm64"],
        "darwin-arm64",
      ),
    ).toEqual(["vectordb-win32-x64-msvc"]);
    expect(foreignRipgrepBinaries(["rg.exe", "rg"], "darwin-arm64")).toEqual([
      "rg.exe",
    ]);
  });

  it("NEGATIVE CONTROL: a tree that already holds only the target is left alone", () => {
    expect(
      foreignLancedbDirectories(["vectordb-darwin-arm64"], "darwin-arm64"),
    ).toEqual([]);
    expect(foreignRipgrepBinaries(["rg"], "darwin-arm64")).toEqual([]);

    const removed: string[] = [];
    const untouched = pruneForeignNativeModules(
      "/out/node_modules",
      "darwin-arm64",
      {
        fileSystem: {
          existsSync: () => true,
          readdirSync: (dir: string) =>
            dir.includes("@lancedb") ? ["vectordb-darwin-arm64"] : ["rg"],
        },
        remove: (target: string) => removed.push(target),
      },
    );
    expect(untouched).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("removes a host binary that would otherwise ship inside a foreign VSIX", () => {
    const removed: string[] = [];
    const pruned = pruneForeignNativeModules(
      "/out/node_modules",
      "darwin-arm64",
      {
        fileSystem: {
          existsSync: () => true,
          readdirSync: (dir: string) =>
            dir.includes("@lancedb")
              ? ["vectordb-darwin-arm64", "vectordb-win32-x64-msvc"]
              : ["rg", "rg.exe"],
        },
        remove: (target: string) => removed.push(target),
      },
    );
    expect(pruned).toHaveLength(2);
    expect(
      removed.some((entry) => entry.includes("vectordb-win32-x64-msvc")),
    ).toBe(true);
    expect(removed.some((entry) => entry.endsWith("rg.exe"))).toBe(true);
  });

  it("does nothing when the directories are absent", () => {
    const removed: string[] = [];
    const pruned = pruneForeignNativeModules("/missing", "linux-x64", {
      fileSystem: {
        existsSync: () => false,
        readdirSync: () => {
          throw new Error("must not read a directory it did not check");
        },
      },
      remove: (target: string) => removed.push(target),
    });
    expect(pruned).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe("build modules required as libraries", () => {
  // The module runs its own work in `fork(__filename)` and used to register the
  // worker's `process.on("message")` handler at import time. Any process that
  // merely required it for `copySqlite` - prepackage, the cross-target driver, a
  // vitest worker - then crashed on the first unrelated IPC message, because the
  // handler destructured `msg.payload` unconditionally.
  // Every one of these is both a library (prepackage imports its exports) and its
  // own forked worker. Deciding the role by `typeof process.send === "function"`
  // installed the worker handler inside any IPC-connected process - a vitest worker
  // included - which then answered vitest's own traffic and aborted the run.
  it.each([
    "./child-operation",
    "./download-copy-sqlite",
    "./npm-install",
    "./install-copy-nodemodule",
    "./generate-copy-config",
  ])(
    "registers no IPC handler when %s is required as a library",
    async (modulePath) => {
      const absoluteModulePath = require.resolve(modulePath);
      const probePath = path.join(__dirname, "ipc-import-probe.js");
      const result = await new Promise<{
        before?: number;
        after?: number;
        error?: string;
      }>((resolve, reject) => {
        const child = fork(probePath, [absoluteModulePath], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { ...process.env, CUKII_FORKED_BUILD_WORKER: "inherited-noise" },
        });
        child.once("message", (message) => resolve(message as any));
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`IPC import probe exited with ${code}`));
          }
        });
      });
      expect(result.error).toBeUndefined();
      expect(result.after).toBe(result.before);
    },
  );

  it("treats the fork marker as the only signal of worker role", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      isForkedChildOperation,
      CHILD_OPERATION_ENV_MARKER,
    } = require("./child-operation");
    // An IPC channel alone must not qualify: that is exactly the vitest case.
    const modulePath = path.join(__dirname, "fake-worker.js");
    expect(isForkedChildOperation(modulePath, {}, ["node", modulePath])).toBe(
      false,
    );
    expect(
      isForkedChildOperation(
        modulePath,
        { [CHILD_OPERATION_ENV_MARKER]: modulePath },
        ["node", modulePath],
      ),
    ).toBe(true);
    expect(
      isForkedChildOperation(
        modulePath,
        { [CHILD_OPERATION_ENV_MARKER]: modulePath },
        ["node", path.join(__dirname, "descendant.js")],
      ),
    ).toBe(false);
  });

  it("still exports the functions the build calls", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqliteModule = require("./download-copy-sqlite");
    expect(typeof sqliteModule.copySqlite).toBe("function");
    expect(typeof sqliteModule.copyEsbuild).toBe("function");
  });
});
