// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  cursorCatalogFromOutput,
  resolveCursorCatalogModel,
  ensureCursorCatalogVariants,
  codexCatalogFromCache,
  grokCatalogFromOutput,
  kimiCatalogFromJson,
  catalogProbeCommand,
  claudeProgram,
  parseClaudeCliVersion,
  compareDottedVersions,
  filterClaudeCatalogByVersion,
  resetClaudeCatalogProbeCache,
  staticCatalogForUnavailableDiscovery,
  listBrokerModelCatalog,
} from "@cukii/vendor-bridge";
