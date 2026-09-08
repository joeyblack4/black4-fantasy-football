const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("football-token") || "",
  state = null,
  selected = null;
const money = (value) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(value || 0) / 1e6,
  );
const time = (value) =>
  value
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function error(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}
async function api(path) {
  const response = await fetch(path, {
    headers: { authorization: "Bearer " + token },
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.message || body.error || "Request failed");
  return body;
}
function render() {
  const r = state.runtime,
    l = state.league;
  const counts = {
    completed: r.jobs.filter((j) => j.status === "completed").length,
    pending: r.jobs.filter((j) => ["pending", "running"].includes(j.status))
      .length,
    dead: r.jobs.filter((j) => j.status === "dead").length,
  };
  $("summary").replaceChildren();
  for (const [number, label] of [
    [l.picks.length, "draft picks recorded"],
    [counts.completed, "jobs completed"],
    [counts.pending, "jobs pending"],
    [r.messages.length, "messages recorded"],
    [counts.dead, "failed jobs"],
  ]) {
    const node = el("span");
    node.append(el("strong", String(number)), document.createTextNode(label));
    $("summary").append(node);
  }
  $("owners").replaceChildren();
  for (const team of l.teams) {
    const agent = r.agents.find((a) => a.id === team.id);
    const jobs = r.jobs
      .filter(
        (j) =>
          j.agent_id === team.id && ["pending", "running"].includes(j.status),
      )
      .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
    const row = el("tr");
    if (team.id === selected) row.className = "selected";
    const first = el("td");
    const button = el("button", team.name, "owner-choice");
    button.addEventListener("click", () => {
      selected = team.id;
      render();
    });
    first.append(
      button,
      el(
        "small",
        team.kind === "human"
          ? "Human placeholder · no worker seeded"
          : "Test driver · model access pending",
      ),
    );
    row.append(
      first,
      el(
        "td",
        jobs.length
          ? `${jobs[0].status} · ${time(jobs[0].due_at)}`
          : "No pending job",
      ),
      el(
        "td",
        `${money(agent?.spent_micros)} / ${money(agent?.reserved_micros)}`,
      ),
    );
    $("owners").append(row);
  }
  if (!selected && l.teams.length) selected = l.teams[0].id;
  const team = l.teams.find((t) => t.id === selected),
    agent = r.agents.find((a) => a.id === selected);
  $("selected-name").textContent = team?.name || "Select an owner";
  $("selected-info").replaceChildren(
    el("div", `Configured driver: ${agent?.model || "No runtime"}`),
    el(
      "div",
      `Budget ${money(agent?.budget_micros)} · Available ${money(Number(agent?.budget_micros || 0) - Number(agent?.spent_micros || 0) - Number(agent?.reserved_micros || 0))}`,
    ),
    el(
      "div",
      `Roster: ${l.rosters.filter((p) => p.team_id === selected).length} players · FAAB ${team?.faab ?? "unknown"}`,
    ),
  );
  const jobs = r.jobs
    .filter((j) => j.agent_id === selected)
    .slice(-6)
    .reverse();
  $("jobs").replaceChildren();
  if (!jobs.length) $("jobs").append(el("li", "No jobs recorded."));
  for (const job of jobs) {
    const item = el("li", `${job.kind} · ${job.status}`);
    item.append(
      el(
        "time",
        `Due ${time(job.due_at)} · Attempt ${job.attempts} · ${job.causal_id}`,
      ),
    );
    if (job.error) item.append(el("div", job.error));
    $("jobs").append(item);
  }
  $("messages").replaceChildren();
  const messages = r.messages.filter(
    (m) => m.sender_id === selected || m.recipient_id === selected,
  );
  if (!messages.length)
    $("messages").append(
      el("p", "No conversation recorded for this franchise.", "empty"),
    );
  for (const m of messages) {
    const node = el("article", undefined, "message"),
      byline = el("div", undefined, "byline");
    byline.append(
      el("span", `${m.sender_id} → ${m.recipient_id}`),
      el("time", time(m.created_at)),
    );
    node.append(
      byline,
      el("p", m.body),
      el(
        "div",
        `${m.delivered_at ? "Delivered " + time(m.delivered_at) : "Delivery pending"} · ${m.responded_at ? "Reply recorded" : "No reply recorded"}`,
        "receipt",
      ),
    );
    $("messages").append(node);
  }
  $("receipts").replaceChildren();
  for (const receipt of r.receipts.slice(-15).reverse()) {
    const row = el("div", undefined, "receipt-row");
    row.append(
      el("time", time(receipt.created_at)),
      el("span", receipt.type),
      el("span", `${receipt.agent_id || "system"} · #${receipt.seq}`),
    );
    $("receipts").append(row);
  }
  $("updated").textContent = "Read at " + time(new Date());
}
async function refresh() {
  try {
    state = await api("/v1/operations");
    $("login").hidden = true;
    $("workbench").hidden = false;
    error("");
    render();
  } catch (e) {
    error(e.message);
  }
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = $("credential").value.trim();
  sessionStorage.setItem("football-token", token);
  await refresh();
  $("credential").value = "";
});
$("refresh").addEventListener("click", refresh);
$("logout").addEventListener("click", () => {
  sessionStorage.removeItem("football-token");
  token = "";
  state = null;
  $("workbench").hidden = true;
  $("login").hidden = false;
  error("");
});
if (token) void refresh();
setInterval(() => {
  if (token && state && document.visibilityState === "visible") void refresh();
}, 5000);
