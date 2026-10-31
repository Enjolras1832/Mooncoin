(() => {
  "use strict";
  const auth = document.querySelector("#study-auth");
  const app = document.querySelector("#study-app");
  const statsEl = document.querySelector("#study-stats");
  const listEl = document.querySelector("#study-comment-list");
  const kudosEl = document.querySelector("#study-kudos-list");
  const dialog = document.querySelector("#reply-dialog");
  let currentStatus = "pending";
  let currentCommentId = null;
  let currentReplyId = null;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function action(label, className, callback) {
    const button = el("button", className, label);
    button.type = "button";
    button.addEventListener("click", callback);
    return button;
  }

  function date(value) {
    return new Date(value).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  async function loadStats() {
    const data = await api("/api/admin/stats");
    const items = [
      ["All comments", data.comments],
      ["Awaiting review", data.pending],
      ["Published", data.published],
      ["Rejected", data.rejected],
      ["Total kudos", data.kudos],
    ];
    statsEl.replaceChildren(...items.map(([label, value]) => {
      const card = el("article", "stat-card");
      card.append(el("span", "stat-label", label), el("strong", "stat-value", String(value)));
      return card;
    }));
  }

  async function loadComments() {
    listEl.replaceChildren(el("p", "quiet", "Loading correspondence…"));
    try {
      const data = await api(`/api/admin/comments?status=${currentStatus}`);
      listEl.replaceChildren();
      if (!data.comments.length) {
        listEl.append(el("p", "quiet", "There is nothing in this section."));
        return;
      }
      for (const comment of data.comments) {
        const card = el("article", "entry-card");
        const top = el("div", "entry-top");
        top.append(el("span", "status status-" + comment.status, comment.status));
        top.append(el("time", "entry-date", date(comment.created_at)));
        const meta = el("p", "entry-meta", `${comment.nickname} · ${comment.page_path}`);
        const body = el("p", "entry-body", comment.body);
        const actions = el("div", "entry-actions");
        if (comment.status !== "approved") {
          actions.append(action("Approve", "small-action primary", async () => {
            await api(`/api/admin/comments/${comment.id}`, { method: "PATCH", body: JSON.stringify({ status: "approved" }) });
            await refresh();
          }));
        }
        if (comment.status !== "rejected") {
          actions.append(action("Reject", "small-action secondary", async () => {
            await api(`/api/admin/comments/${comment.id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
            await refresh();
          }));
        }
        if (comment.status === "approved") {
          actions.append(action("Reply", "small-action primary", () => openReply(comment)));
        }
        actions.append(action("Delete", "small-action danger", async () => {
          if (!confirm("Permanently delete this comment and its replies?")) return;
          await api(`/api/admin/comments/${comment.id}`, { method: "DELETE" });
          await refresh();
        }));
        card.append(top, meta, body, actions);

        if (comment.status === "approved") {
          try {
            const detail = await api(`/api/admin/comments/${comment.id}`);
            for (const reply of detail.replies || []) {
              const replyCard = el("div", "reply-entry");
              const replyTop = el("div", "entry-top");
              replyTop.append(el("strong", "", "Mooncoin · Author"));
              replyTop.append(el("time", "entry-date", date(reply.updated_at || reply.created_at)));
              const replyBody = el("p", "entry-body", reply.body);
              const replyActions = el("div", "entry-actions");
              replyActions.append(action("Edit reply", "small-action secondary", () => openEditReply(comment, reply)));
              replyActions.append(action("Delete reply", "small-action danger", async () => {
                if (!confirm("Permanently delete this author reply?")) return;
                await api(`/api/admin/replies/${reply.id}`, { method: "DELETE" });
                await refresh();
              }));
              replyCard.append(replyTop, replyBody, replyActions);
              card.append(replyCard);
            }
          } catch (error) {
            card.append(el("p", "error", `Could not load author replies: ${error.message}`));
          }
        }
        listEl.append(card);
      }
    } catch (error) {
      listEl.replaceChildren(el("p", "error", error.message));
    }
  }

  async function loadKudos() {
    kudosEl.replaceChildren(el("p", "quiet", "Loading the ledger…"));
    const data = await api("/api/admin/kudos");
    kudosEl.replaceChildren();
    if (!data.pages.length) {
      kudosEl.append(el("p", "quiet", "No kudos have been left yet."));
      return;
    }
    const table = document.createElement("table");
    table.className = "ledger";
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["Article path", "Kudos"].forEach((value) => headerRow.append(el("th", "", value)));
    head.append(headerRow);
    const body = document.createElement("tbody");
    for (const row of data.pages) {
      const tr = document.createElement("tr");
      tr.append(el("td", "path-cell", row.page_path), el("td", "number-cell", String(row.count)));
      body.append(tr);
    }
    table.append(head, body);
    kudosEl.append(table);
  }

  function openReply(comment) {
    currentCommentId = comment.id;
    currentReplyId = null;
    document.querySelector("#reply-title").textContent = "Reply to comment";
    document.querySelector("#reply-context").textContent = `${comment.nickname}: ${comment.body}`;
    document.querySelector("#reply-body").value = "";
    document.querySelector("#reply-save").textContent = "Publish reply";
    document.querySelector("#reply-message").textContent = "";
    dialog.showModal();
  }

  function openEditReply(comment, reply) {
    currentCommentId = comment.id;
    currentReplyId = reply.id;
    document.querySelector("#reply-title").textContent = "Edit author reply";
    document.querySelector("#reply-context").textContent = `${comment.nickname}: ${comment.body}`;
    document.querySelector("#reply-body").value = reply.body;
    document.querySelector("#reply-save").textContent = "Save changes";
    document.querySelector("#reply-message").textContent = "";
    dialog.showModal();
  }

  document.querySelector("#reply-save").addEventListener("click", async () => {
    const body = document.querySelector("#reply-body").value.trim();
    const message = document.querySelector("#reply-message");
    if (!body) { message.textContent = "Please write a reply."; return; }
    try {
      if (currentReplyId) {
        await api(`/api/admin/replies/${currentReplyId}`, { method: "PATCH", body: JSON.stringify({ body }) });
      } else {
        await api(`/api/admin/comments/${currentCommentId}/replies`, { method: "POST", body: JSON.stringify({ body }) });
      }
      dialog.close();
      await refresh();
    } catch (error) { message.textContent = error.message; }
  });
  document.querySelector("#reply-cancel").addEventListener("click", () => dialog.close());

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("is-active", item === button));
      const isComments = button.dataset.tab === "comments";
      document.querySelector("#study-comments").hidden = !isComments;
      document.querySelector("#study-kudos").hidden = isComments;
      if (!isComments) await loadKudos();
    });
  });

  document.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      currentStatus = button.dataset.status;
      document.querySelectorAll("[data-status]").forEach((item) => item.classList.toggle("is-active", item === button));
      await loadComments();
    });
  });

  async function refresh() {
    await Promise.all([loadStats(), loadComments()]);
  }

  (async () => {
    try {
      const identity = await api("/api/admin/me");
      auth.hidden = true;
      app.hidden = false;
      document.querySelector("#study-identity").textContent = `Signed in as ${identity.email}`;
      await refresh();
    } catch (error) {
      auth.replaceChildren(el("h2", "", "The Study is private"));
      auth.append(el("p", "quiet", error.message));
      auth.append(el("p", "quiet", "Sign in through the Cloudflare Access policy for this site, then reload this page."));
    }
  })();
})();
