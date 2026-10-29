// LINEログインの判定ロジック（Supabase・LINEへの接続は index.ts 側から渡す）
// ここには外部への通信を書かない。疑似データでテストできるようにするため。

export const MARKER_CREATED_BY = "line-login";

export type LineIdentity = { sub: string; name?: string; picture?: string };
export type MemberRow = { id: string; role: string };
export type AuthUser = { id: string; email?: string | null; app_metadata?: Record<string, unknown> | null };

export type Deps = {
  // LINEの検証APIでIDトークンを確認し、本人情報を返す（失敗時は null）
  verifyLine: (idToken: string, channelId: string) => Promise<LineIdentity | null>;
  // 会員表をLINEユーザーIDで検索
  findMember: (lineSub: string) => Promise<MemberRow | null>;
  // 目印付きでログイン用アカウントを作成（既にあれば "exists"）
  createUser: (email: string, lineSub: string) => Promise<"created" | "exists" | "error">;
  // ワンタイムの確認コードを発行し、対象アカウントを返す（ログイン状態はまだ発行しない）
  generateLink: (email: string) => Promise<{ user: AuthUser; tokenHash: string } | null>;
  // 確認コードを使ってログイン状態を発行
  verifyOtp: (tokenHash: string) => Promise<{ userId: string; accessToken: string; refreshToken: string } | null>;
  // 発行したログイン状態を失効（テスト時に使用）
  signOut: (accessToken: string) => Promise<void>;
  // 会員表の作成・更新（役割などは変えない）
  upsertMember: (row: Record<string, string>) => Promise<boolean>;
  log: (event: string, detail: Record<string, unknown>) => void;
};

export type Options = {
  allowedChannelIds: string[];
  // true の場合：管理者アカウントだけを受け付け、ログイン状態は発行後すぐ失効させ、会員表も更新しない
  testAdminOnly: boolean;
};

export type Result = { status: number; body: Record<string, unknown> };

export function expectedEmail(lineSub: string): string {
  return `line-${lineSub.toLowerCase()}@users.triton-skillup.example`;
}

export function readAud(idToken: string): string | null {
  try {
    const part = idToken.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    return typeof payload.aud === "string" ? payload.aud : null;
  } catch {
    return null;
  }
}

// アカウントが「LINEログイン処理で作られた、この本人のもの」かを判定する
export function checkAccount(lineSub: string, member: MemberRow | null, user: AuthUser):
  { ok: true } | { ok: false; reason: string } {
  if (!user || !user.id) return { ok: false, reason: "no_user" };
  if (user.email !== expectedEmail(lineSub)) return { ok: false, reason: "email_mismatch" };
  const meta = user.app_metadata ?? {};
  if (meta.line_sub !== lineSub) return { ok: false, reason: "marker_mismatch" };
  if (meta.created_by !== MARKER_CREATED_BY) return { ok: false, reason: "marker_mismatch" };
  if (member && member.id !== user.id) return { ok: false, reason: "member_mismatch" };
  return { ok: true };
}

export async function handleLogin(idToken: string, deps: Deps, opt: Options): Promise<Result> {
  // 1. 受け付けるチャネルか（IDトークンの発行先）
  const aud = idToken ? readAud(idToken) : null;
  if (!aud || !opt.allowedChannelIds.includes(aud)) return { status: 401, body: { error: "invalid_token" } };

  // 2. LINEの公式検証APIで本人確認（端末側の申告は信用しない）
  const line = await deps.verifyLine(idToken, aud);
  if (!line || !line.sub) return { status: 401, body: { error: "invalid_token" } };

  // 3. 会員表を確認
  const member = await deps.findMember(line.sub);
  if (opt.testAdminOnly && (!member || member.role !== "admin")) {
    deps.log("rejected", { reason: "test_admin_only" });
    return { status: 403, body: { error: "test_admin_only" } };
  }

  // 4. 会員でなければ、目印付きのアカウントを作成
  const email = expectedEmail(line.sub);
  if (!member) {
    const r = await deps.createUser(email, line.sub);
    if (r === "error") return { status: 500, body: { error: "server_error" } };
  }

  // 5. 確認コードを発行し、ログイン状態を発行する「前」にアカウントを照合
  const link = await deps.generateLink(email);
  if (!link) return { status: 500, body: { error: "server_error" } };
  const check = checkAccount(line.sub, member, link.user);
  if (!check.ok) {
    deps.log("rejected", { reason: check.reason, user_id: link.user?.id ?? null });
    return { status: 403, body: { error: "account_not_allowed" } };
  }

  // 6. ログイン状態を発行し、照合したアカウントと同じか確認
  const sess = await deps.verifyOtp(link.tokenHash);
  if (!sess) return { status: 500, body: { error: "server_error" } };
  if (sess.userId !== link.user.id) {
    await deps.signOut(sess.accessToken);
    deps.log("rejected", { reason: "session_user_mismatch" });
    return { status: 500, body: { error: "server_error" } };
  }

  // テスト時：ログイン状態はすぐ失効させ、会員表は更新せず、判定結果だけ返す
  if (opt.testAdminOnly) {
    await deps.signOut(sess.accessToken);
    deps.log("test_ok", { user_id: sess.userId });
    return {
      status: 200,
      body: { ok: true, test: true, channel: aud, member_found: !!member, account_check: "passed", session_revoked: true },
    };
  }

  // 7. 会員表を作成・更新（役割などはここでは変えない）
  const row: Record<string, string> = { id: link.user.id, line_user_id: line.sub };
  if (line.name) row.line_name = line.name;
  if (line.picture) row.line_picture_url = line.picture;
  if (!(await deps.upsertMember(row))) return { status: 500, body: { error: "server_error" } };

  return { status: 200, body: { access_token: sess.accessToken, refresh_token: sess.refreshToken } };
}
