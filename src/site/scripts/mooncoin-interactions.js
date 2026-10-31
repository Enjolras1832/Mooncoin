(() => {
  "use strict";

  const root = document.querySelector(".mc-interactions");
  if (!root) return;

  const path = window.location.pathname;
  const kudosButton = root.querySelector("[data-mc-kudos]");
  const kudosCount = root.querySelector("[data-mc-kudos-count]");
  const kudosLabel = root.querySelector("[data-mc-kudos-label]");
  const commentList = root.querySelector("[data-mc-comment-list]");
  const form = root.querySelector("[data-mc-comment-form]");
  const formMessage = root.querySelector("[data-mc-form-message]");
  const turnstileHost = root.querySelector("[data-mc-turnstile]");
  const visitorKey = "mooncoin:visitor:v1";

  let visitorId;
  try {
    visitorId = localStorage.getItem(visitorKey);
    if (!visitorId) {
      visitorId = crypto.randomUUID();
      localStorage.setItem(visitorKey, visitorId);
    }
  } catch {
    visitorId = crypto.randomUUID();
  }

  let turnstileToken = "";
  let turnstileWidgetId = null;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  function setMessage(message, isError = false) {
    formMessage.textContent = message;
    formMessage.classList.toggle("is-error", isError);
  }

  function renderComments(comments) {
    commentList.replaceChildren();
    if (!comments.length) {
      const empty = document.createElement("p");
      empty.className = "mc-muted";
      empty.textContent = "No comments yet. You can be the first to leave one.";
      commentList.append(empty);
      return;
    }

    for (const comment of comments) {
      const article = document.createElement("article");
      article.className = "mc-comment";

      const header = document.createElement("div");
      header.className = "mc-comment-header";
      const author = document.createElement("strong");
      author.textContent = comment.nickname;
      const date = document.createElement("time");
      date.dateTime = comment.created_at;
      date.textContent = new Date(comment.created_at).toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric",
      });
      header.append(author, date);

      const body = document.createElement("p");
      body.className = "mc-comment-body";
      body.textContent = comment.body;
      article.append(header, body);

      for (const reply of comment.replies || []) {
        const replyBox = document.createElement("div");
        replyBox.className = "mc-author-reply";
        const replyHeader = document.createElement("div");
        replyHeader.className = "mc-comment-header";
        const replyAuthor = document.createElement("strong");
        replyAuthor.textContent = "Mooncoin · Author";
        const replyDate = document.createElement("time");
        replyDate.dateTime = reply.created_at;
        replyDate.textContent = new Date(reply.created_at).toLocaleDateString(undefined, {
          year: "numeric", month: "short", day: "numeric",
        });
        const replyBody = document.createElement("p");
        replyBody.className = "mc-comment-body";
        replyBody.textContent = reply.body;
        replyHeader.append(replyAuthor, replyDate);
        replyBox.append(replyHeader, replyBody);
        article.append(replyBox);
      }
      commentList.append(article);
    }
  }

  async function loadKudos() {
    const data = await api(`/api/kudos?path=${encodeURIComponent(path)}&visitor_id=${encodeURIComponent(visitorId)}`);
    kudosCount.textContent = `${data.count} ${data.count === 1 ? "kudos" : "kudos"}`;
    kudosButton.setAttribute("aria-pressed", String(data.liked));
    kudosLabel.textContent = data.liked ? "You left a kudos" : "Leave a kudos";
    kudosButton.disabled = data.liked;
  }

  async function loadComments() {
    const data = await api(`/api/comments?path=${encodeURIComponent(path)}`);
    renderComments(data.comments || []);
  }

  kudosButton.addEventListener("click", async () => {
    kudosButton.disabled = true;
    try {
      await api("/api/kudos", {
        method: "POST",
        body: JSON.stringify({ path, visitor_id: visitorId }),
      });
      await loadKudos();
    } catch (error) {
      kudosButton.disabled = false;
      kudosLabel.textContent = error.message;
    }
  });

  async function loadTurnstile() {
    const config = await api("/api/config");
    if (!config.commentsEnabled || !config.turnstileSiteKey) {
      form.querySelector("button[type=submit]").disabled = true;
      setMessage("Comments are temporarily unavailable. Please check back later.", true);
      return;
    }
    if (!window.turnstile) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.onload = resolve;
        script.onerror = reject;
        document.head.append(script);
      });
    }
    turnstileWidgetId = window.turnstile.render(turnstileHost, {
      sitekey: config.turnstileSiteKey,
      callback: (token) => { turnstileToken = token; },
      "expired-callback": () => { turnstileToken = ""; },
      "error-callback": () => { turnstileToken = ""; },
      theme: document.body.classList.contains("theme-dark") ? "dark" : "light",
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    const data = new FormData(form);
    const nickname = String(data.get("nickname") || "").trim();
    const body = String(data.get("body") || "").trim();
    if (!turnstileToken) {
      setMessage("Please complete the verification challenge first.", true);
      return;
    }
    submit.disabled = true;
    setMessage("Submitting…");
    try {
      await api("/api/comments", {
        method: "POST",
        body: JSON.stringify({ path, nickname, body, turnstileToken }),
      });
      form.reset();
      turnstileToken = "";
      setMessage("Thank you. Your comment has been submitted for moderation.");
      if (window.turnstile && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId);
      }
    } catch (error) {
      setMessage(error.message, true);
      if (window.turnstile && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId);
      }
      turnstileToken = "";
    } finally {
      submit.disabled = false;
    }
  });

  Promise.all([loadKudos(), loadComments(), loadTurnstile()]).catch((error) => {
    console.error("Mooncoin interactions:", error);
    if (!commentList.children.length) {
      commentList.textContent = "Comments could not be loaded right now.";
    }
  });
})();
