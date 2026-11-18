const stableJson = (value) => JSON.stringify(value);

export function assertStableCapture(before, after) {
  const exactFields = ["outerSrc", "tuple", "targetId", "targetUrl", "workbenchViewport"];
  for (const field of exactFields) {
    if (stableJson(before[field]) !== stableJson(after[field])) {
      throw new Error(`capture drift: ${field} changed`);
    }
  }
  for (const key of ["x", "y", "width", "height"]) {
    if (Math.abs(before.box[key] - after.box[key]) > 0.01) {
      throw new Error(`capture drift: outer box ${key} changed`);
    }
  }
  if (before.bodyTextSha256 !== after.bodyTextSha256) {
    throw new Error("capture drift: visible body text changed");
  }
  if (before.visibleInteractiveSha256 !== after.visibleInteractiveSha256) {
    throw new Error("capture drift: visible interactive DOM changed");
  }
  if (stableJson(before.innerViewport) !== stableJson(after.innerViewport)) {
    throw new Error("capture drift: inner viewport changed");
  }
  if (stableJson(before.resources) !== stableJson(after.resources)) {
    throw new Error("capture drift: loaded resources changed");
  }
}

export function assertExactResourceBinding(runtime, extensionId) {
  const scripts = runtime.resources.filter((url) => /\/index\.js(?:\?|$)/iu.test(url));
  const styles = runtime.resources.filter((url) => /\/index\.css(?:\?|$)/iu.test(url));
  const manifests = runtime.resourceBinding.filter((entry) => entry.manifest);
  if (scripts.length !== 1 || styles.length !== 1 || manifests.length !== 1) {
    throw new Error(
      `resource binding must contain exactly one index.js, index.css and manifest; got ${scripts.length}/${styles.length}/${manifests.length}`,
    );
  }
  const manifestEntry = manifests[0];
  const identity = `${manifestEntry.manifest.publisher}.${manifestEntry.manifest.name}`;
  if (identity.toLowerCase() !== extensionId.toLowerCase()) {
    throw new Error(`manifest identity ${identity} does not match ${extensionId}`);
  }
  const rootName = manifestEntry.filePath.replaceAll("\\", "/").split("/").at(-2);
  const expectedRootPrefix = `${identity}-${manifestEntry.manifest.version}`.toLowerCase();
  if (!rootName?.toLowerCase().startsWith(expectedRootPrefix)) {
    throw new Error(`extension root ${rootName} does not match ${expectedRootPrefix}`);
  }
  const boundPaths = runtime.resourceBinding.map((entry) => entry.filePath.toLowerCase());
  for (const required of ["index.js", "index.css"]) {
    if (!boundPaths.some((filePath) => filePath.endsWith(required))) {
      throw new Error(`bound file missing: ${required}`);
    }
  }
  return {
    extensionId,
    identity,
    version: manifestEntry.manifest.version,
    rootName,
    script: scripts[0],
    style: styles[0],
    manifestPath: manifestEntry.filePath,
  };
}

export function assertSemanticTransition(label, before, after) {
  if (before.visibleCount !== 0 || after.visibleCount < 1) {
    throw new Error(
      `${label}: expected hidden→visible transition, got ${before.visibleCount}→${after.visibleCount}`,
    );
  }
}

export function assertStyleTransition(label, before, after, property) {
  if (before.visibleCount !== 1 || after.visibleCount !== 1) {
    throw new Error(`${label}: expected one visible target before and after`);
  }
  if (before.matches[0].computed[property] === after.matches[0].computed[property]) {
    throw new Error(`${label}: ${property} did not change`);
  }
}
