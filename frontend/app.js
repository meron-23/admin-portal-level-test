let invites = [];
let config = {
  publicBaseUrl: "",
  testAppUrl: "",
  deliveryProvider: "email",
  emailDryRun: true,
  emailReady: false,
  smsDryRun: true,
  smsReady: false,
};

const form = document.querySelector("#inviteForm");
const rows = document.querySelector("#recipientRows");
const searchInput = document.querySelector("#searchInput");
const statusFilter = document.querySelector("#statusFilter");
const sendAllButton = document.querySelector("#sendAllButton");
const syncButton = document.querySelector("#syncButton");
const logoutButton = document.querySelector("#logoutButton");
const modeBadge = document.querySelector("#modeBadge");
const toast = document.querySelector("#toast");
const navLinks = document.querySelectorAll("nav a");
const dashboardView = document.querySelector("#dashboard-view");
const recipientsView = document.querySelector("#recipients-view");

function handleRouting() {
  const hash = window.location.hash || "#dashboard";
  
  navLinks.forEach(link => {
    if (link.getAttribute("href") === hash) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });

  if (hash === "#recipients") {
    dashboardView.classList.add("hidden");
    recipientsView.classList.remove("hidden");
  } else {
    dashboardView.classList.remove("hidden");
    recipientsView.classList.add("hidden");
  }
}

window.addEventListener("hashchange", handleRouting);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector("button");
  submitButton.disabled = true;

  try {
    const formData = new FormData(form);
    await request("/api/invites", {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"),
        phone: formData.get("phone"),
        email: formData.get("email"),
      }),
    });
    form.reset();
    await loadInvites();
    showToast("Invite created");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

searchInput.addEventListener("input", renderRows);
statusFilter.addEventListener("change", renderRows);

sendAllButton.addEventListener("click", async () => {
  await runAction(sendAllButton, async () => {
    invites = await request("/api/invites/send-pending", { method: "POST" });
    render();
    showToast(sendMessage("pending"));
  });
});

syncButton.addEventListener("click", async () => {
  await runAction(syncButton, async () => {
    invites = await request("/api/invites/sync-completions", { method: "POST" });
    render();
    showToast("Completion sync finished");
  });
});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

rows.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const { action, id } = button.dataset;
  const invite = invites.find((item) => item.id === id);
  if (!invite) return;

  if (action === "copy") {
    await copyLink(invite);
    return;
  }

  const actionPath = {
    send: "send",
    remind: "remind",
    complete: "complete",
    cancel: "cancel",
  }[action];

  if (!actionPath) return;

  await runAction(button, async () => {
    const updated = await request(`/api/invites/${id}/${actionPath}`, { method: "POST" });
    invites = invites.map((item) => (item.id === id ? updated : item));
    render();
    showToast(activityMessage(action));
  });
});

init();
handleRouting();

async function init() {
  try {
    config = await request("/api/config");
    updateModeBadge();
    await loadInvites();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadInvites() {
  invites = await request("/api/invites");
  render();
}

function render() {
  renderMetrics();
  renderRows();
}

function renderMetrics() {
  setText("metricTotal", invites.length);
  setText("metricSent", invites.filter((invite) => invite.sentAt).length);
  setText("metricOpened", invites.filter((invite) => invite.openedAt).length);
  setText("metricCompleted", invites.filter((invite) => invite.completedAt).length);
  setText("metricReminder", invites.filter(needsReminder).length);
}

function renderRows() {
  const query = searchInput.value.trim().toLowerCase();
  const filter = statusFilter.value;
  const filtered = invites.filter((invite) => {
    const matchesQuery = [invite.name, invite.phone, invite.email].join(" ").toLowerCase().includes(query);
    const visibleStatus = needsReminder(invite) ? "needs-reminder" : invite.status;
    const matchesFilter = filter === "all" || visibleStatus === filter;
    return matchesQuery && matchesFilter;
  });

  rows.innerHTML = "";

  if (filtered.length === 0) {
    const template = document.querySelector("#emptyStateTemplate");
    rows.append(template.content.cloneNode(true));
    return;
  }

  for (const invite of filtered) {
    const tr = document.createElement("tr");
    const displayStatus = needsReminder(invite) ? "needs-reminder" : invite.status;
    tr.innerHTML = `
      <td>
        <div class="person">
          <strong>${escapeHtml(invite.name)}</strong>
          <span>${escapeHtml(invite.email || "No email")}</span>
        </div>
      </td>
      <td class="contact">${escapeHtml(invite.phone)}</td>
      <td><span class="status ${displayStatus}">${formatStatus(displayStatus)}</span></td>
      <td>
        <div class="private-link" title="${invite.inviteUrl}">${invite.inviteUrl}</div>
        <button class="link-button" type="button" data-action="copy" data-id="${invite.id}">Copy</button>
      </td>
      <td class="activity">${escapeHtml(invite.lastActivity || "No activity yet")}</td>
      <td>
        <div class="row-actions">
          ${actionButtons(invite)}
        </div>
      </td>
    `;
    rows.append(tr);
  }
}

function actionButtons(invite) {
  if (invite.status === "cancelled") return "";
  const buttons = [];

  if (invite.status === "draft" || invite.status === "send_failed") {
    buttons.push(buttonMarkup(invite, "send", "Send"));
  }

  if (invite.status !== "completed") {
    buttons.push(buttonMarkup(invite, "remind", "Remind"));
    buttons.push(buttonMarkup(invite, "complete", "Mark complete"));
    buttons.push(buttonMarkup(invite, "cancel", "Cancel"));
  }

  return buttons.join("");
}

function buttonMarkup(invite, action, label) {
  return `<button class="ghost" type="button" data-action="${action}" data-id="${invite.id}">${label}</button>`;
}

async function runAction(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function copyLink(invite) {
  const link = invite.inviteUrl;

  if (navigator.clipboard) {
    await navigator.clipboard.writeText(link);
  } else {
    const tempInput = document.createElement("input");
    tempInput.value = link;
    document.body.append(tempInput);
    tempInput.select();
    document.execCommand("copy");
    tempInput.remove();
  }

  showToast("Private link copied");
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();

  if (response.status === 401) {
    window.location.href = "/login.html";
    return payload;
  }

  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

function updateModeBadge() {
  if (config.deliveryProvider === "email") {
    if (config.emailDryRun) {
      modeBadge.textContent = "Email dry run";
      modeBadge.className = "mode dry";
      return;
    }

    modeBadge.textContent = config.emailReady ? "Email live" : "Email not configured";
    modeBadge.className = config.emailReady ? "mode live" : "mode blocked";
    return;
  }

  if (config.smsDryRun) {
    modeBadge.textContent = "SMS dry run";
    modeBadge.className = "mode dry";
    return;
  }

  modeBadge.textContent = config.smsReady ? "SMS live" : "SMS not configured";
  modeBadge.className = config.smsReady ? "mode live" : "mode blocked";
}

function needsReminder(invite) {
  if (invite.status === "completed" || invite.status === "cancelled") return false;
  if (!invite.sentAt) return false;

  const lastTouch = new Date(invite.lastReminderAt || invite.openedAt || invite.sentAt).getTime();
  const hours = (Date.now() - lastTouch) / 36e5;
  return hours >= 24;
}

function activityMessage(action) {
  return {
    send: sendMessage("invite"),
    remind: sendMessage("reminder"),
    complete: "Invite marked complete",
    cancel: "Invite cancelled",
  }[action] || "Updated";
}

function sendMessage(kind) {
  const label = config.deliveryProvider === "sms" ? "SMS" : "email";
  const dryRun = config.deliveryProvider === "sms" ? config.smsDryRun : config.emailDryRun;
  const noun = kind === "pending" ? "Pending messages" : kind === "reminder" ? "Reminder" : "Invite";
  return dryRun ? `${noun} written to ${label} dry-run outbox` : `${noun} ${label} sent`;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = isError ? "toast visible error" : "toast visible";
  window.setTimeout(() => {
    toast.className = "toast";
  }, 3000);
}

function setText(id, value) {
  document.querySelector(`#${id}`).textContent = String(value);
}

function formatStatus(status) {
  return status.replace(/_/g, " ").replace(/-/g, " ");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
