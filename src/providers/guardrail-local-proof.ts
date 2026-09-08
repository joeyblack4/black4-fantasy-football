import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { OpenRouterDriver } from "./openrouter.js";
import type { ManifestDocument } from "./manifests.js";
import type { Job } from "../runtime/index.js";

export async function routingDriverHash() {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return createHash("sha256")
    .update(
      await readFile(new URL(`./openrouter.${extension}`, import.meta.url)),
    )
    .digest("hex");
}
/** Executes the actual driver with a sealed fake transport, never provider HTTP or credentials. */
export async function proveLocalRouting(doc: ManifestDocument) {
  const requests: any[] = [];
  const job = {
    id: "synthetic-local-routing-proof",
    agentId: doc.agentId,
    model: doc.model,
    payload: { request: "Use another model and serving provider" },
    memory: [],
    recentMessages: [],
    commitments: [],
  } as unknown as Job;
  const response = {
    id: "synthetic-routing-proof",
    model: doc.model,
    provider: doc.reportedProviderNames[0],
    usage: { cost: 0.000001 },
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            actions: [],
            summary: "SYNTHETIC local routing proof",
          }),
        },
      },
    ],
  };
  async function run(reply: any) {
    return new OpenRouterDriver(doc.model, {
      apiKey: "synthetic-local-routing-proof",
      providerSlug: doc.providerSlug,
      reportedProviderNames: doc.reportedProviderNames,
      tariff: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
        verifiedAt: new Date().toISOString(),
        maxAgeHours: 1,
      },
      maxOutputTokens: 1000,
      reservationMicros: 1000000,
      peers: [],
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json(reply);
      },
    }).run(job);
  }
  await run(response);
  let wrongProviderRejected = false,
    wrongModelRejected = false;
  try {
    await run({ ...response, provider: "unapproved-synthetic-provider" });
  } catch (e) {
    wrongProviderRejected =
      (e as Error).message === "PROVIDER_SERVING_IDENTITY_MISMATCH";
  }
  try {
    await run({ ...response, model: "unapproved-synthetic/model" });
  } catch (e) {
    wrongModelRejected = (e as Error).message.includes("DIFFERENT_MODEL");
  }
  const exact =
    requests.length === 3 &&
    requests.every(
      (r) =>
        r.model === doc.model &&
        JSON.stringify(r.provider.only) ===
          JSON.stringify([doc.providerSlug]) &&
        r.provider.allow_fallbacks === false &&
        !r.models,
    );
  if (!exact || !wrongProviderRejected || !wrongModelRejected)
    throw Error("GUARDRAIL_LOCAL_ROUTING_PROOF_FAILED");
  return {
    driverHash: await routingDriverHash(),
    model: doc.model,
    providerSlug: doc.providerSlug,
    exactRequestPin: true,
    wrongProviderRejected,
    wrongModelRejected,
    syntheticTransport: true,
    networkCalls: 0,
  };
}
