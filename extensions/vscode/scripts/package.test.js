const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("jszip");

const { runChildOperation } = require("./child-operation");
const { generateConfigYamlSchema } = require("./generate-copy-config");
const { packageAll } = require("./package-all");
const {
  TARGETS,
  collectTargetVsix,
  getVscePublishArgs,
  publishEveryTarget,
  verifyPublishedCarrierHashes,
  waitForValidatedTargets,
} = require("./publish-marketplace");
const {
  getPackageOutputPath,
  packageExtension,
  parsePackageArgs,
} = require("./package");
const {
  assertMissingDependencyCanBeInstalled,
  createPrepackageDependencyTasks,
} = require("./prepackage-dependency-plan");

test("rejects a hostile package target before any command is launched", () => {
  const marker = "__cukii_package_target_injection_marker__";
  let executed = false;

  assert.throws(
    () =>
      packageExtension({
        args: ["--target", `linux-x64; ${marker}`],
        runVsce() {
          executed = true;
        },
      }),
    /Unsupported VS Code package target/,
  );
  assert.equal(executed, false);
  assert.equal(parsePackageArgs(["--target", "linux-x64"]).target, "linux-x64");
});

test("package-all prepares GUI once and routes every target through the hardened driver", () => {
  let stagedAsset = "stale";
  let prepareCount = 0;
  const commands = [];

  packageAll({
    platforms: ["linux-x64", "darwin-arm64"],
    prepareGui() {
      prepareCount += 1;
      stagedAsset = "current";
    },
    runCommand(_command, args, options) {
      assert.equal(stagedAsset, "current");
      assert.equal(options.shell, false);
      commands.push(args);
    },
  });

  assert.equal(prepareCount, 1);
  assert.equal(commands.length, 3);
  assert.equal(path.basename(commands[0][0]), "package-cross-target.js");
  assert.deepEqual(commands[0].slice(-3), [
    "--target",
    "linux-x64",
    "--gui-prepared",
  ]);
  assert.equal(path.basename(commands[1][0]), "package-cross-target.js");
  assert.deepEqual(commands[1].slice(-3), [
    "--target",
    "darwin-arm64",
    "--gui-prepared",
  ]);
  assert.deepEqual(commands[2].slice(-1), ["--restore-host"]);
  assert.equal(path.basename(commands[2][0]), "package-cross-target.js");
  assert.equal(
    commands.some((args) =>
      args.some((arg) => String(arg).includes("prepackage-cross-platform")),
    ),
    false,
  );
});

test("package-all propagates pre-release and restores the host after a target failure", () => {
  const commands = [];
  const targetFailure = new Error("target failed");

  assert.throws(
    () =>
      packageAll({
        args: ["--pre-release"],
        platforms: ["linux-x64", "darwin-arm64"],
        prepareGui() {},
        runCommand(_command, args) {
          commands.push(args);
          if (args.includes("linux-x64")) {
            throw targetFailure;
          }
        },
      }),
    (error) => error === targetFailure,
  );

  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].slice(-4), [
    "--target",
    "linux-x64",
    "--gui-prepared",
    "--pre-release",
  ]);
  assert.deepEqual(commands[1].slice(-1), ["--restore-host"]);
});

test("tag release packages, verifies, and publishes every supported target", () => {
  const workflow = fs.readFileSync(
    path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      ".github",
      "workflows",
      "cukii-release.yml",
    ),
    "utf8",
  );

  assert.match(workflow, /npm run package-all/);
  assert.match(workflow, /assert-cukii-cross-target-vsix\.ps1/);
  assert.match(workflow, /name: all-targets-vsix/);
  assert.match(
    workflow,
    /extensions\/vscode\/build\/cukii-vscode-\$target-\$version\.vsix/,
  );
  assert.match(
    workflow,
    /path: extensions\/vscode\/build\/cukii-vscode-\*-\*\.vsix/,
  );
  assert.doesNotMatch(
    workflow,
    /path: extensions\/vscode\/cukii-vscode-\*-\*\.vsix/,
  );
  assert.match(workflow, /scripts\/publish-marketplace\.js/);
  assert.match(workflow, /Install pinned VS Code for activation smoke/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cukii\/release-smoke\/\*\*/);
  assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/'\)/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /test-cukii-vsix-activation\.ps1/);
  assert.match(workflow, /test-cukii-release-gate\.ps1/);
  assert.match(workflow, /ACTIVATION-SMOKE-PASS|Activate packaged Windows carrier/);
  assert.ok(
    workflow.indexOf("Activate packaged Windows carrier") <
      workflow.indexOf("Upload VSIX"),
    "activation smoke must gate artifact upload",
  );
  assert.ok(
    workflow.indexOf("Reject invalid release candidates") <
      workflow.indexOf("Upload VSIX"),
    "negative release matrix must gate artifact upload",
  );
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /VSCE_PAT/);
  assert.doesNotMatch(
    workflow,
    /uses:\s+[^\s#]+@(v\d+|main|master)(?:\s|$)/,
  );
  for (const target of [
    "win32-x64",
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
  ]) {
    assert.match(workflow, new RegExp(target));
  }
  assert.doesNotMatch(workflow, /name: win32-x64-vsix/);
});

test("marketplace publisher is resumable after a partial failure", async () => {
  const packages = TARGETS.map((target) => ({
    target,
    filePath: `${target}.vsix`,
  }));
  const accepted = new Set();
  const firstRunAttempts = new Map();

  await assert.rejects(
    publishEveryTarget({
      packages,
      maxAttempts: 2,
      wait: async () => {},
      runPublish: async ({ target }) => {
        firstRunAttempts.set(target, (firstRunAttempts.get(target) || 0) + 1);
        if (target === "darwin-x64") {
          return { status: 1, output: "simulated network failure" };
        }
        accepted.add(target);
        return { status: 0, output: "" };
      },
    }),
    /Marketplace publication incomplete.*darwin-x64/s,
  );
  assert.deepEqual(new Set(firstRunAttempts.keys()), new Set(TARGETS));
  assert.equal(firstRunAttempts.get("darwin-x64"), 2);

  await publishEveryTarget({
    packages,
    wait: async () => {},
    runPublish: async ({ target }) => {
      if (accepted.has(target)) {
        return {
          status: 1,
          output: `Target platform ${target} already exists and cannot be modified`,
        };
      }
      accepted.add(target);
      return { status: 0, output: "" };
    },
  });
  assert.deepEqual(accepted, new Set(TARGETS));
});

test("marketplace publisher delegates duplicate handling to vsce", () => {
  assert.deepEqual(
    getVscePublishArgs({ filePath: "linux-x64.vsix", preRelease: false }),
    [
      "--yes",
      "@vscode/vsce@4.0.0",
      "publish",
      "--oidc",
      "--skip-duplicate",
      "--no-dependencies",
      "--packagePath",
      "linux-x64.vsix",
    ],
  );
  assert.deepEqual(
    getVscePublishArgs({ filePath: "darwin-arm64.vsix", preRelease: true }),
    [
      "--yes",
      "@vscode/vsce@4.0.0",
      "publish",
      "--pre-release",
      "--oidc",
      "--skip-duplicate",
      "--no-dependencies",
      "--packagePath",
      "darwin-arm64.vsix",
    ],
  );
});

test("marketplace completion requires two consecutive complete gallery snapshots", async () => {
  const snapshots = [
    TARGETS.slice(0, 4),
    TARGETS,
    TARGETS.slice(0, 4),
    TARGETS,
    TARGETS,
  ];
  let queries = 0;
  await waitForValidatedTargets({
    version: "2.0.129",
    wait: async () => {},
    queryVersions: async () =>
      snapshots[queries++].map((targetPlatform) => ({
        version: "2.0.129",
        targetPlatform,
        flags: "validated",
      })),
  });
  assert.equal(queries, 5);
});

test("marketplace completion rejects five validated carriers from the wrong channel", async () => {
  await assert.rejects(
    waitForValidatedTargets({
      version: "2.0.129",
      preRelease: false,
      timeoutMs: 0,
      wait: async () => {},
      queryVersions: async () =>
        TARGETS.map((targetPlatform) => ({
          version: "2.0.129",
          targetPlatform,
          flags: "validated",
          properties: [
            {
              key: "Microsoft.VisualStudio.Code.PreRelease",
              value: "true",
            },
          ],
        })),
    }),
    /channel=stable validated=0\/5/,
  );
});

test("marketplace completion is bound to the exact local carrier bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-gallery-hash-"));
  try {
    const packages = TARGETS.map((target) => {
      const filePath = path.join(root, `${target}.vsix`);
      fs.writeFileSync(filePath, `carrier:${target}`);
      return { target, filePath };
    });
    const queryVersions = async () =>
      TARGETS.map((targetPlatform) => ({
        version: "2.0.130",
        targetPlatform,
        flags: "validated",
        files: [
          {
            assetType: "Microsoft.VisualStudio.Services.VSIXPackage",
            source: `https://gallery.invalid/${targetPlatform}`,
          },
        ],
      }));
    const fetchImpl = async (source) => ({
      ok: true,
      status: 200,
      async arrayBuffer() {
        return Buffer.from(`carrier:${source.split("/").pop()}`);
      },
    });
    await verifyPublishedCarrierHashes({
      packages,
      version: "2.0.130",
      queryVersions,
      fetchImpl,
    });
    fs.writeFileSync(packages[2].filePath, "mutated carrier");
    await assert.rejects(
      verifyPublishedCarrierHashes({
        packages,
        version: "2.0.130",
        queryVersions,
        fetchImpl,
      }),
      /Marketplace VSIX hash mismatch for darwin-x64/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("marketplace publisher refuses an incomplete local carrier set", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-publish-set-"));
  try {
    for (const target of TARGETS.slice(0, 4)) {
      fs.writeFileSync(
        path.join(tempRoot, `cukii-vscode-${target}-2.0.129.vsix`),
        "fixture",
      );
    }
    assert.throws(
      () => collectTargetVsix(tempRoot, "2.0.129"),
      /Missing target VSIX files: linux-arm64/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("package output path includes the requested target", () => {
  assert.equal(
    getPackageOutputPath("2.0.122", "win32-x64"),
    "extensions/vscode/build/cukii-vscode-win32-x64-2.0.122.vsix",
  );
  assert.equal(
    getPackageOutputPath("2.0.122"),
    "extensions/vscode/build/cukii-vscode-2.0.122.vsix",
  );
});

test("prepackage always generates the config YAML schema", async () => {
  for (const skipInstalls of [false, true]) {
    const calls = [];
    const tasks = createPrepackageDependencyTasks({
      skipInstalls,
      generateConfigYamlSchema(options) {
        calls.push(["schema", options]);
      },
      installDependencies() {
        calls.push(["install"]);
      },
    });

    await Promise.all(tasks.map((task) => task()));

    assert.deepEqual(calls[0], ["schema", { skipInstall: skipInstalls }]);
    assert.equal(
      calls.filter(([name]) => name === "install").length,
      skipInstalls ? 0 : 1,
    );
  }
});

test("skip-install schema generation runs build without installing and copies JSON", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-schema-test-"));
  try {
    const packageDir = path.join(tempDir, "packages", "config-yaml");
    const schemaPath = path.join(
      packageDir,
      "schema",
      "config-yaml-schema.json",
    );
    const extensionDir = path.join(tempDir, "extensions", "vscode");
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    fs.mkdirSync(extensionDir, { recursive: true });
    const commands = [];

    await generateConfigYamlSchema({
      skipInstall: true,
      continueRoot: tempDir,
      changeDirectory(directory) {
        assert.equal(directory, packageDir);
      },
      execCommand(command) {
        commands.push(command);
        if (command === "node dist/scripts/generateJsonSchema.js") {
          fs.writeFileSync(
            schemaPath,
            JSON.stringify({ title: "Cukii schema" }),
          );
        }
      },
    });

    assert.deepEqual(commands, ["node dist/scripts/generateJsonSchema.js"]);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(extensionDir, "config-yaml-schema.json"),
          "utf8",
        ),
      ),
      { title: "Cukii schema" },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("child operation rejects exit without a completion message", async () => {
  const child = new EventEmitter();
  child.send = () => queueMicrotask(() => child.emit("exit", 1, null));
  child.kill = () => {};

  await assert.rejects(
    runChildOperation({
      forkChild: () => child,
      modulePath: "fake-child.js",
      payload: {},
      timeoutMs: 1000,
    }),
    /code=1/,
  );
});

test("child operation rejects a spawn error", async () => {
  const child = new EventEmitter();
  child.send = () =>
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
  child.kill = () => {};

  await assert.rejects(
    runChildOperation({
      forkChild: () => child,
      modulePath: "fake-child.js",
      payload: {},
      timeoutMs: 1000,
    }),
    /spawn failed/,
  );
});

test("child operation waits for clean exit after completion message", async () => {
  const child = new EventEmitter();
  child.send = () => {};
  child.kill = () => {};
  let settled = false;

  const operation = runChildOperation({
    forkChild: () => child,
    modulePath: "fake-child.js",
    payload: {},
    timeoutMs: 1000,
  }).then(() => {
    settled = true;
  });

  child.emit("message", { done: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("exit", 0, null);
  await operation;
  assert.equal(settled, true);
});

test("skip-install mode rejects a hidden native dependency install", () => {
  assert.throws(
    () =>
      assertMissingDependencyCanBeInstalled({
        skipInstalls: true,
        dependencyName: "@lancedb/vectordb-win32-x64-msvc",
        expectedPath: "missing-package",
      }),
    /refusing a hidden dependency install/,
  );
  assert.doesNotThrow(() =>
    assertMissingDependencyCanBeInstalled({
      skipInstalls: false,
      dependencyName: "@lancedb/vectordb-win32-x64-msvc",
      expectedPath: "missing-package",
    }),
  );
});

test("carrier gate rejects empty and unrecognized native files", async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(
      process.platform === "win32" && fs.existsSync("D:\\Scratch")
        ? "D:\\Scratch"
        : os.tmpdir(),
      "cukii-carrier-negative-",
    ),
  );
  try {
    const vsixPath = path.join(tempRoot, "broken-darwin-arm64.vsix");
    const zip = new JSZip();
    zip.file(
      "extension.vsixmanifest",
      '<PackageManifest TargetPlatform="darwin-arm64" />',
    );
    zip.file("extension/package.json", JSON.stringify({ version: "0.0.0" }));
    zip.file("extension/out/build/Release/empty.node", Buffer.alloc(0));
    zip.file("extension/out/build/Release/text.node", "not machine code");
    fs.writeFileSync(vsixPath, await zip.generateAsync({ type: "nodebuffer" }));

    const gatePath = path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "scripts",
      "assert-cukii-cross-target-vsix.ps1",
    );
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        gatePath,
        "-VsixPath",
        vsixPath,
        "-ExpectedTarget",
        "darwin-arm64",
      ],
      { encoding: "utf8" },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /empty native\/runtime executable/);
    assert.match(output, /unrecognized native\/runtime executable format/);
    assert.match(
      output,
      /required file missing: extension\/out\/node_modules\/onnxruntime-node\/bin\/napi-v3\/darwin\/arm64\/onnxruntime_binding\.node/,
    );
    assert.match(
      output,
      /required file missing: extension\/out\/node_modules\/sharp\/vendor\/8\.14\.5\/darwin-arm64v8\/lib\/libvips-cpp\.42\.dylib/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
