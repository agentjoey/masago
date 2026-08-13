#!/bin/sh
# CI をローカルで忠実に再現する。
#
#   pnpm ci:sim
#
# なぜ要るか：W10 の後、手元では 236 件全部緑なのに CI が落ちた。原因は
# 統合テストが `.env` の存在を前提にしていたこと。手元には `.env` があり
# CI には無い——その一点だけで結果が割れる。手元で `pnpm test` を通すのは
# CI を通した証明にならない。
#
# `.env` を隠すだけでは足りない。CI は `actions/checkout` が置いたもの、
# つまり **コミット対象のファイルだけ** を見る。ignore されたファイルに
# 依存したコードは、手元では動いて CI では落ちる。だから ls-files で
# 「コミットされる集合」を切り出して、その中で走らせる。
set -e

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# 追跡済み + 未追跡だが ignore されていない = checkout 後に存在するもの。
# `.env` は ignore されているので、ここで自然に落ちる。
git ls-files --cached --others --exclude-standard -z \
  | while IFS= read -r -d '' f; do
      mkdir -p "$WORK/$(dirname "$f")"
      cp "$f" "$WORK/$f"
    done

ln -s "$ROOT/node_modules" "$WORK/node_modules"

if [ -f "$WORK/.env" ]; then
  echo "ci-sim: .env が複製された——ignore 設定が壊れています" >&2
  exit 1
fi

cd "$WORK"

# CI の env には DB の接続情報が無い。シェルから漏れ込ませない。
# ci.yml の全ステップを同じ順で回す。テストだけ回して緑と判断したせいで
# lint 落ちを二度見逃している（1c41617）。一部だけ再現するなら意味が無い。
BIN="$ROOT/node_modules/.bin"
clean() {
  env -u DATABASE_URL -u DATABASE_URL_DIRECT -u LLM_API_KEY \
      -u MINIMAX_API_KEY -u TELEGRAM_BOT_TOKEN "$@"
}

echo "--- Lint ---"
clean "$BIN/eslint" .

echo "--- Typecheck ---"
clean "$BIN/tsc" --noEmit

echo "--- Unit tests (no database) ---"
clean "$BIN/vitest" run --exclude 'tests/db/**'

echo "--- Build ---"
clean "$BIN/tsc" -p tsconfig.build.json

echo "--- Schema drift ---"
# CI が見るのは「生成し直しても何も変わらないこと」。git と突き合わせると
# 未コミットのマイグレーションまで差分として拾ってしまい、常に落ちる。
# 生成の前後を直接比べるほうが、CI の意図に忠実。
cp -R src/db/migrations "$WORK/.migrations-before"
# clean は DATABASE_URL_DIRECT を消すので、ここでは使わない。
env -u DATABASE_URL -u LLM_API_KEY -u MINIMAX_API_KEY -u TELEGRAM_BOT_TOKEN \
    DATABASE_URL_DIRECT=postgres://ci:ci@localhost:5432/ci \
    "$BIN/drizzle-kit" generate >/dev/null
if ! diff -r "$WORK/.migrations-before" src/db/migrations >/dev/null; then
  echo "ci-sim: スキーマとマイグレーションがずれています（pnpm db:generate してコミット）" >&2
  diff -r "$WORK/.migrations-before" src/db/migrations | head -20 >&2
  exit 1
fi

echo ""
echo "ci-sim: 全ステップ通過"
