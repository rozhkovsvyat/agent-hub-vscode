/**
 * @file Generate config.yaml file from template. Also intended to run as a child process.
 */

const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");

const { execCmdSync } = require("../../../scripts/util");

const {
  isForkedChildOperation,
  runChildOperation,
  sendChildResult,
} = require("./child-operation");
const { continueDir } = require("./utils");

async function generateConfigYamlSchema({
  skipInstall = false,
  continueRoot = continueDir,
  execCommand = execCmdSync,
  changeDirectory = process.chdir,
  copyFile = fs.copyFileSync,
} = {}) {
  const packageDir = path.join(continueRoot, "packages", "config-yaml");
  changeDirectory(packageDir);
  if (skipInstall) {
    execCommand("node dist/scripts/generateJsonSchema.js");
  } else {
    execCommand("npm install");
    execCommand("npm run build");
    execCommand("npm run generate-schema");
  }
  copyFile(
    path.join(packageDir, "schema", "config-yaml-schema.json"),
    path.join(continueRoot, "extensions", "vscode", "config-yaml-schema.json"),
  );
  console.log("[info] Generated config.yaml schema");
}

async function copyConfigSchema() {
  process.chdir(path.join(continueDir, "extensions", "vscode"));
  // Modify and copy for .continuerc.json
  const schema = JSON.parse(fs.readFileSync("config_schema.json", "utf8"));
  schema.$defs.SerializedContinueConfig.properties.mergeBehavior = {
    type: "string",
    enum: ["merge", "overwrite"],
    default: "merge",
    title: "Merge behavior",
    markdownDescription:
      "If set to 'merge', .continuerc.json will be applied on top of config.json (arrays and objects are merged). If set to 'overwrite', then every top-level property of .continuerc.json will overwrite that property from config.json.",
    "x-intellij-html-description":
      "<p>If set to <code>merge</code>, <code>.continuerc.json</code> will be applied on top of <code>config.json</code> (arrays and objects are merged). If set to <code>overwrite</code>, then every top-level property of <code>.continuerc.json</code> will overwrite that property from <code>config.json</code>.</p>",
  };
  fs.writeFileSync("continue_rc_schema.json", JSON.stringify(schema, null, 2));

  // Copy config schemas to intellij
  fs.copyFileSync(
    "config_schema.json",
    path.join(
      "..",
      "intellij",
      "src",
      "main",
      "resources",
      "config_schema.json",
    ),
  );
  fs.copyFileSync(
    "continue_rc_schema.json",
    path.join(
      "..",
      "intellij",
      "src",
      "main",
      "resources",
      "continue_rc_schema.json",
    ),
  );
}

if (isForkedChildOperation()) {
  process.once("message", async (msg) => {
    const { operation, skipInstall = false } = msg.payload;
    try {
      if (operation === "generate") {
        await generateConfigYamlSchema({ skipInstall });
      } else if (operation === "copy") {
        await copyConfigSchema();
      } else {
        throw new Error(`Unknown config operation: ${String(operation)}`);
      }
      sendChildResult({ done: true }, 0);
    } catch (error) {
      console.error(error);
      sendChildResult({ error: true, message: String(error) }, 1);
    }
  });
}

function runConfigOperation(operation, payload = {}, options = {}) {
  return runChildOperation({
    forkChild: options.forkChild ?? fork,
    modulePath: __filename,
    payload: { operation, ...payload },
    timeoutMs: options.timeoutMs,
  });
}

async function generateAndCopyConfigYamlSchema({ skipInstall = false } = {}) {
  // Generate and copy over config-yaml-schema.json
  await runConfigOperation("generate", { skipInstall });

  // Copy config schemas to intellij
  await runConfigOperation("copy");
}

module.exports = {
  generateConfigYamlSchema,
  generateAndCopyConfigYamlSchema,
  runConfigOperation,
};
