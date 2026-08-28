const fs = require("fs");
const path = require("path");

const { writeBuildTimestamp } = require("./utils");

const esbuild = require("esbuild");

const flags = process.argv.slice(2);

function copyVoiceRuntime() {
  const source = require("ffmpeg-static");
  const runtimeDir = path.join(__dirname, "..", "out", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(source, path.join(runtimeDir, path.basename(source)));

  const outputModules = path.join(__dirname, "..", "out", "node_modules");
  for (const packageName of ["onnxruntime-node", "onnxruntime-common"]) {
    const packageRoot = path.dirname(
      require.resolve(`${packageName}/package.json`),
    );
    fs.cpSync(packageRoot, path.join(outputModules, packageName), {
      recursive: true,
      force: true,
    });
  }

  const copiedPackages = new Set();
  function copyPackageTree(packageName, resolveFrom = __dirname) {
    if (copiedPackages.has(packageName)) return;
    const packageJson = require.resolve(`${packageName}/package.json`, {
      paths: [resolveFrom],
    });
    const packageRoot = path.dirname(packageJson);
    const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    copiedPackages.add(packageName);
    fs.cpSync(
      packageRoot,
      path.join(outputModules, ...packageName.split("/")),
      { recursive: true, force: true },
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      copyPackageTree(dependency, packageRoot);
    }
  }
  copyPackageTree("sharp");

  const nativeRoot = path.join(
    outputModules,
    "onnxruntime-node",
    "bin",
    "napi-v3",
  );
  for (const platform of fs.readdirSync(nativeRoot)) {
    if (platform !== process.platform) {
      fs.rmSync(path.join(nativeRoot, platform), {
        recursive: true,
        force: true,
      });
    }
  }
  const platformRoot = path.join(nativeRoot, process.platform);
  for (const arch of fs.readdirSync(platformRoot)) {
    if (arch !== process.arch) {
      fs.rmSync(path.join(platformRoot, arch), {
        recursive: true,
        force: true,
      });
    }
  }
}

const esbuildConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: [
    "vscode",
    "esbuild",
    "onnxruntime-node",
    "sharp",
    "./xhr-sync-worker.js",
    "./voiceDictation",
  ],
  format: "cjs",
  platform: "node",
  sourcemap: flags.includes("--sourcemap"),
  loader: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    ".node": "file",
  },

  // To allow import.meta.path for transformers.js
  // https://github.com/evanw/esbuild/issues/1492#issuecomment-893144483
  inject: ["./scripts/importMetaUrl.js"],
  define: { "import.meta.url": "importMetaUrl" },
  supported: { "dynamic-import": false },
  metafile: true,
  plugins: [
    {
      name: "on-end-plugin",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) {
            console.error("Build failed with errors:", result.errors);
            throw new Error(result.errors);
          } else {
            try {
              copyVoiceRuntime();
              fs.writeFileSync(
                "./build/meta.json",
                JSON.stringify(result.metafile, null, 2),
              );
            } catch (e) {
              console.error("Failed to write esbuild meta file", e);
            }
            console.log("VS Code Extension esbuild complete"); // used verbatim in vscode tasks to detect completion
          }
        });
      },
    },
  ],
};

const voiceEsbuildConfig = {
  ...esbuildConfig,
  entryPoints: ["src/extension/voiceDictation.ts"],
  outfile: "out/voiceDictation.js",
  external: ["vscode", "onnxruntime-node", "sharp"],
  plugins: [
    {
      name: "voice-runtime-on-end-plugin",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) {
            throw new Error(result.errors);
          }
          copyVoiceRuntime();
        });
      },
    },
  ],
};

// Claude starts this as a standalone stdio MCP child. Keep it separate from
// the extension bundle so `process.execPath <worker>` has no VS Code runtime
// dependency and stdout remains exclusively JSON-RPC.
const claudePermissionMcpWorkerEsbuildConfig = {
  ...esbuildConfig,
  entryPoints: ["src/extension/claudePermissionMcpWorker.ts"],
  outfile: "out/claudePermissionMcpWorker.js",
  external: [],
  plugins: [],
};

void (async () => {
  // Create .buildTimestamp.js before starting the first build
  writeBuildTimestamp();
  // Bundles the extension into one file
  if (flags.includes("--permission-worker-only")) {
    await esbuild.build(claudePermissionMcpWorkerEsbuildConfig);
    console.log("Claude permission MCP worker esbuild complete");
  } else if (flags.includes("--watch")) {
    const [extensionContext, voiceContext, permissionWorkerContext] =
      await Promise.all([
        esbuild.context(esbuildConfig),
        esbuild.context(voiceEsbuildConfig),
        esbuild.context(claudePermissionMcpWorkerEsbuildConfig),
      ]);
    await Promise.all([
      extensionContext.watch(),
      voiceContext.watch(),
      permissionWorkerContext.watch(),
    ]);
  } else if (flags.includes("--notify")) {
    const inFile = esbuildConfig.entryPoints[0];
    const outFile = esbuildConfig.outfile;

    // The watcher automatically notices changes to source files
    // so the only thing it needs to be notified about is if the
    // output file gets removed.
    if (fs.existsSync(outFile)) {
      console.log("VS Code Extension esbuild up to date");
      return;
    }

    fs.watchFile(outFile, (current, previous) => {
      if (current.size > 0) {
        console.log("VS Code Extension esbuild rebuild complete");
        fs.unwatchFile(outFile);
        process.exit(0);
      }
    });

    console.log("Triggering VS Code Extension esbuild rebuild...");
    writeBuildTimestamp();
  } else {
    await esbuild.build(voiceEsbuildConfig);
    await esbuild.build(claudePermissionMcpWorkerEsbuildConfig);
    await esbuild.build(esbuildConfig);
  }
})();
