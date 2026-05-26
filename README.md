# 【SD】WP記事検索

複数の WordPress サイトを横断検索する社内向けツール。

公開URL: <https://terasakisd.github.io/sd-wp-search/>

---

## 構成

```
[ユーザー] ─ ブラウザ
            │
            ↓
[GitHub Pages] HTML+JS+CSS    ← UI 配信
            │
            ↓ fetch
[Supabase] PostgreSQL + 全文検索 (RPC)
            ↑
[GitHub Actions] 4回/日 クロール (130サイト)
[Mac launchd]    4回/日 クロール (3サイトのみ・海外IP拒否対策)
```

| コンポーネント | 役割 |
|---|---|
| `docs/` | GitHub Pages 用の静的サイト (HTML / JS / CSS) |
| `supabase_schema.sql` | Supabase に流すスキーマ + 検索RPC |
| `app/crawler.py` | クローラ本体 (REST API + HTML スクレイピング両対応) |
| `app/db_supabase.py` | Supabase 書き込み層 |
| `.github/workflows/crawl.yml` | 定期クロール (cron) |
| `scripts/mac_crawl.sh` `scripts/com.wpsearch.crawl.plist` | Mac launchd 用 |
| `sites.yaml` | クロール対象サイト一覧 (これだけ編集すればOK) |

---

## サイトの追加

### 1. 編集者として参加してもらう

リポジトリ管理者が **Settings → Collaborators** から招待 (Write 権限)。
招待された人は GitHub の Web UI で [`sites.yaml`](sites.yaml) を編集 → Commit で次回クロール (最大6時間後) に反映。

### 2. `sites.yaml` への追記の仕方

既存の最後のサイトの下にインデント揃えで追加するだけ。

**通常パターン**
```yaml
  - name: 新規サイト名
    url: https://example.com
    group: corporate     # corporate / backlink
```

**カスタム投稿タイプ + カテゴリ絞り込み**
```yaml
  - name: okage (生活の知恵)
    url: https://okagekk.com
    group: corporate
    post_type: column
    extra_params:
      column_cate: 47
```
→ `https://okagekk.com/wp-json/wp/v2/column?column_cate=47&...` を叩く。

**HTML スクレイピング (REST 非公開サイト)**
```yaml
  - name: イーキャンパス
    url: https://www.ecampus.jp
    group: corporate
    scrape:
      archive_url: https://www.ecampus.jp/reading-category/borrowing/
      link_re: "^https://www\\.ecampus\\.jp/reading-(?!category)[a-z0-9-]+/?$"
```

### 各項目の意味

| 項目 | 必須 | 説明 |
|---|---|---|
| `name` | ✓ | UI表示名 (内部 id にも使われる) |
| `url` | ✓ | サイトのトップ URL (末尾スラッシュなし) |
| `group` | ✓ | `corporate` (企業サイト) または `backlink` (被リンクサイト) |
| `post_type` | 任意 | カスタム投稿タイプ。例: `column` (省略時 `posts`) |
| `extra_params` | 任意 | REST API への追加クエリ。例: `{ column_cate: 47 }` |
| `scrape` | 任意 | REST 非公開サイト用、HTML スクレイピング設定 |

---

## 検索の仕様

### 検索対象

| 対象 | 重み | 備考 |
|---|---|---|
| 記事タイトル | A (最大) | |
| 記事抜粋 | B | |
| 記事本文 | C | HTMLタグ除去済 |
| サイト共通エリア | C | サイドバー・フッター等のウィジット領域 |

検索しない: カテゴリ名 / タグ名 / 著者名 / URL / 公開日 (これらは表示用)。

### 日本語の扱い

日本語は1文字ずつ空白で分けて PostgreSQL `tsvector` (`simple` config) に保存。
「東京駅」を検索すると本文の「東京駅周辺」もヒット。フレーズ検索 `"東京駅"` (ダブルクォート) で連続文字を指定可。

---

## ファイル構成

```
wp-search/
├── README.md
├── sites.yaml                       # 編集するのはここがメイン
├── supabase_schema.sql
├── requirements.txt
├── .github/workflows/crawl.yml      # 定期クロール定義
├── docs/                            # GitHub Pages
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── config.js                    # Supabase 接続情報
├── app/
│   ├── crawler.py
│   └── db_supabase.py
├── scripts/
│   ├── mac_crawl.sh
│   ├── com.wpsearch.crawl.plist
│   └── install_mac_crawl.sh
└── logs/
    └── crawl_history.log
```
