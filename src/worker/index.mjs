import { createRemoteJWKSet, jwtVerify } from "jose";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function getPath(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  const path = value.trim().split("?")[0].split("#")[0];
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (path.includes("\\") || /[\u0000-\u001f]/.test(path)) return null;
  return path.replace(/\/{2,}/g, "/");
}

async function readJson(request, maxBytes = 12000) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("Request body is too large.");
  const raw = await request.text();
  if (raw.length > maxBytes) throw new Error("Request body is too large.");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON.");
  }
}

function uuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").trim().slice(0, max);
}

async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY || !token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const result = await response.json();
    return result.success === true;
  } catch {
    return false;
  }
}

let jwksCache;
async function requireAdmin(request, env) {
  const hostname = new URL(request.url).hostname;

 if (
    env.MOONCOIN_LOCAL_ADMIN === "true" &&
    (hostname === "localhost" || hostname === "127.0.0.1")
  ) {
    return { ok: true, email: "local-development@mooncoin" };
  }
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD || !env.ADMIN_EMAIL) {
    return { ok: false, response: error("Admin authentication is not configured.", 503) };
  }
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) return { ok: false, response: error("Authentication required.", 401) };

  try {
    const team = String(env.TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/$/, "");
    const issuer = `https://${team}`;
    const jwksUrl = new URL(`${issuer}/cdn-cgi/access/certs`);
    if (!jwksCache || jwksCache._mooncoinIssuer !== issuer) {
      jwksCache = createRemoteJWKSet(jwksUrl);
      jwksCache._mooncoinIssuer = issuer;
    }
    const { payload } = await jwtVerify(assertion, jwksCache, {
      issuer,
      audience: env.POLICY_AUD,
    });
    const email = String(payload.email || "").toLowerCase();
    if (email !== String(env.ADMIN_EMAIL).toLowerCase()) {
      return { ok: false, response: error("This account is not authorized.", 403) };
    }
    return { ok: true, email };
  } catch {
    return { ok: false, response: error("Invalid or expired Access identity.", 401) };
  }
}

async function publicConfig(env) {
  return json({
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
    commentsEnabled: Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY),
  });
}

async function getKudos(url, env) {
  const pagePath = getPath(url.searchParams.get("path"));
  if (!pagePath) return error("A valid page path is required.");
  const visitorId = url.searchParams.get("visitor_id") || "";
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM kudos WHERE page_path = ?"
  ).bind(pagePath).first();
  let liked = false;
  if (uuid(visitorId)) {
    const row = await env.DB.prepare(
      "SELECT 1 AS liked FROM kudos WHERE page_path = ? AND visitor_id = ?"
    ).bind(pagePath, visitorId).first();
    liked = Boolean(row);
  }
  return json({ count: Number(result?.count || 0), liked });
}

async function postKudos(request, env) {
  const body = await readJson(request, 3000);
  const pagePath = getPath(body.path);
  if (!pagePath || !uuid(body.visitor_id)) return error("Invalid page path or visitor ID.");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO kudos (page_path, visitor_id, created_at) VALUES (?, ?, ?)"
  ).bind(pagePath, body.visitor_id, new Date().toISOString()).run();
  return getKudos(new URL(`https://local/api/kudos?path=${encodeURIComponent(pagePath)}&visitor_id=${encodeURIComponent(body.visitor_id)}`), env);
}

async function getComments(url, env) {
  const pagePath = getPath(url.searchParams.get("path"));
  if (!pagePath) return error("A valid page path is required.");
  const comments = await env.DB.prepare(
    `SELECT id, page_path, nickname, body, created_at
     FROM comments WHERE page_path = ? AND status = 'approved'
     ORDER BY created_at ASC LIMIT 200`
  ).bind(pagePath).all();
  const rows = comments.results || [];
  if (!rows.length) return json({ comments: [] });
  const placeholders = rows.map(() => "?").join(",");
  const replies = await env.DB.prepare(
    `SELECT id, comment_id, body, created_at, updated_at
     FROM comment_replies WHERE comment_id IN (${placeholders})
     ORDER BY created_at ASC`
  ).bind(...rows.map((row) => row.id)).all();
  const byComment = new Map();
  for (const reply of replies.results || []) {
    const list = byComment.get(reply.comment_id) || [];
    list.push(reply);
    byComment.set(reply.comment_id, list);
  }
  return json({
    comments: rows.map((row) => ({
      ...row,
      replies: byComment.get(row.id) || [],
    })),
  });
}

async function postComment(request, env) {
  const body = await readJson(request, 12000);
  const pagePath = getPath(body.path);
  const nickname = cleanText(body.nickname, 40);
  const content = cleanText(body.body, 5000);
  if (!pagePath || nickname.length < 1 || content.length < 1) {
    return error("Please provide a nickname and comment.");
  }
  if (!(await verifyTurnstile(body.turnstileToken, request, env))) {
    return error("Verification failed. Please try again.", 403);
  }
  const createdAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO comments (page_path, nickname, body, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`
  ).bind(pagePath, nickname, content, createdAt).run();
  return json({ submitted: true, id: result.meta?.last_row_id ?? null, status: "pending" }, 201);
}

async function adminStats(env) {
  const [comments, pending, published, rejected, kudos] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'approved'").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'rejected'").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM kudos").first(),
  ]);
  return json({
    comments: Number(comments?.n || 0),
    pending: Number(pending?.n || 0),
    published: Number(published?.n || 0),
    rejected: Number(rejected?.n || 0),
    kudos: Number(kudos?.n || 0),
  });
}

async function adminComments(url, env) {
  const status = url.searchParams.get("status") || "pending";
  const allowed = ["pending", "approved", "rejected", "all"];
  if (!allowed.includes(status)) return error("Invalid comment status.");
  const sql = status === "all"
    ? "SELECT id, page_path, nickname, body, status, created_at FROM comments ORDER BY created_at DESC LIMIT 500"
    : "SELECT id, page_path, nickname, body, status, created_at FROM comments WHERE status = ? ORDER BY created_at DESC LIMIT 500";
  const result = status === "all"
    ? await env.DB.prepare(sql).all()
    : await env.DB.prepare(sql).bind(status).all();
  return json({ comments: result.results || [] });
}

async function adminCommentDetail(id, env) {
  const comment = await env.DB.prepare(
    "SELECT id, page_path, nickname, body, status, created_at FROM comments WHERE id = ?"
  ).bind(id).first();
  if (!comment) return error("Comment not found.", 404);
  const replies = await env.DB.prepare(
    "SELECT id, comment_id, body, created_at, updated_at FROM comment_replies WHERE comment_id = ? ORDER BY created_at ASC"
  ).bind(id).all();
  return json({ comment, replies: replies.results || [] });
}

async function adminPatchComment(id, request, env) {
  const body = await readJson(request, 12000);
  const updates = [];
  const values = [];
  if (["pending", "approved", "rejected"].includes(body.status)) {
    updates.push("status = ?");
    values.push(body.status);
  }
  if (typeof body.body === "string") {
    const content = cleanText(body.body, 5000);
    if (!content) return error("Comment body cannot be empty.");
    updates.push("body = ?");
    values.push(content);
  }
  if (!updates.length) return error("No valid changes supplied.");
  values.push(id);
  const result = await env.DB.prepare(
    `UPDATE comments SET ${updates.join(", ")} WHERE id = ?`
  ).bind(...values).run();
  if (!result.meta?.changes) return error("Comment not found.", 404);
  return json({ updated: true });
}

async function adminCreateReply(id, request, env) {
  const body = await readJson(request, 8000);
  const content = cleanText(body.body, 5000);
  if (!content) return error("Reply cannot be empty.");
  const parent = await env.DB.prepare("SELECT id FROM comments WHERE id = ? AND status = 'approved'").bind(id).first();
  if (!parent) return error("Only published comments can receive public replies.", 409);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO comment_replies (comment_id, body, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).bind(id, content, now, now).run();
  return json({ id: result.meta?.last_row_id ?? null, created: true }, 201);
}

async function adminPatchReply(id, request, env) {
  const body = await readJson(request, 8000);
  const content = cleanText(body.body, 5000);
  if (!content) return error("Reply cannot be empty.");
  const result = await env.DB.prepare(
    "UPDATE comment_replies SET body = ?, updated_at = ? WHERE id = ?"
  ).bind(content, new Date().toISOString(), id).run();
  if (!result.meta?.changes) return error("Reply not found.", 404);
  return json({ updated: true });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/config" && method === "GET") return publicConfig(env);
  if (path === "/api/kudos" && method === "GET") return getKudos(url, env);
  if (path === "/api/kudos" && method === "POST") return postKudos(request, env);
  if (path === "/api/comments" && method === "GET") return getComments(url, env);
  if (path === "/api/comments" && method === "POST") return postComment(request, env);

  if (path.startsWith("/api/admin/")) {
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return auth.response;

    if (path === "/api/admin/me" && method === "GET") return json({ email: auth.email });
    if (path === "/api/admin/stats" && method === "GET") return adminStats(env);
    if (path === "/api/admin/kudos" && method === "GET") {
      const result = await env.DB.prepare(
        "SELECT page_path, COUNT(*) AS count FROM kudos GROUP BY page_path ORDER BY count DESC, page_path ASC"
      ).all();
      return json({ pages: result.results || [] });
    }
    if (path === "/api/admin/comments" && method === "GET") return adminComments(url, env);

    let match = path.match(/^\/api\/admin\/comments\/(\d+)$/);
    if (match && method === "GET") return adminCommentDetail(Number(match[1]), env);
    if (match && method === "PATCH") return adminPatchComment(Number(match[1]), request, env);
    if (match && method === "DELETE") {
      const result = await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(Number(match[1])).run();
      return result.meta?.changes ? json({ deleted: true }) : error("Comment not found.", 404);
    }

    match = path.match(/^\/api\/admin\/comments\/(\d+)\/replies$/);
    if (match && method === "POST") return adminCreateReply(Number(match[1]), request, env);

    match = path.match(/^\/api\/admin\/replies\/(\d+)$/);
    if (match && method === "PATCH") return adminPatchReply(Number(match[1]), request, env);
    if (match && method === "DELETE") {
      const result = await env.DB.prepare("DELETE FROM comment_replies WHERE id = ?").bind(Number(match[1])).run();
      return result.meta?.changes ? json({ deleted: true }) : error("Reply not found.", 404);
    }
    return error("Admin endpoint not found.", 404);
  }

  if (path === "/admin" || path === "/admin/") {
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return auth.response;
    return env.ASSETS.fetch(new Request(new URL("/admin/index.html", url), { method: "GET" }));
  }

  if (path.startsWith("/api/")) return error("API endpoint not found.", 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "strict-origin-when-cross-origin");
      if (new URL(request.url).pathname.startsWith("/api/")) {
        headers.set("cache-control", "no-store");
      }
      return new Response(response.body, { status: response.status, headers });
    } catch (err) {
      console.error("Mooncoin interaction request failed:", err);
      return error("The request could not be completed.", 500);
    }
  },
};
