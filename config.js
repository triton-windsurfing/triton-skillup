// 公開して問題ない設定値だけを置く（パスワードやシークレットは書かない）
window.APP_CONFIG = {
  // LINEミニアプリのLIFF ID。本番用は /m/ から開かれる（エンドポイントURLで分けている）
  liffId: location.pathname.includes("/m/") ? "2011936103-kbqDqRRv" /* 本番用 */ : "2011936101-ginMHUJW" /* 開発用 */,
  supabaseUrl: "https://tuaexfmrloajgwvbrqrw.supabase.co",
  supabaseKey: "sb_publishable_qNm6CJh-NIhqo65G3q8oVA_sy86zQyM", // 公開用キー
};
