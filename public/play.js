"use strict";
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("football-owner-token") || "",
  me = null,
  state = null,
  inbox = null,
  scores = null,
  scoreError = "",
  queue = [],
  queueDirty = false,
  replyTo = null,
  pending = null,
  busy = false;
const node = (tag, text, className) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
};
const stamp = (value) => (value ? new Date(value).toLocaleString() : "Unknown");
const pendingKey = () => `football-pending:${me.leagueId}:${me.id}`;
function error(message = "") {
  $("error").textContent = message;
  $("error").hidden = !message;
}
function pendingDisplay() {
  $("pending-panel").hidden = !pending;
  $("pending-description").textContent = pending
    ? `${pending.label}. Request ID: ${pending.body.idempotencyKey || pending.body.causalId}`
    : "";
}
function storePending(value) {
  pending = value;
  if (value) sessionStorage.setItem(pendingKey(), JSON.stringify(value));
  else sessionStorage.removeItem(pendingKey());
  pendingDisplay();
}
async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        authorization: "Bearer " + token,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    const e = new Error("Network response was not received.");
    e.uncertain = true;
    throw e;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    const e = new Error(
      "Response could not be verified. Retry the same request.",
    );
    e.uncertain = true;
    throw e;
  }
  if (!response.ok) {
    const e = new Error(
      body.message || body.error || `Request failed (${response.status})`,
    );
    e.uncertain = response.status >= 500;
    throw e;
  }
  return body;
}
function receipt(label, data) {
  const item = node("li");
  item.append(
    node("strong", label + " · accepted"),
    node("div", `Receipt ${data.receiptId || data.id || "not returned"}`),
    node("time", stamp(new Date())),
  );
  if (data.result?.status)
    item.append(node("div", "Recorded state: " + data.result.status));
  $("receipt-list").prepend(item);
}
async function mutate(label, path, payload, retry = false) {
  if (busy) return;
  if (pending && !retry) {
    error("Resolve the pending request first using its exact retry button.");
    return;
  }
  if (!retry)
    storePending({
      label,
      path,
      body: structuredClone(
        path === "/v1/commands"
          ? {
              leagueId: me.leagueId,
              idempotencyKey: crypto.randomUUID(),
              ...payload,
            }
          : { causalId: crypto.randomUUID(), ...payload },
      ),
    });
  const attempt = pending;
  busy = true;
  error();
  $("retry").disabled = true;
  try {
    const result = await request(attempt.path, {
      method: "POST",
      body: JSON.stringify(attempt.body),
    });
    if (!(result.receiptId || result.id)) {
      const e = new Error(
        "No acceptance receipt returned. Keep the same request ID.",
      );
      e.uncertain = true;
      throw e;
    }
    receipt(attempt.label, result);
    storePending(null);
    if (attempt.body.type === "setDraftQueue") queueDirty = false;
    if (attempt.path.endsWith("/messages")) {
      $("message-body").value = "";
      clearReply();
    }
    try {
      await refresh();
    } catch (e) {
      error(
        "Action accepted; the latest state could not be refreshed. " +
          e.message,
      );
    }
  } catch (e) {
    if (!e.uncertain && e.name !== "TypeError") storePending(null);
    error(
      (pending ? "Acceptance is unresolved. " : "Request rejected. ") +
        e.message,
    );
  } finally {
    busy = false;
    $("retry").disabled = false;
  }
}
const player = (id) => state.players.find((p) => p.id === id);
const playerText = (id) => {
  const p = player(id);
  return p ? `${p.name} · ${p.positions.join("/")} (${p.id})` : id;
};
const teamText = (id) => state.teams.find((t) => t.id === id)?.name || id;
const rosterFor = (id) =>
  state.rosters.filter((r) => r.team_id === id).map((r) => r.player_id);
function options(select, entries, placeholder = "Choose…") {
  const old = select.value;
  select.replaceChildren();
  const empty = node("option", placeholder);
  empty.value = "";
  select.append(empty);
  for (const [value, text] of entries) {
    const option = node("option", text);
    option.value = value;
    select.append(option);
  }
  if (entries.some(([value]) => value === old)) select.value = old;
}
function renderAvailable() {
  const query = $("player-search").value.toLowerCase(),
    owned = new Set(state.rosters.map((r) => r.player_id));
  const available = state.players.filter(
    (p) =>
      !owned.has(p.id) &&
      `${p.id} ${p.name} ${p.positions.join(" ")}`
        .toLowerCase()
        .includes(query),
  );
  options(
    $("draft-player"),
    available.map((p) => [p.id, playerText(p.id)]),
    "Select an available player",
  );
  $("draft-hint").textContent =
    `${available.length} matching available players. Queue changes remain local until you save them.`;
}
function renderQueue() {
  $("draft-queue-details").open = state.league.status !== "active";
  $("queue").replaceChildren();
  for (const [index, id] of queue.entries()) {
    const li = node("li", `${index + 1}. ${playerText(id)} `),
      up = node("button", "Move up", "secondary"),
      remove = node("button", "Remove", "secondary");
    up.type = remove.type = "button";
    up.disabled = index === 0 || state.league.status === "active";
    remove.disabled = state.league.status === "active";
    up.setAttribute("aria-label", "Move " + playerText(id) + " up");
    remove.setAttribute("aria-label", "Remove " + playerText(id));
    up.onclick = () => {
      [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
      queueDirty = true;
      renderQueue();
    };
    remove.onclick = () => {
      queue.splice(index, 1);
      queueDirty = true;
      renderQueue();
    };
    li.append(up, remove);
    $("queue").append(li);
  }
  if (!queue.length) $("queue").append(node("li", "Queue is empty."));
}
function renderLineup() {
  const week = Number($("lineup-week").value),
    own = rosterFor(me.teamId),
    existing = new Map(
      state.lineups
        .filter((l) => l.team_id === me.teamId && l.week === week)
        .map((l) => [l.slot_id, l.player_id]),
    );
  $("lineup-slots").replaceChildren();
  for (const slot of state.league.rules.lineupSlots) {
    const label = node("label", `${slot.id} · ${slot.positions.join("/")}`),
      select = node("select");
    select.id = "slot-" + slot.id;
    select.dataset.slot = slot.id;
    label.htmlFor = select.id;
    options(
      select,
      own
        .filter((id) =>
          player(id)?.positions.some((p) => slot.positions.includes(p)),
        )
        .map((id) => [id, playerText(id)]),
      "Leave empty",
    );
    select.value = existing.get(slot.id) || "";
    $("lineup-slots").append(label, select);
  }
  $("roster-status").textContent =
    `${own.length}/${state.league.rules.rosterSize} rostered`;
  $("roster").replaceChildren(...own.map((id) => node("li", playerText(id))));
}
function renderTradePlayers() {
  options(
    $("trade-receive"),
    rosterFor($("trade-team").value).map((id) => [id, playerText(id)]),
    "Their player",
  );
}
function renderTrades() {
  options(
    $("trade-team"),
    state.teams.filter((t) => t.id !== me.teamId).map((t) => [t.id, t.name]),
    "Other franchise",
  );
  options(
    $("trade-give"),
    rosterFor(me.teamId).map((id) => [id, playerText(id)]),
    "My player",
  );
  renderTradePlayers();
  $("offers").replaceChildren();
  const offers = state.trades.filter((t) => t.status === "proposed");
  for (const offer of offers) {
    const article = node("article", undefined, "message");
    article.append(
      node(
        "strong",
        `${teamText(offer.from_team)} → ${teamText(offer.to_team)}`,
      ),
      node(
        "p",
        `${offer.give_players.map(playerText).join(", ")} for ${offer.receive_players.map(playerText).join(", ")}`,
      ),
      node("div", "Expires " + stamp(offer.expires_at), "hint"),
    );
    const expired = Date.parse(offer.expires_at) <= Date.now();
    if (offer.to_team === me.teamId) {
      for (const [type, label] of [
        ["acceptTrade", "Accept offer"],
        ["rejectTrade", "Reject offer"],
      ]) {
        const b = node(
          "button",
          label,
          type === "rejectTrade" ? "secondary" : undefined,
        );
        b.type = "button";
        b.disabled = expired && type === "acceptTrade";
        b.onclick = () =>
          mutate(label, "/v1/commands", { type, tradeId: offer.id });
        article.append(b);
      }
    } else if (offer.from_team === me.teamId) {
      const b = node("button", "Cancel offer", "secondary");
      b.type = "button";
      b.onclick = () =>
        mutate("Cancel trade", "/v1/commands", {
          type: "cancelTrade",
          tradeId: offer.id,
        });
      article.append(b);
    }
    $("offers").append(article);
  }
  if (!offers.length)
    $("offers").append(
      node("p", "No open offers visible to this franchise.", "empty"),
    );
}
function renderScores() {
  $("score-week").textContent = "Week " + state.league.current_week;
  $("score-summary").replaceChildren();
  $("score-matchups").replaceChildren();
  if (!scores) {
    $("score-note").textContent =
      "Scores unavailable: " + (scoreError || "No verified scoring response.");
    return;
  }
  const teams = scores.teams || [],
    own = teams.find((t) => t.teamId === me.teamId);
  const points = (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? (value / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })
      : "Unknown";
  const modes = [...new Set(teams.map((t) => t.synthetic))];
  $("score-note").textContent =
    `${modes.includes("synthetic") ? "SYNTHETIC TEST DATA · " : ""}${modes.includes("mixed") ? "MIXED DATA · " : ""}Scoring ${scores.rulesVersion} · Read ${stamp(scores.computedAt)}. Unknown or stale scores are not final results.`;
  if (own) {
    const total = node("span");
    total.append(
      node("strong", points(own.milliPoints)),
      document.createTextNode(" " + own.name + " · " + own.status),
    );
    $("score-summary").append(total);
    if (own.milliPoints === null)
      $("score-summary").append(
        node(
          "span",
          own.starters.some((p) => typeof p.milliPoints === "number")
            ? `Known subtotal: ${points(own.knownSubtotalMilliPoints)} · incomplete`
            : "No starter scores available yet.",
        ),
      );
    const uncertain = own.starters.filter(
      (p) => !["final", "provisional"].includes(p.status),
    );
    if (uncertain.length)
      $("score-summary").append(
        node(
          "span",
          uncertain.map((p) => `${p.slotId}: ${p.status}`).join(" · "),
        ),
      );
  }
  for (const matchup of scores.matchups || []) {
    const home = teams.find((t) => t.teamId === matchup.homeTeamId),
      away = teams.find((t) => t.teamId === matchup.awayTeamId);
    const item = node("li");
    item.append(
      node(
        "strong",
        `${home?.name || matchup.homeTeamId} ${points(matchup.homeMilliPoints)} — ${points(matchup.awayMilliPoints)} ${away?.name || matchup.awayTeamId}`,
      ),
      node(
        "div",
        `${matchup.status} · ${home?.status || "unknown"} / ${away?.status || "unknown"}`,
      ),
    );
    $("score-matchups").append(item);
  }
}
function clearReply() {
  replyTo = null;
  $("message-title").textContent = "New message";
  $("reply-context").hidden = true;
  $("cancel-reply").hidden = true;
  $("recipient").disabled = false;
  renderRecipients();
}
function renderRecipients() {
  const bindings = Array.isArray(me.peerBindings) ? me.peerBindings : [];
  options(
    $("recipient"),
    bindings
      .filter((b) => b.agentId !== me.agentId)
      .map((b) => [b.agentId, teamText(b.teamId)]),
    "Choose an owner",
  );
  if (replyTo) {
    if (
      !Array.from($("recipient").options).some(
        (o) => o.value === replyTo.sender_id,
      )
    ) {
      const o = node("option", replyTo.sender_id);
      o.value = replyTo.sender_id;
      $("recipient").append(o);
    }
    $("recipient").value = replyTo.sender_id;
    $("recipient").disabled = true;
  }
}
function renderInbox() {
  $("messages").replaceChildren();
  $("inbox-status").textContent = inbox
    ? `${inbox.messages.length} messages`
    : "Runtime not connected";
  $("inbox-note").textContent = me.agentId
    ? `Franchise identity: ${me.agentId}. Only conversations involving this franchise are shown.`
    : "No runtime identity is bound to this franchise yet. Draft, lineup and trade controls remain available.";
  $("message-submit").disabled = !me.agentId;
  renderRecipients();
  if (!inbox || !inbox.messages.length)
    $("messages").append(node("p", "No private messages recorded.", "empty"));
  for (const message of inbox?.messages || []) {
    const article = node("article", undefined, "message"),
      byline = node("div", undefined, "byline");
    byline.append(
      node("span", `${message.sender_id} → ${message.recipient_id}`),
      node("time", stamp(message.created_at)),
    );
    article.append(
      byline,
      node("p", message.body),
      node(
        "div",
        `${message.delivered_at ? "Delivered " + stamp(message.delivered_at) : "Delivery pending"} · ${message.responded_at ? "Response recorded" : "No response recorded"}`,
        "receipt",
      ),
    );
    if (message.recipient_id === me.agentId) {
      const b = node("button", "Reply", "secondary");
      b.type = "button";
      b.onclick = () => {
        replyTo = message;
        $("message-title").textContent = "Reply to owner";
        $("reply-context").textContent =
          `Replying to message ${message.id}. Conversation will be preserved.`;
        $("reply-context").hidden = false;
        $("cancel-reply").hidden = false;
        renderRecipients();
        $("message-body").focus();
      };
      article.append(b);
    }
    $("messages").append(article);
  }
}
function render() {
  const own = state.teams.find((t) => t.id === me.teamId);
  $("team-name").textContent = own?.name || me.teamId;
  $("owner-label").textContent =
    `${own?.kind === "human" ? "HUMAN OWNER" : own?.kind === "ai" ? "AI FRANCHISE OWNER" : "FRANCHISE OWNER"} · ${state.league.name}`;
  const count = state.teams.length,
    pick = state.league.next_pick,
    round = Math.floor(pick / count),
    position =
      state.league.rules.draftOrder === "snake" && round % 2
        ? count - 1 - (pick % count)
        : pick % count,
    onClock = state.teams.find((t) => t.draft_position === position);
  $("draft-status").textContent = state.league.status;
  $("on-clock").textContent =
    state.league.status === "drafting"
      ? `Pick ${pick + 1}: ${onClock?.name || "Unknown franchise"} · deadline ${stamp(state.league.pick_deadline)}`
      : state.league.status === "setup"
        ? "Draft has not started. Build your private queue."
        : "Draft complete. Manage your lineup and negotiate trades.";
  $("draft-submit").disabled =
    state.league.status !== "drafting" || onClock?.id !== me.teamId;
  $("queue-save").disabled = state.league.status === "active";
  $("queue-add").disabled = state.league.status === "active";
  if (!queueDirty)
    queue = [
      ...(state.draftQueues.find((q) => q.team_id === me.teamId)?.player_ids ||
        []),
    ];
  renderAvailable();
  renderQueue();
  renderLineup();
  renderTrades();
  renderInbox();
  renderScores();
  $("picks").replaceChildren(
    ...state.picks
      .slice(-8)
      .reverse()
      .map((p) =>
        node(
          "li",
          `#${p.pick_index + 1} · ${teamText(p.team_id)} · ${playerText(p.player_id)}${p.automatic ? " · automatic queue pick" : ""}`,
        ),
      ),
  );
  $("updated").textContent = "Read " + new Date().toLocaleTimeString();
  pendingDisplay();
}
async function refresh() {
  if (!me) return;
  state = await request("/v1/leagues/" + encodeURIComponent(me.leagueId));
  scores = null;
  scoreError = "";
  try {
    scores = await request(
      "/v1/leagues/" +
        encodeURIComponent(me.leagueId) +
        "/scores/" +
        state.league.current_week,
    );
  } catch (e) {
    scoreError = e.message;
  }
  inbox = null;
  if (me.agentId) {
    try {
      inbox = await request("/v1/agents/" + encodeURIComponent(me.agentId));
    } catch (e) {
      error("League loaded; inbox unavailable: " + e.message);
    }
  }
  render();
}
async function login() {
  try {
    me = await request("/v1/me");
    if (me.role !== "owner" || !me.teamId)
      throw new Error(
        "Use a franchise owner credential, not a commissioner credential.",
      );
    try {
      pending = JSON.parse(sessionStorage.getItem(pendingKey()) || "null");
    } catch {
      pending = null;
    }
    await refresh();
    $("lineup-week").value = state.league.current_week;
    renderLineup();
    $("login").hidden = true;
    $("workbench").hidden = false;
    sessionStorage.setItem("football-owner-token", token);
    $("credential").value = "";
  } catch (e) {
    me = null;
    error(e.message);
  }
}
$("login-form").onsubmit = (event) => {
  event.preventDefault();
  error();
  token = $("credential").value.trim();
  void login();
};
$("refresh").onclick = () => {
  error();
  void refresh().catch((e) => error(e.message));
};
$("logout").onclick = () => {
  sessionStorage.removeItem("football-owner-token");
  token = "";
  me = null;
  state = null;
  inbox = null;
  scores = null;
  scoreError = "";
  queue = [];
  queueDirty = false;
  replyTo = null;
  pending = null;
  $("receipt-list").replaceChildren();
  $("workbench").hidden = true;
  $("login").hidden = false;
  error();
};
$("retry").onclick = () => void mutate(null, null, null, true);
$("player-search").oninput = () => state && renderAvailable();
$("draft-form").onsubmit = (e) => {
  e.preventDefault();
  if ($("draft-player").value)
    void mutate("Draft pick", "/v1/commands", {
      type: "draftPick",
      playerId: $("draft-player").value,
      expectedPick: state.league.next_pick,
    });
};
$("queue-add").onclick = () => {
  const id = $("draft-player").value;
  if (id && !queue.includes(id)) {
    queue.push(id);
    queueDirty = true;
    renderQueue();
  }
};
$("queue-save").onclick = () =>
  void mutate("Save private queue", "/v1/commands", {
    type: "setDraftQueue",
    playerIds: queue,
  });
$("lineup-week").onchange = () => state && renderLineup();
$("lineup-form").onsubmit = (e) => {
  e.preventDefault();
  const slots = Object.fromEntries(
    Array.from($("lineup-slots").querySelectorAll("select"))
      .filter((s) => s.value)
      .map((s) => [s.dataset.slot, s.value]),
  );
  void mutate("Save lineup", "/v1/commands", {
    type: "setLineup",
    week: Number($("lineup-week").value),
    slots,
  });
};
$("trade-team").onchange = renderTradePlayers;
$("trade-form").onsubmit = (e) => {
  e.preventDefault();
  void mutate("Propose trade", "/v1/commands", {
    type: "proposeTrade",
    tradeId: crypto.randomUUID(),
    toTeamId: $("trade-team").value,
    givePlayers: [$("trade-give").value],
    receivePlayers: [$("trade-receive").value],
    expiresAt: new Date(
      Date.now() + Number($("trade-expiry").value) * 3600000,
    ).toISOString(),
  });
};
$("message-form").onsubmit = (e) => {
  e.preventDefault();
  if (!me.agentId) {
    error("No runtime identity is bound.");
    return;
  }
  const payload = {
    recipientId: replyTo?.sender_id || $("recipient").value,
    body: $("message-body").value,
    ...(replyTo
      ? { conversationId: replyTo.conversation_id, replyTo: replyTo.id }
      : {}),
  };
  void mutate(
    "Send owner message",
    "/v1/agents/" + encodeURIComponent(me.agentId) + "/messages",
    payload,
  );
};
$("cancel-reply").onclick = clearReply;
if (token) void login();
