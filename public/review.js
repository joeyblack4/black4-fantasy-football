"use strict";
const $ = (id) => document.getElementById(id),
  el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
let token =
    sessionStorage.getItem("football-review-token") ||
    sessionStorage.getItem("football-token") ||
    sessionStorage.getItem("football-owner-token") ||
    "",
  me,
  selected = [],
  busy = false,
  meetingSnapshots = [];
const pendingKey = () => "football-review-pending:" + me.leagueId + ":" + me.id;
const ratificationKey = () =>
  "football-review-ratification:" + me.leagueId + ":" + me.id;
async function api(path, body) {
  if (body) {
    const old = sessionStorage.getItem(pendingKey());
    const next = JSON.stringify({ path, body });
    if (old && old !== next)
      throw Error("Reconcile the pending request first.");
    sessionStorage.setItem(pendingKey(), next);
    $("pending").hidden = false;
  }
  let r, v;
  try {
    r = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    v = await r.json();
  } catch {
    throw Error(
      "Response unavailable. The exact pending request is saved for reconciliation.",
    );
  }
  if (body && r.status < 500) {
    sessionStorage.removeItem(pendingKey());
    $("pending").hidden = true;
  }
  if (!r.ok) throw Error(v.message || v.error || "Request failed");
  return v;
}
function err(e) {
  $("error").textContent = e.message || String(e);
  $("error").hidden = false;
}
function button(text, fn) {
  const b = el("button", text);
  b.type = "button";
  b.onclick = () => void perform(fn);
  return b;
}
async function perform(fn) {
  if (busy) return;
  busy = true;
  $("error").hidden = true;
  try {
    const result = await fn();
    captureRatification(result);
    $("receipt").textContent = JSON.stringify(result, null, 2);
    await load();
  } catch (e) {
    err(e);
  } finally {
    busy = false;
  }
}
async function governance(command) {
  return api("/v1/governance/commands", {
    leagueId: me.leagueId,
    idempotencyKey: crypto.randomUUID(),
    ...command,
  });
}
async function load() {
  try {
    me = await api("/v1/me");
    $("login-form").hidden = true;
    $("review").hidden = false;
    $("identity").textContent = me.role + " · " + me.id;
    $("pending").hidden = !sessionStorage.getItem(pendingKey());
    $("operator").hidden = me.role !== "commissioner";
    $("prepare").hidden = me.role !== "commissioner";
    selected = [];
    const [meetings, f] = await Promise.all([
      api("/v1/governance/meetings"),
      api("/v1/franchise"),
    ]);
    meetingSnapshots = meetings.meetings;
    $("meetings").replaceChildren();
    for (const m of meetings.meetings) {
      const box = el("article");
      box.append(
        el("h3", m.meeting.id),
        el(
          "p",
          "Proposal deadline " +
            new Date(m.meeting.proposal_deadline).toLocaleString() +
            " · Vote deadline " +
            new Date(m.meeting.vote_deadline).toLocaleString(),
        ),
      );
      for (const p of m.proposals) {
        const d = el("details"),
          s = el("summary", p.title + " · " + p.id);
        d.append(s, el("pre", JSON.stringify(p, null, 2)));
        if (me.role === "owner") {
          d.append(
            button("Vote yes on this proposal", () =>
              governance({ type: "castVote", proposalId: p.id, choice: "yes" }),
            ),
            button("Vote no", () =>
              governance({ type: "castVote", proposalId: p.id, choice: "no" }),
            ),
          );
        } else if (me.role === "commissioner")
          d.append(
            button("Prepare ratification receipt", () =>
              prepareRatification(p),
            ),
          );
        box.append(d);
      }
      box.append(el("pre", JSON.stringify({ votes: m.votes }, null, 2)));
      $("meetings").append(box);
    }
    if (!meetings.meetings.length)
      $("meetings").append(el("p", "No meeting has been opened."));
    renderRatification();
    $("drafts").replaceChildren();
    const seen = new Set();
    for (const d of f.drafts) {
      const key = d.team_id + ":" + d.draft_id;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = el("article");
      a.append(
        el("h3", d.title),
        el("p", d.team_id + " · " + d.channel + " · version " + d.version),
        el("pre", d.body),
        el("small", "Hash " + d.content_hash),
      );
      if (me.role === "commissioner") {
        const label = el("label"),
          c = el("input");
        c.type = "checkbox";
        c.onchange = () => {
          selected = selected.filter(
            (x) => x.draftId !== d.draft_id || x.teamId !== d.team_id,
          );
          if (c.checked)
            selected.push({
              teamId: d.team_id,
              draftId: d.draft_id,
              version: d.version,
              contentHash: d.content_hash,
            });
        };
        label.append(c, document.createTextNode(" Include this exact version"));
        a.append(label);
      }
      $("drafts").append(a);
    }
    if (!f.drafts.length)
      $("drafts").append(el("p", "No owner-authored drafts yet."));
    $("services").replaceChildren();
    for (const s of f.serviceRequests) {
      const a = el("article");
      a.append(el("h3", s.service), el("pre", JSON.stringify(s, null, 2)));
      if (me.role === "commissioner" && s.status === "requested")
        for (const decision of ["approved", "rejected"])
          a.append(
            button(
              decision === "approved"
                ? "Approve request for separate provisioning"
                : "Reject request",
              () =>
                api("/v1/services/review", {
                  requestId: s.id,
                  decision,
                  note: "Reviewed by commissioner in the private review interface. Approval does not purchase or provision service.",
                }),
            ),
          );
      $("services").append(a);
    }
  } catch (e) {
    err(e);
  }
}
$("login-form").onsubmit = (e) => {
  e.preventDefault();
  token = $("credential").value.trim();
  sessionStorage.setItem("football-review-token", token);
  $("credential").value = "";
  void load();
};
$("refresh").onclick = () => void load();
$("logout").onclick = () => {
  for (const k of [
    "football-review-token",
    "football-token",
    "football-owner-token",
  ])
    sessionStorage.removeItem(k);
  token = "";
  location.reload();
};
$("prepare").onclick = () =>
  void perform(async () => {
    if (!selected.length)
      throw Error("Select at least one exact draft version.");
    const b = await api("/v1/publication/prepare", { items: selected });
    $("batch").replaceChildren(
      el("h3", "Exact batch awaiting approval"),
      el("pre", JSON.stringify(b.items, null, 2)),
      el("p", "Batch hash: " + b.content_hash),
      button("Approve this exact batch", () =>
        api("/v1/publication/approve", {
          batchId: b.id,
          contentHash: b.content_hash,
        }),
      ),
    );
    return b;
  });
$("open-meeting").onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  void perform(() =>
    governance({
      type: "openMeeting",
      meetingId: f.get("meetingId"),
      proposalDeadline: new Date(f.get("proposalDeadline")).toISOString(),
      voteDeadline: new Date(f.get("voteDeadline")).toISOString(),
    }),
  );
};
$("draft-clock").onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  const input = {
    type: e.submitter.value,
    reason: f.get("reason"),
    leagueId: me.leagueId,
    idempotencyKey: crypto.randomUUID(),
  };
  void perform(() => api("/v1/commands", input));
};
if (token) void load();

$("retry-exact").onclick = () =>
  void perform(async () => {
    const p = JSON.parse(sessionStorage.getItem(pendingKey()) || "null");
    if (!p) throw Error("No pending request");
    return api(p.path, p.body);
  });

async function prepareRatification(proposal) {
  sessionStorage.setItem(
    ratificationKey(),
    JSON.stringify({ proposal, decision: null }),
  );
  return governance({ type: "prepareRatification", proposalId: proposal.id });
}
function captureRatification(receipt) {
  if (me.role !== "commissioner") return;
  const result = receipt?.result;
  if (result?.status === "ratified") {
    sessionStorage.removeItem(ratificationKey());
    return;
  }
  if (result?.status !== "eligible-for-commissioner-ratification") return;
  const saved = JSON.parse(sessionStorage.getItem(ratificationKey()) || "null");
  if (
    !saved ||
    saved.proposal.id !== result.proposalId ||
    saved.proposal.version !== result.version
  )
    throw Error(
      "The prepared decision does not match the selected proposal. Refresh and prepare that proposal again.",
    );
  sessionStorage.setItem(
    ratificationKey(),
    JSON.stringify({ ...saved, decision: result }),
  );
}
function renderRatification() {
  const box = $("ratification");
  box.replaceChildren();
  if (me.role !== "commissioner") return;
  const saved = JSON.parse(sessionStorage.getItem(ratificationKey()) || "null");
  if (!saved?.decision) return;
  const p = saved.proposal,
    d = saved.decision;
  const fresh = meetingSnapshots
    .flatMap((m) => m.proposals)
    .find((x) => x.id === p.id);
  box.append(
    el("h3", "Final constitution review"),
    el(
      "p",
      "This decision has " +
        d.yesVotes +
        " recorded yes votes. Ratification fixes the displayed football rules, scoring, capability version and draft order.",
    ),
    el("p", "Proposal " + p.id + " · version " + p.version),
    el("p", "Exact proposal hash: " + p.content_hash),
    el(
      "pre",
      JSON.stringify(
        {
          rules: p.rules,
          scoring: p.scoring_rules,
          capabilityVersion: p.capability_version,
          teamOrder: p.team_order,
          decisionId: d.decisionId,
        },
        null,
        2,
      ),
    ),
  );
  if (
    !fresh ||
    fresh.content_hash !== p.content_hash ||
    fresh.version !== p.version
  ) {
    box.append(
      el(
        "p",
        "The selected proposal no longer matches this review. Refresh and prepare a new decision.",
      ),
    );
    return;
  }
  box.append(
    button("Ratify this exact constitution", () =>
      api("/v1/commands", {
        type: "ratifyConstitution",
        leagueId: me.leagueId,
        idempotencyKey: crypto.randomUUID(),
        version: p.version,
        proposalId: p.id,
        proposalHash: p.content_hash,
        decisionReceipt: d.decisionId,
        rules: p.rules,
      }),
    ),
  );
}
