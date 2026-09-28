const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGETS = [
  "win32-x64",
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
];
const EXTENSION_ID = "cukii.cukii-vscode";
const VSCE_PACKAGE = "@vscode/vsce@4.0.0";
const MARKETPLACE_URL = "https://marketplace.visualstudio.com";
const MARKETPLACE_TOKEN_API_VERSION = "7.2-preview.1";
const OIDC_AUDIENCE = "marketplace.visualstudio.com";
const PUBLISHER_NAME = "cukii";
const DUPLICATE_PATTERN = /already exists(?: and cannot be modified)?\.?/i;

function parseArgs(args) {
  const parsed = { preRelease: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pre-release") {
      parsed.preRelease = true;
    } else if (arg === "--vsix-dir" || arg === "--version") {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      parsed[arg === "--vsix-dir" ? "vsixDir" : "version"] = value;
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (!parsed.vsixDir || !parsed.version) {
    throw new Error("--vsix-dir and --version are required");
  }
  return parsed;
}

function collectTargetVsix(vsixDir, version) {
  const expected = TARGETS.map((target) => ({
    target,
    filePath: path.resolve(vsixDir, `cukii-vscode-${target}-${version}.vsix`),
  }));
  const missing = expected.filter(({ filePath }) => !fs.existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(
      `Missing target VSIX files: ${missing
        .map(({ target }) => target)
        .join(", ")}`,
    );
  }
  return expected;
}

function getVscePublishArgs({ filePath, preRelease }) {
  const args = [
    "--yes",
    VSCE_PACKAGE,
    "publish",
    "--skip-duplicate",
    "--no-dependencies",
    "--packagePath",
    filePath,
  ];
  if (preRelease) args.splice(3, 0, "--pre-release");
  return args;
}

function getVscePublishEnv(credential, environment = process.env) {
  if (typeof credential !== "string" || credential.length === 0) {
    throw new Error("Marketplace credential is required");
  }
  const childEnvironment = { ...environment, VSCE_PAT: credential };
  delete childEnvironment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete childEnvironment.ACTIONS_ID_TOKEN_REQUEST_URL;
  return childEnvironment;
}

function runVscePublish({
  filePath,
  preRelease,
  credential,
  environment = process.env,
  runCommand = spawnSync,
}) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = getVscePublishArgs({ filePath, preRelease });
  const result = runCommand(npx, args, {
    encoding: "utf8",
    env: getVscePublishEnv(credential, environment),
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout || ""}\n${result.stderr || ""}`,
  };
}

function redactSensitiveText(value, secrets = []) {
  let redacted = String(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED]",
    )
    .slice(0, 500);
}

async function readJsonResponse(operation, response, secrets = []) {
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      const typeKey =
        typeof body?.typeKey === "string" ? body.typeKey.trim() : "";
      const message = [
        body?.message,
        body?.error_description,
        body?.error,
      ].find((value) => typeof value === "string" && value.trim().length > 0);
      detail = [typeKey, message].filter(Boolean).join(": ");
    } catch {
      // Authentication errors can contain attacker-controlled text. Do not echo
      // unstructured response bodies into the Actions log.
    }
    const safeDetail = redactSensitiveText(detail, secrets);
    throw new Error(
      `${operation} failed with HTTP ${response.status}${
        safeDetail ? `: ${safeDetail}` : ""
      }`,
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error(`${operation} returned an invalid response`);
  }
  return payload;
}

async function getMarketplaceCredential({
  environment = process.env,
  fetchImpl = fetch,
} = {}) {
  if (String(environment.GITHUB_ACTIONS).toLowerCase() !== "true") {
    throw new Error("Marketplace OIDC publishing requires GitHub Actions");
  }
  const requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "GitHub Actions OIDC variables are missing; grant id-token: write",
    );
  }

  let oidcUrl;
  try {
    oidcUrl = new URL(requestUrl);
  } catch {
    throw new Error("GitHub Actions provided an invalid OIDC request URL");
  }
  oidcUrl.searchParams.set("audience", OIDC_AUDIENCE);
  const oidcPayload = await readJsonResponse(
    "GitHub Actions OIDC token request",
    await fetchImpl(oidcUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${requestToken}`,
      },
    }),
    [requestToken],
  );
  if (typeof oidcPayload.value !== "string" || oidcPayload.value.length === 0) {
    throw new Error("GitHub Actions OIDC token request returned no token");
  }

  const exchangeUrl = new URL("/_apis/gallery/token", MARKETPLACE_URL);
  exchangeUrl.searchParams.set("api-version", MARKETPLACE_TOKEN_API_VERSION);
  const marketplacePayload = await readJsonResponse(
    "Marketplace OIDC token exchange",
    await fetchImpl(exchangeUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oidcPayload.value}`,
        "Content-Type": "application/json",
        "User-Agent": "cukii-marketplace-publisher",
      },
      body: JSON.stringify({ publisherName: PUBLISHER_NAME }),
    }),
    [requestToken, oidcPayload.value],
  );
  if (
    typeof marketplacePayload.credential !== "string" ||
    marketplacePayload.credential.length === 0
  ) {
    throw new Error("Marketplace OIDC token exchange returned no credential");
  }
  return marketplacePayload.credential;
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function publishEveryTarget({
  packages,
  preRelease = false,
  credential,
  maxAttempts = 3,
  runPublish = runVscePublish,
  wait = delay,
}) {
  const failures = [];
  for (const pkg of packages) {
    let accepted = false;
    let lastOutput = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runPublish({
        filePath: pkg.filePath,
        target: pkg.target,
        preRelease,
        credential,
        attempt,
      });
      lastOutput = result.output || "";
      process.stdout.write(lastOutput);
      if (result.status === 0 || DUPLICATE_PATTERN.test(lastOutput)) {
        accepted = true;
        break;
      }
      if (attempt < maxAttempts) await wait(attempt * 10_000);
    }
    if (!accepted) failures.push(`${pkg.target}: ${lastOutput.trim()}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Marketplace publication incomplete:\n${failures.join("\n")}`,
    );
  }
}

async function queryGalleryVersions({ fetchImpl = fetch } = {}) {
  const body = {
    filters: [
      {
        criteria: [{ filterType: 7, value: EXTENSION_ID }],
        pageNumber: 1,
        pageSize: 1,
      },
    ],
    flags: 914,
  };
  const response = await fetchImpl(
    "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
    {
      method: "POST",
      headers: {
        Accept: "application/json;api-version=7.2-preview.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok)
    throw new Error(`Gallery query failed: HTTP ${response.status}`);
  const payload = await response.json();
  return payload.results?.[0]?.extensions?.[0]?.versions || [];
}

function isPreReleaseVersion(item) {
  const property = item.properties?.find(
    ({ key }) => key === "Microsoft.VisualStudio.Code.PreRelease",
  );
  return String(property?.value).toLowerCase() === "true";
}

async function waitForValidatedTargets({
  version,
  preRelease = false,
  queryVersions = queryGalleryVersions,
  wait = delay,
  intervalMs = 15_000,
  timeoutMs = 30 * 60_000,
  requiredConsecutive = 2,
}) {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  let lastState = "";
  while (true) {
    const versions = await queryVersions();
    const matching = versions.filter((item) => item.version === version);
    const validated = new Set(
      matching
        .filter((item) => isPreReleaseVersion(item) === preRelease)
        .filter((item) =>
          String(item.flags)
            .split(",")
            .map((flag) => flag.trim())
            .includes("validated"),
        )
        .map((item) => item.targetPlatform),
    );
    const missing = TARGETS.filter((target) => !validated.has(target));
    const channel = preRelease ? "preview" : "stable";
    const state = `channel=${channel} validated=${
      validated.size
    }/5 missing=${missing.join(",")}`;
    if (state !== lastState) console.log(state);
    lastState = state;
    consecutive = missing.length === 0 ? consecutive + 1 : 0;
    if (consecutive >= requiredConsecutive) {
      console.log("CUKII-MARKETPLACE-FIVE-TARGETS-PASS");
      return;
    }
    if (Date.now() >= deadline) break;
    await wait(intervalMs);
  }
  throw new Error(`Marketplace validation timed out: ${lastState}`);
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

async function sha256Response(response) {
  if (!response.ok) {
    throw new Error(
      `Marketplace carrier download failed: HTTP ${response.status}`,
    );
  }
  const hash = crypto.createHash("sha256");
  if (response.body?.[Symbol.asyncIterator]) {
    for await (const chunk of response.body) hash.update(Buffer.from(chunk));
  } else {
    hash.update(Buffer.from(await response.arrayBuffer()));
  }
  return hash.digest("hex");
}

async function verifyPublishedCarrierHashes({
  packages,
  version,
  preRelease = false,
  queryVersions = queryGalleryVersions,
  fetchImpl = fetch,
}) {
  const versions = await queryVersions();
  for (const pkg of packages) {
    const published = versions.find(
      (item) =>
        item.version === version &&
        item.targetPlatform === pkg.target &&
        isPreReleaseVersion(item) === preRelease &&
        String(item.flags)
          .split(",")
          .map((flag) => flag.trim())
          .includes("validated"),
    );
    const packageAsset = published?.files?.find(
      (item) =>
        item.assetType === "Microsoft.VisualStudio.Services.VSIXPackage",
    );
    if (!packageAsset?.source) {
      throw new Error(`Marketplace VSIX asset missing for ${pkg.target}`);
    }
    const localHash = sha256File(pkg.filePath);
    const publishedHash = await sha256Response(
      await fetchImpl(packageAsset.source),
    );
    if (localHash !== publishedHash) {
      throw new Error(
        `Marketplace VSIX hash mismatch for ${pkg.target}: local=${localHash} published=${publishedHash}`,
      );
    }
    console.log(`CUKII-MARKETPLACE-HASH-PASS ${pkg.target} ${localHash}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packages = collectTargetVsix(options.vsixDir, options.version);
  const credential = await getMarketplaceCredential();
  await publishEveryTarget({
    packages,
    preRelease: options.preRelease,
    credential,
  });
  await waitForValidatedTargets({
    version: options.version,
    preRelease: options.preRelease,
  });
  await verifyPublishedCarrierHashes({
    packages,
    version: options.version,
    preRelease: options.preRelease,
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DUPLICATE_PATTERN,
  TARGETS,
  collectTargetVsix,
  getMarketplaceCredential,
  getVscePublishArgs,
  getVscePublishEnv,
  isPreReleaseVersion,
  parseArgs,
  publishEveryTarget,
  runVscePublish,
  verifyPublishedCarrierHashes,
  waitForValidatedTargets,
};
