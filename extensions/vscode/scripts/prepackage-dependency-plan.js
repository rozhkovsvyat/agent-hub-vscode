function createPrepackageDependencyTasks({
  skipInstalls,
  generateConfigYamlSchema,
  installDependencies,
}) {
  const tasks = [() => generateConfigYamlSchema({ skipInstall: skipInstalls })];

  if (!skipInstalls) {
    tasks.push(installDependencies);
  }

  return tasks;
}

function assertMissingDependencyCanBeInstalled({
  skipInstalls,
  dependencyName,
  expectedPath,
}) {
  if (skipInstalls) {
    throw new Error(
      `[SKIP_INSTALLS] ${dependencyName} is missing at ${expectedPath}; refusing a hidden dependency install`,
    );
  }
}

module.exports = {
  assertMissingDependencyCanBeInstalled,
  createPrepackageDependencyTasks,
};
