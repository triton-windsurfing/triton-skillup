// 疑似データによるテスト（本番のLINE・Supabaseには一切接続しない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleLogin, expectedEmail, type Deps, type AuthUser, type MemberRow, type Options } from "./logic.ts";

const SUB = "U0123456789abcdef0123456789abcdef";
const OTHER = "Ufedcba9876543210fedcba9876543210";
const PROD = "2011936103";
const DEV = "2011936101";

function token(aud: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "ES256" })}.${b({ aud, sub: SUB })}.sig`;
}
function marked(id: string, sub = SUB, email = expectedEmail(sub)): AuthUser {
  return { id, email, app_metadata: { provider: "email", providers: ["email"], line_sub: sub, created_by: "line-login" } };
}

type World = {
  lineOk?: boolean; member?: MemberRow | null; createResult?: "created" | "exists" | "error";
  linkUser?: AuthUser | null; sessUserId?: string;
};
function mkDeps(w: World) {
  const calls: Record<string, unknown[][]> = {};
  const rec = (k: string, ...a: unknown[]) => { (calls[k] ??= []).push(a); };
  const deps: Deps = {
    async verifyLine(t, ch) { rec("verifyLine", t, ch); return w.lineOk === false ? null : { sub: SUB, name: "テスト" }; },
    async findMember(s) { rec("findMember", s); return w.member ?? null; },
    async createUser(e, s) { rec("createUser", e, s); return w.createResult ?? "created"; },
    async generateLink(e) { rec("generateLink", e); return w.linkUser === null ? null : { user: w.linkUser ?? marked("u1"), tokenHash: "h" }; },
    async verifyOtp(h) { rec("verifyOtp", h); return { userId: w.sessUserId ?? (w.linkUser?.id ?? "u1"), accessToken: "AT", refreshToken: "RT" }; },
    async signOut(t) { rec("signOut", t); },
    async upsertMember(r) { rec("upsertMember", r); return true; },
    log(e, d) { rec("log", e, d); },
  };
  return { deps, calls };
}
const PRODMODE: Options = { allowedChannelIds: [DEV, PROD], testAdminOnly: false };
const TESTMODE: Options = { allowedChannelIds: [DEV, PROD], testAdminOnly: true };
const noTokens = (b: Record<string, unknown>) => assert.ok(!("access_token" in b) && !("refresh_token" in b), "トークンを返していないこと");

test("01 既存会員（目印あり・一致）→ 受付、会員表を更新", async () => {
  const { deps, calls } = mkDeps({ member: { id: "u1", role: "member" }, linkUser: marked("u1") });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 200); assert.equal(r.body.access_token, "AT");
  assert.equal(calls.createUser, undefined); assert.equal(calls.upsertMember.length, 1);
});
test("02 新規会員 → 目印付きで作成して受付", async () => {
  const { deps, calls } = mkDeps({ member: null, createResult: "created", linkUser: marked("u2") });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 200); assert.deepEqual(calls.createUser[0], [expectedEmail(SUB), SUB]);
});
test("03 目印のないアカウント（LINE以外で先に作られた等）→ 拒否、ログイン状態を発行しない", async () => {
  const { deps, calls } = mkDeps({ member: null, createResult: "exists", linkUser: { id: "x", email: expectedEmail(SUB), app_metadata: { provider: "email" } } });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 403); assert.equal(calls.verifyOtp, undefined); assert.equal(calls.upsertMember, undefined); noTokens(r.body);
});
test("04 本人が書き換えられる領域にだけLINE IDがある（偽装）→ 拒否", async () => {
  const { deps, calls } = mkDeps({ member: null, createResult: "exists", linkUser: { id: "x", email: expectedEmail(SUB), app_metadata: {} } });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 403); assert.equal(calls.verifyOtp, undefined); noTokens(r.body);
});
test("05 別人の目印が付いたアカウント → 拒否", async () => {
  const { deps, calls } = mkDeps({ member: { id: "u1", role: "member" }, linkUser: marked("u1", OTHER, expectedEmail(SUB)) });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 403); assert.equal(calls.verifyOtp, undefined); noTokens(r.body);
});
test("06 ログイン用アドレスが一致しない → 拒否", async () => {
  const { deps, calls } = mkDeps({ member: { id: "u1", role: "member" }, linkUser: marked("u1", SUB, "someone@example.com") });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 403); assert.equal(calls.verifyOtp, undefined);
});
test("07 会員表のIDと認証アカウントが別人 → 拒否", async () => {
  const { deps, calls } = mkDeps({ member: { id: "u1", role: "member" }, linkUser: marked("u9") });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 403); assert.equal(calls.verifyOtp, undefined);
});
test("08 LINEの検証に失敗したトークン → 401、以降の処理なし", async () => {
  const { deps, calls } = mkDeps({ lineOk: false });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 401); assert.equal(calls.findMember, undefined); assert.equal(calls.generateLink, undefined);
});
test("09 許可していないチャネルのトークン → 401、LINE検証も呼ばない", async () => {
  const { deps, calls } = mkDeps({});
  const r = await handleLogin(token("9999999999"), deps, PRODMODE);
  assert.equal(r.status, 401); assert.equal(calls.verifyLine, undefined);
});
test("10 形式が壊れたトークン・空のトークン → 401", async () => {
  for (const t of ["", "abc", "a.!!!.c"]) {
    const { deps, calls } = mkDeps({});
    const r = await handleLogin(t, deps, PRODMODE);
    assert.equal(r.status, 401); assert.equal(calls.verifyLine, undefined);
  }
});
test("11 発行されたログイン状態が照合と別人 → 失効させてエラー", async () => {
  const { deps, calls } = mkDeps({ member: { id: "u1", role: "member" }, linkUser: marked("u1"), sessUserId: "u9" });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 500); assert.equal(calls.signOut.length, 1); assert.equal(calls.upsertMember, undefined); noTokens(r.body);
});
test("12 アカウント作成の失敗 → 500", async () => {
  const { deps } = mkDeps({ member: null, createResult: "error" });
  const r = await handleLogin(token(PROD), deps, PRODMODE);
  assert.equal(r.status, 500);
});
test("13 [テスト配置] 管理者 → 判定のみ成功、ログイン状態は即失効、会員表は更新しない、トークンを返さない", async () => {
  const { deps, calls } = mkDeps({ member: { id: "u1", role: "admin" }, linkUser: marked("u1") });
  const r = await handleLogin(token(DEV), deps, TESTMODE);
  assert.equal(r.status, 200); assert.equal(r.body.test, true);
  assert.equal(calls.signOut.length, 1); assert.equal(calls.upsertMember, undefined); noTokens(r.body);
});
test("14 [テスト配置] 管理者以外の会員 → 拒否（確認コードも発行しない）", async () => {
  const { deps, calls } = mkDeps({ member: { id: "u1", role: "member" } });
  const r = await handleLogin(token(DEV), deps, TESTMODE);
  assert.equal(r.status, 403); assert.equal(calls.generateLink, undefined); assert.equal(calls.createUser, undefined);
});
test("15 [テスト配置] インストラクター → 拒否", async () => {
  const { deps, calls } = mkDeps({ member: { id: "u1", role: "instructor" } });
  const r = await handleLogin(token(DEV), deps, TESTMODE);
  assert.equal(r.status, 403); assert.equal(calls.generateLink, undefined);
});
test("16 [テスト配置] 未登録のLINEユーザー → 拒否（アカウントを作らない）", async () => {
  const { deps, calls } = mkDeps({ member: null });
  const r = await handleLogin(token(DEV), deps, TESTMODE);
  assert.equal(r.status, 403); assert.equal(calls.createUser, undefined); assert.equal(calls.generateLink, undefined);
});
