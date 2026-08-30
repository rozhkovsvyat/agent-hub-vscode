/**
 * Short, factual model-family positioning for the compact Cukii picker.
 * Live CLI metadata takes precedence; this catalog covers static models and
 * CLIs (notably Cursor) that expose an id/label but no description.
 */
export function canonicalCukiiModelDescription(
  value: string,
  label: string,
): string {
  const id = value.toLowerCase().replace(/^cursor:/, "");
  const name = label.toLowerCase();
  const matches = (pattern: RegExp) => pattern.test(id) || pattern.test(name);

  if (matches(/(?:^|[-\s])fable(?:[-\s]|$)/))
    return "Most capable for the hardest, longest-running tasks";
  if (matches(/(?:^|[-\s])opus(?:[-\s]|$)/))
    return "Best for everyday, complex tasks";
  if (matches(/(?:^|[-\s])sonnet(?:[-\s]|$)/))
    return "Efficient for routine development tasks";
  if (matches(/(?:^|[-\s])haiku(?:[-\s]|$)/))
    return "Fastest for quick answers";
  if (matches(/gpt[-\s]?5[.-]6[-\s]sol/))
    return "Latest frontier agentic coding model";
  if (matches(/gpt[-\s]?5[.-]6[-\s]terra/))
    return "Balanced agentic coding model for everyday work";
  if (matches(/gpt[-\s]?5[.-]6[-\s]luna/))
    return "Fast, affordable agentic coding model";
  if (matches(/gpt[-\s]?5[.-]5/))
    return "Frontier model for complex coding and research";
  if (matches(/gpt[-\s]?5[.-]4[-\s]mini/))
    return "Fast, cost-efficient model for simpler coding tasks";
  if (matches(/gpt[-\s]?5[.-]4/)) return "Strong model for everyday coding";
  if (matches(/(?:^|[-\s])grok(?:[-\s]|$)/))
    return "xAI model for coding and agentic tasks";
  if (matches(/composer[-\s]?2[.-]5/))
    return "Fast agentic model for long-running coding tasks";
  if (matches(/kimi[-\s]?k3|(?:^|[-\s])k3(?:[-\s]|$)/))
    return /256k/.test(id) || /256k/.test(name)
      ? "Quota-efficient K3 for routine development"
      : "Flagship for long-horizon coding and knowledge work";
  if (matches(/kimi[-\s]?k2|k2[.-]7/))
    return /highspeed/.test(id) || /highspeed/.test(name)
      ? "High-speed K2.7 for routine development"
      : "Coding model for completion and routine development";
  if (matches(/qwen[-\s]?3[.-]8[-\s]max/))
    return "Max model for tool use and agent workflows";
  if (matches(/gemini/)) return "Gemini model available through Cursor";
  if (matches(/glm/)) return "GLM model available through Cursor";
  if (matches(/deepseek/)) return "DeepSeek coding model";
  return "Model available through the vendor CLI";
}

/** Product-level capability tier shown as Cukii bottles in the model picker. */
export function cukiiCapabilityRating(
  model: Pick<CukiiModelPresentation, "value" | "label">,
): 1 | 2 | 3 | 4 {
  const stableId = model.value.toLowerCase().replace(/^cursor:/, "");
  const fallbackLabel = model.label.toLowerCase();
  const matches = (pattern: RegExp) =>
    pattern.test(stableId) || pattern.test(fallbackLabel);

  if (matches(/(?:^|[-\s])fable(?:[-\s]|$)/)) return 4;
  if (
    matches(/(?:^|[-\s])opus(?:[-\s]|$)/) ||
    matches(/gpt[-\s]?5[.-]6[-\s]sol/) ||
    matches(/(?:^|[-\s])kimi[-\s]?k3(?:[-\s]|$)/) ||
    matches(/qwen[-\s]?3[.-]8[-\s]max/)
  ) {
    return 3;
  }
  if (
    matches(/(?:^|[-\s])sonnet(?:[-\s]|$)/) ||
    matches(/gpt[-\s]?5[.-]6[-\s]terra/) ||
    matches(/(?:^|[-\s])grok(?:[-\s]|$)/)
  ) {
    return 2;
  }
  return 1;
}

/** The compact second line shared by every Cukii model picker option. */
export function formatCukiiModelSubtitle(
  contextWindowLabel: string,
  description: string,
): string {
  return `${contextWindowLabel} context • ${description}`;
}

interface CukiiModelPresentation {
  value: string;
  label: string;
}
