// LINEのIDトークンを確認して、Supabaseのログイン状態（セッション）を発行する。
// 呼び出し元はまだログインしていないので verify_jwt は無効にし、
// 代わりにLINEの検証APIでIDトークンを必ず確認する。
import { createClient } from "npm:@supabase/supabase-js@2";

// IDトークンの発行元として受け付けるLINEミニアプリのチャネルID
// （開発用。本番公開時に本番用のチャネルIDを追加する）
const ALLOWED_CHANNEL_IDS = ["2011936101"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function readAud(idToken: string): string | null {
  try {
    const part = idToken.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    return typeof payload.aud === "string" ? payload.aud : null;
  } catch {
    return null;
  }
}

function keyFrom(envJson: string, legacy: string): string {
  try {
    const v = JSON.parse(Deno.env.get(envJson) ?? "{}").default;
    if (v) return v;
  } catch { /* fall through */ }
  return Deno.env.get(legacy) ?? "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let idToken = "";
  try {
    idToken = String((await req.json()).idToken ?? "");
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const aud = idToken ? readAud(idToken) : null;
  if (!aud || !ALLOWED_CHANNEL_IDS.includes(aud)) return json({ error: "invalid_token" }, 401);

  // 1. LINEの検証APIでIDトークンを確認
  const verify = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: aud }),
  });
  if (!verify.ok) return json({ error: "invalid_token" }, 401);
  const line = await verify.json() as { sub?: string; name?: string; picture?: string };
  if (!line.sub) return json({ error: "invalid_token" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url, keyFrom("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), opts);
  const pub = createClient(url, keyFrom("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"), opts);

  // 2. LINEのユーザーIDに対応するログイン用アカウントを用意（メールは送信しない内部用）
  const email = `line-${line.sub.toLowerCase()}@users.triton-skillup.example`;
  const { data: existing } = await admin.from("members").select("id").eq("line_user_id", line.sub).maybeSingle();
  if (!existing) {
    const { error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { line_sub: line.sub },
    });
    if (error && !/already/i.test(error.message)) {
      console.error("createUser", error.message);
      return json({ error: "server_error" }, 500);
    }
  }

  // 3. ワンタイムのリンクを内部で発行し、その場で使ってセッションに交換
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr || !link?.properties?.hashed_token || !link.user) {
    console.error("generateLink", linkErr?.message);
    return json({ error: "server_error" }, 500);
  }
  const { data: sess, error: otpErr } = await pub.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (otpErr || !sess.session) {
    console.error("verifyOtp", otpErr?.message);
    return json({ error: "server_error" }, 500);
  }

  // 4. 会員表を作成・更新（役割などはここでは変えない）
  const { error: upErr } = await admin.from("members").upsert(
    {
      id: link.user.id,
      line_user_id: line.sub,
      line_name: line.name ?? null,
      line_picture_url: line.picture ?? null,
    },
    { onConflict: "id" },
  );
  if (upErr) {
    console.error("members upsert", upErr.message);
    return json({ error: "server_error" }, 500);
  }

  return json({
    access_token: sess.session.access_token,
    refresh_token: sess.session.refresh_token,
  });
});
