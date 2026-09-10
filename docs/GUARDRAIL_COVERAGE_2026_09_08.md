# Guardrail test coverage — 2026-09-08

This records current convention-manifest control evidence. A fulfilled activation gate is not automatically a measured upstream rejection. Public reporting must retain the distinctions below.

| Franchise | Upstream wrong-model rejection                                              | Upstream wrong-provider rejection                            |
| --------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| OpenAI    | Verified                                                                    | Verified                                                     |
| Anthropic | Verified                                                                    | Verified                                                     |
| Google    | Verified                                                                    | Verified                                                     |
| xAI       | Verified                                                                    | Verified with a reviewed independent selector                |
| Meta      | Verified with a reviewed non-contributor model                              | Not independently testable; singleton policy/local assurance |
| DeepSeek  | Verified                                                                    | Verified with a reviewed Fireworks control                   |
| Qwen      | Verified                                                                    | Not independently testable; singleton policy/local assurance |
| Mistral   | Verified                                                                    | Verified with a reviewed independent selector                |
| Kimi      | Not independently tested; explicit operator-accepted policy/local assurance | Verified                                                     |
| Z.ai      | Verified                                                                    | Verified                                                     |

Coverage is **9 of 10 measured wrong-model denials and 8 of 10 measured wrong-provider denials**. Every measured denial requires a complete authenticated response identifying one input endpoint removed solely by the tested guardrail dimension. The exact routing diagnostics are empirical evidence, not a claimed documented error-code guarantee. Generic 403/404 errors, unavailable providers and mixed rejection reasons do not pass.

## Explicit exceptions

Meta and Qwen expose only their assigned callable provider tags in the retrieved catalog. Their separate assurance requires fresh exact model/provider key-policy inspection, current catalog evidence, and executable tests of the actual driver with a sealed synthetic transport. Those tests prove exact request pinning and rejection of wrong returned model/provider identities. The upstream denial remains untested. Meta's current assurance artifact is `8e9f66bb-384e-4435-b181-38ad3bdf8552`; Qwen's is `c791efbb-15a6-46fe-be52-072ab4fc195f`.

For Kimi, the operator explicitly accepted weaker upstream test coverage while retaining `moonshotai/kimi-k3` on `moonshotai/mxfp4`. Six other currently listed Moonshot model entries with distinct canonical identities were checked; no callable alternate on that exact tag was found. This is a bounded same-developer search, not proof that no alternate could ever exist. The exception requires the exact inspected model/provider policy, a real reconciled correct-model canary with successful `research_sources` execution, the actual driver's local routing/rejection tests, and current catalog receipts. It does not relax returned-model identity validation. Artifact `1329f5b8-f0d2-4b6b-ac04-b972993195fa` links positive call `d3812ef3-27cc-4dff-a850-5bf6f5c033ce`.

Activation rechecks these facts and the hash of the executing driver source. A code change or changed policy requires fresh assurance. Public projections use `providerRestrictionEvidence` and `modelRestrictionEvidence` to retain `liveProbePassed: false` or `liveModelRejectionTested: false` for exceptions.

## Reviewed controls and economics

The initial xAI and Mistral provider controls used ancestor selectors (`xai` and `mistral`) that overlap their assigned ZDR selectors. Both generated responses; these were inconclusive controls, not successful denial tests. Later generation metadata identified the configured dated model and serving provider family but did not expose an endpoint tag. Observed charges were $0.000580 and $0.000042. Their original receipts and full uncertain reservations remain preserved. Separately approved, single-shot controls using `amazon-bedrock/us-west-2` and `mistral/eu` produced exact provider-policy rejections; captures are `555d1a3b-802b-40a1-8897-6f2d36be072c` and `88117a0e-f354-4391-8bef-753041e40738`.

The initial Meta contributor-model and DeepSeek-provider controls were confounded by account training-policy rejection. Separately approved controls changed the tested input: normal `meta/muse-spark-1.2` and the same DeepSeek model served by Fireworks. Both yielded sole guardrail rejection reasons; captures are `aababab9-6130-4fe0-9ded-b001400a50a3` and `e311da82-0ecb-416e-a47d-a8127bd8c81f`. Fireworks also publishes its no-training-without-opt-in policy. [Fireworks privacy policy](https://fireworks.ai/privacy-policy)

The final-manifest batch used 17 initial probes and four separately reviewed changed controls. Each reserved $1 before dispatch. Unknown costs were not converted to zero, and rejection proof did not release those holds. The reviewed-control API allows one linked revision only for the recorded account-training-policy confound or accepted ancestor-selector overlap; it does not permit blind retries or revision chains.

Private operational receipts and source hashes are in `.local/live/negative-controls/`. Reusable private helpers are `probe-franchises.ts`, `finalize-control-evidence.ts`, and `review-ancestor-controls.ts`. None activates a manifest or changes a franchise's assigned model or serving route. The public repository contains no provider keys.
