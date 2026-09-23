// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  withOwnerFileLock,
  resolveOwnerFile,
  writeOwnerFileAtomic,
} from "@cukii/vendor-bridge";
