import { describe, expect, it } from "vitest";
import { CUKII_VENDOR_REGISTRY, cukiiVendorLabel } from "./cukiiVendorRegistry";
import {
  ALIBABA_CHAT_MODELS,
  ALIBABA_NON_CHAT_CAPABILITIES,
  ALIBABA_TOKEN_PLAN_ANTHROPIC_ENDPOINT,
  ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT,
  ALIBABA_TOKEN_PLAN_REGION,
  ALIBABA_VENDOR_LABEL,
  CUKII_DEFAULT_BROKER_MODEL,
  VENDOR_ACCOUNT_COPY,
  alibabaCapabilityAvailability,
  alibabaChatCatalog,
  alibabaChatNativeIds,
  alibabaNativeModelId,
  classifyAlibabaCatalogId,
  isAlibabaChatModel,
  isAlibabaNonChatCapability,
} from "./cukiiAlibabaCatalog";

describe("Alibaba Token Plan catalog", () => {
  it("puts Alibaba first with the canonical vendor label", () => {
    expect(CUKII_VENDOR_REGISTRY[0]).toEqual({
      id: "qwen",
      label: ALIBABA_VENDOR_LABEL,
    });
    expect(cukiiVendorLabel("qwen")).toBe("Alibaba");
    expect(cukiiVendorLabel("qwen")).not.toBe("Alibaba Cloud");
    expect(CUKII_DEFAULT_BROKER_MODEL).toBe("qwen-3-8-max");
  });

  it("uses shared Manage Accounts identity and action copy", () => {
    expect(VENDOR_ACCOUNT_COPY).toEqual({
      login: "Log in",
      logout: "Log out",
      disconnected: "Not logged in",
      connectedFallback: "Connected",
    });
  });

  it("classifies only the requested text/reasoning/vision-chat models as chat", () => {
    expect(alibabaChatNativeIds()).toEqual([
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.7-plus",
      "qwen3.7-max",
      "qwen3.6-flash",
      "deepseek-v4-pro-0813",
      "deepseek-v4-pro",
      "deepseek-v4-flash-0731",
      "glm-5.2",
    ]);
    expect(alibabaChatCatalog().map((model) => model.value)).toEqual(
      ALIBABA_CHAT_MODELS.map((model) => model.value),
    );
    for (const model of ALIBABA_CHAT_MODELS) {
      expect(classifyAlibabaCatalogId(model.value)).toBe("chat");
      expect(alibabaCapabilityAvailability(model.value)).toBe("chat");
      expect(isAlibabaChatModel(model.value)).toBe(true);
      expect(isAlibabaNonChatCapability(model.value)).toBe(false);
      expect(alibabaNativeModelId(model.value)).toBe(model.nativeId);
      if (model.nativeId !== "deepseek-v4-pro") {
        expect(classifyAlibabaCatalogId(model.nativeId)).toBe("chat");
      }
    }
    expect(isAlibabaChatModel("deepseek-v4-pro")).toBe(false);
  });

  it("keeps image/audio/video capabilities out of the chat picker", () => {
    const chatValues = new Set(
      alibabaChatCatalog().map((model) => model.value),
    );
    const chatNatives = new Set(alibabaChatNativeIds());
    for (const capability of ALIBABA_NON_CHAT_CAPABILITIES) {
      expect(chatValues.has(capability.id)).toBe(false);
      expect(chatNatives.has(capability.id)).toBe(false);
      expect(classifyAlibabaCatalogId(capability.id)).toBe(
        "capability-unavailable",
      );
      expect(alibabaCapabilityAvailability(capability.id)).toBe("Coming soon");
      expect(alibabaNativeModelId(capability.id)).toBeUndefined();
      expect(isAlibabaChatModel(capability.id)).toBe(false);
      expect(capability.route).toBe("unsupported");
    }
    expect(ALIBABA_NON_CHAT_CAPABILITIES.map((item) => item.id)).toEqual([
      "qwen-image-3.0-pro",
      "qwen-audio-3.0-asr-flash",
      "qwen-audio-3.0-tts-plus",
      "qwen-audio-3.0-realtime-plus",
      "wan2.7-image",
      "wan2.7-image-pro",
      "happyhorse-1.1-i2v",
      "happyhorse-1.1-t2v",
      "happyhorse-1.1-r2v",
    ]);
  });

  it("uses the Singapore compatible-mode endpoint instead of Anthropic", () => {
    expect(ALIBABA_TOKEN_PLAN_REGION).toBe("ap-southeast-1");
    expect(ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    );
    expect(ALIBABA_TOKEN_PLAN_ANTHROPIC_ENDPOINT).toContain("anthropic");
    expect(ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT).not.toContain("anthropic");
  });
});
