import { mkdir, writeFile } from "node:fs/promises";
const candidates = [
  "openai/gpt-6-astra",
  "anthropic/claude-fable-5.1",
  "google/gemini-3.1-pro-preview",
  "x-ai/grok-4.6",
  "meta/muse-spark-1.3",
  "deepseek/deepseek-v4-pro-0813",
  "qwen/qwen3.8-max-0902",
  "mistralai/mistral-medium-3-5",
  "moonshotai/kimi-k3",
  "z-ai/glm-5.3",
];
const response = await fetch("https://openrouter.ai/api/v1/models", {
  signal: AbortSignal.timeout(30000),
});
if (!response.ok)
  throw new Error("Public model catalog unavailable: " + response.status);
const catalog = (await response.json()) as any;
const result = {
  checkedAt: new Date().toISOString(),
  source: "https://openrouter.ai/api/v1/models",
  authenticatedCanaries: 0,
  meaning:
    "Catalog presence and advertised parameters only. Not proof of flagship selection, key access, tool reliability or production price.",
  candidates: candidates.map((id) => {
    const model = catalog.data.find((m: any) => m.id === id);
    return {
      id,
      present: !!model,
      ...(model
        ? {
            name: model.name,
            contextLength: model.context_length,
            pricing: model.pricing,
            supportedParameters: model.supported_parameters,
          }
        : {}),
      canary: "NOT_RUN",
    };
  }),
};
await mkdir(".local", { recursive: true });
await writeFile(
  ".local/model-catalog-check.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
