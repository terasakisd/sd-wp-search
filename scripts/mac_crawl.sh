#!/bin/bash
# Mac から該当サイトだけクロールして Supabase に書き込むラッパー
# launchd から呼ばれる

set -uo pipefail

PROJECT_DIR="/Users/macsazandaia/Downloads/wp-search"
cd "$PROJECT_DIR"

mkdir -p logs
LOG="logs/mac_crawl.log"

# GitHub から最新の sites.yaml 等を取得 (他の人が編集していたら反映)
# 失敗しても続行 (オフライン時など)
git pull --rebase --quiet 2>>"$LOG" || echo "  (git pull skipped or failed)" >>"$LOG"

# .env から SUPABASE_URL / SUPABASE_SERVICE_KEY 等を読み込む
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

# 海外IP拒否されている3サイトだけクロール
export CRAWL_ONLY_SITE_IDS="${CRAWL_ONLY_SITE_IDS:-とうかい,愛代協,末松会計}"
export USE_SUPABASE=1

{
    echo "============================="
    echo "$(date '+%Y-%m-%d %H:%M:%S %Z') START"
    echo "Targets: $CRAWL_ONLY_SITE_IDS"
    /usr/bin/python3 -m app.crawler
    echo "$(date '+%Y-%m-%d %H:%M:%S %Z') END"
} >> "$LOG" 2>&1
