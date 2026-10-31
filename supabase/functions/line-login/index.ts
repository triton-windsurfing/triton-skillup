// LINEのIDトークンを確認して、Supabaseのログイン状態（セッション）を発行する（強化版）。
// 判定の中身は logic.ts。ここでは LINE・Supabase への接続だけを用意する。
// 呼び出し元はまだログインしていないので verify_jwt は無効にし、
// 代わりにLINEの検証APIでIDトークンを必ず確認する。
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleLogin, readSignupSwitch, type Deps, type LineIdentity, MARKER_CREATED_BY } from "./logic.ts";

// 本番配置では false（テスト配置 line-login-v2 では true：管理者だけを受け付け、ログイン状態はすぐ失効、会員表は更新しない）
const TEST_ADMIN_ONLY = false;

// IDトークンの発行元として受け付けるLINEミニアプリのチャネルID
// （2011936101：開発用、2011936103：本番用）
const ALLOWED_CHANNEL_IDS = ["2011936101", "2011936103"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
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
  let accessToken = "";
  try {
    const body = await req.json();
    idToken = String(body.idToken ?? "");
    accessToken = String(body.accessToken ?? "");
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url, keyFrom("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), opts);
  const pub = createClient(url, keyFrom("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"), opts);

  const deps: Deps = {
    async verifyLine(token, channelId) {
      const verify = await fetch("https://api.line.me/oauth2/v2.1/verify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id_token: token, client_id: channelId }),
      });
      if (!verify.ok) return null;
      const line = await verify.json() as LineIdentity;
      if (!line.sub) return null;
      // IDトークンに名前が入っていない場合は、同じチャネル・同じ本人のアクセストークンであることを確かめてからプロフィールを取得する
      if (!line.name && accessToken) {
        try {
          const v = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`);
          const vt = v.ok ? await v.json() as { client_id?: string; expires_in?: number } : {};
          if (vt.client_id === channelId && (vt.expires_in ?? 0) > 0) {
            const p = await fetch("https://api.line.me/v2/profile", { headers: { Authorization: `Bearer ${accessToken}` } });
            if (p.ok) {
              const prof = await p.json() as { userId?: string; displayName?: string; pictureUrl?: string };
              if (prof.userId === line.sub) {
                line.name = prof.displayName;
                line.picture = prof.pictureUrl;
              }
            }
          }
        } catch (e) {
          console.error("profile", (e as Error).message);
        }
      }
      return { sub: line.sub, name: line.name, picture: line.picture };
    },
    async findMember(lineSub) {
      const { data, error } = await admin.from("members").select("id, role").eq("line_user_id", lineSub).maybeSingle();
      if (error) throw new Error("members lookup failed");
      return data ?? null;
    },
    async createUser(email, lineSub) {
      const { error } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { line_sub: lineSub },
        app_metadata: { line_sub: lineSub, created_by: MARKER_CREATED_BY },
      });
      if (!error) return "created";
      if (/already/i.test(error.message)) return "exists";
      console.error("createUser", error.message);
      return "error";
    },
    async generateLink(email) {
      const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
      if (error || !data?.properties?.hashed_token || !data.user) {
        console.error("generateLink", error?.message);
        return null;
      }
      return { user: data.user, tokenHash: data.properties.hashed_token };
    },
    async verifyOtp(tokenHash) {
      const { data, error } = await pub.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
      if (error || !data.session || !data.user) {
        console.error("verifyOtp", error?.message);
        return null;
      }
      return { userId: data.user.id, accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
    },
    async signOut(token) {
      const { error } = await admin.auth.admin.signOut(token, "local");
      if (error) console.error("signOut", error.message);
    },
    async upsertMember(row) {
      const { error } = await admin.from("members").upsert(row, { onConflict: "id" });
      if (error) console.error("members upsert", error.message);
      return !error;
    },
    log(event, detail) {
      // トークンや個人情報は記録しない
      console.log(JSON.stringify({ event, ...detail }));
    },
  };

  try {
    const r = await handleLogin(idToken, deps, {
      allowedChannelIds: ALLOWED_CHANNEL_IDS,
      testAdminOnly: TEST_ADMIN_ONLY,
      allowNewSignups: readSignupSwitch(() => Deno.env.get("NEW_SIGNUPS")),
    });
    return json(r.body, r.status);
  } catch (e) {
    console.error("unexpected", (e as Error).message);
    return json({ error: "server_error" }, 500);
  }
});
