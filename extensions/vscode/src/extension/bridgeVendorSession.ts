// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  isVendorSessionId,
  argvRequestsVendorResume,
  rememberVendorSession,
  rememberedVendorSession,
  forgetVendorSession,
  isVendorSessionLossError,
  resetVendorSessionsForTests,
} from "@cukii/vendor-bridge";
