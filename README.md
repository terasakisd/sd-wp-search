# WP Multi-Site Search

複数のWordPressサイトを横断検索するローカルWebアプリです。

## 構成パターン

本アプリは用途に応じて 2 通りの構成で動かせます。

| 構成 | 用途 | コスト | 24h稼働 | 設定難度 |
|---|---|---|---|---|
| ローカル uvicorn (FastAPI + SQLite) | 開発・動作確認 | 0円 | × (PC依存) | 易 |
| **GitHub Pages + Supabase** (推奨) | 本番運用・社外共有 | 0円 (Free枠内) | ○ | 中 |

以下、まずクラウドデプロイ手順、その後にローカル開発向けの説明を記載します。

## 特徴

- WP REST API から記事を定期クロールしてローカルにインデックス
- REST が使えないサイトは HTML スクレイピング経由でも取得可能
- SQLite FTS5 による高速な日本語全文検索
- 「企業サイト」「被リンクサイト」など複数グループでサイトを整理
- サイトはYAMLで管理(追加・削除が簡単)
- 外部依存ほぼなし(SQLiteのみ)

## クラウドデプロイ (GitHub Pages + Supabase)

ローカル PC を立ち上げっぱなしにせず、24 時間稼働 + 社外共有可能な構成で運用したい場合の手順です。フロントは GitHub Pages に静的配信、DB は Supabase (PostgreSQL + 全文検索)、定期クロールは GitHub Actions で実行します。

### 構成

```
[ユーザー]
  ↓ ブラウザ
[GitHub Pages] HTML+JS+CSS (UI 配信)
  ↓ fetch
[Supabase REST/RPC] PostgreSQL + 全文検索
  ↑ 書き込み
[GitHub Actions] 6時間ごとに python -m app.crawler 実行
```

### 必要なファイル (既存または別エージェントが作成)

- `supabase_schema.sql` - Supabase に流し込むスキーマ + RPC
- `app/db_supabase.py` - Supabase 書き込み層
- `.github/workflows/crawl.yml` - 定期クロール
- `docs/` - GitHub Pages 用静的サイト

### 手順

1. **Supabase プロジェクト作成**
   - https://supabase.com/dashboard で New Project
   - Region: Northeast Asia (Tokyo)
   - Free プラン

2. **DB スキーマ流し込み**
   - SQL Editor で `supabase_schema.sql` を全部貼り付けて Run
   - エラーなく終わればOK

3. **接続情報取得**
   - Project Settings → API で:
     - Project URL を控える
     - publishable (anon) key を控える (フロント用、公開してOK)
     - service_role secret key を控える (クローラ用、絶対公開NG)

4. **GitHub リポジトリ作成 + push**
   - パブリックリポジトリ推奨 (GitHub Actions が無制限)

5. **GitHub Secrets 登録**
   - リポジトリの Settings → Secrets and variables → Actions → New repository secret
   - `SUPABASE_URL` に Project URL
   - `SUPABASE_SERVICE_KEY` に service_role secret key

6. **GitHub Pages 有効化**
   - Settings → Pages → Source: Deploy from branch
   - Branch: `main`, folder: `/docs`
   - Save → 1〜2分後に URL が発行される

7. **フロント設定**
   - `docs/config.js` を編集して SUPABASE_URL と SUPABASE_ANON_KEY を埋める
   - commit + push

8. **初回クロール**
   - GitHub の Actions タブ → "Crawl" or "クロール" workflow → Run workflow
   - 完了まで5〜15分程度

9. **アクセス**
   - `https://<ユーザ名>.github.io/<リポジトリ名>/`
   - URL を社内に共有

---

## セットアップ

```bash
# 1. 依存関係をインストール
pip3 install -r requirements.txt

# 2. クロール対象サイトを設定
# sites.yaml を編集してWordPressサイトを追加

# 3. Webサーバー起動
python3 -m uvicorn app.main:app --reload

# ブラウザで http://localhost:8000 を開く
```

初回起動時にDBスキーマが自動作成され、サイト情報が登録されます。記事はUIの「クロール実行」ボタン、もしくは下記のAPI経由で取得します。

---

## 操作方法

> **ローカル開発時のみの操作**: このセクションはローカル uvicorn (FastAPI + SQLite) 構成向けです。GitHub Pages + Supabase 構成では、クロールは GitHub Actions が自動で回し、検索 UI は GitHub Pages からの静的配信になります。

### サーバの起動・停止

**起動 (フォアグラウンド)**
```bash
python3 -m uvicorn app.main:app --reload
```

**起動 (バックグラウンド)**
```bash
mkdir -p logs
nohup python3 -m uvicorn app.main:app --reload > logs/uvicorn.log 2>&1 &
```

**停止**
```bash
pkill -f "uvicorn app.main"
```

**ログ確認**
```bash
tail -f logs/uvicorn.log
```

### クロール操作

**全サイトを差分クロール**
```bash
curl -X POST "http://localhost:8000/api/crawl"
```

**全サイトを全件取り直し (last_modified をクリア)**
```bash
curl -X POST "http://localhost:8000/api/crawl?full=true"
```

**特定サイトのみクロール**
```bash
curl -X POST "http://localhost:8000/api/crawl?site_id=サイトID"
curl -X POST "http://localhost:8000/api/crawl?site_id=サイトID&full=true"
```

UIヘッダー右上の「クロール実行」ボタンからも全サイトクロールを開始できます。

### 検索 API

```bash
# キーワード検索
curl "http://localhost:8000/api/search?q=カードローン"

# サイト絞り込み
curl "http://localhost:8000/api/search?q=借入&site=okagekk&site=mynavi-home"

# ソート (relevance / newest / oldest)
curl "http://localhost:8000/api/search?q=美容&sort=newest"
```

### 状態確認

```bash
# 統計情報 (総件数・サイト別件数・クロール状態)
curl http://localhost:8000/api/stats

# サイト/カテゴリ/タグのファセット情報
curl http://localhost:8000/api/facets

# グループ定義
curl http://localhost:8000/api/groups
```

### データベース操作

**特定サイトの記事だけ削除**
```bash
sqlite3 data/posts.db "DELETE FROM posts WHERE site_id='サイトID'"
```

**特定サイトの last_modified をクリア (次回全件取り直し用)**
```bash
sqlite3 data/posts.db "UPDATE sites SET last_modified=NULL WHERE id='サイトID'"
```

**全データを消す (サーバ停止後に実行)**
```bash
pkill -f "uvicorn app.main"
rm data/posts.db*
# サーバを起動するとスキーマと sites が再構築される
```

**サイト一覧と件数を一覧**
```bash
sqlite3 data/posts.db \
  "SELECT s.id, s.name, COALESCE(c.cnt,0) AS posts
   FROM sites s
   LEFT JOIN (SELECT site_id, COUNT(*) AS cnt FROM posts GROUP BY site_id) c
     ON c.site_id=s.id
   ORDER BY s.group_id, posts DESC;"
```

---

## sites.yaml のフォーマット

### 最小例

```yaml
groups:
  - id: backlink
    name: 被リンクサイト
  - id: corporate
    name: 企業サイト

sites:
  - name: マイブログ
    url: https://example.com
    group: backlink

crawl:
  per_page: 100
  request_timeout: 30
  delay_between_requests: 0.5
  schedule_hours: 6
```

各サイトに使える項目:

| 項目 | 必須 | 説明 |
|---|---|---|
| `id` | 任意 | 内部識別子。省略時は `name` と同じ値が使われる |
| `name` | ✓ | UI表示名 |
| `url` | ✓ | WordPress サイトのトップURL (末尾スラッシュなし) |
| `group` | ✓ | 所属グループID (`backlink` / `corporate` 等、`groups:` で定義したもの) |
| `post_type` | 任意 | カスタム投稿タイプの rest_base (省略時 `posts`) |
| `extra_params` | 任意 | REST API に渡す追加クエリパラメータ |
| `scrape` | 任意 | REST非公開のサイト用、HTMLスクレイピング設定 |

### カスタム投稿タイプ + カテゴリ絞り込み

okage の「お役立ちコラム」の「生活の知恵」カテゴリだけ取得する例:

```yaml
- id: okagekk
  name: okage (生活の知恵)
  url: https://okagekk.com
  group: corporate
  post_type: column
  extra_params:
    column_cate: 47
```

→ `https://okagekk.com/wp-json/wp/v2/column?column_cate=47&...` を叩く。

### HTML スクレイピング (REST 非公開サイト用)

イーキャンパスのように `/reading-*` 記事が REST に出てこないサイト向け:

```yaml
- id: ecampus-reading-media
  name: イーキャンパス
  url: https://www.ecampus.jp
  group: corporate
  scrape:
    archive_url: https://www.ecampus.jp/reading-category/borrowing/
    link_re: "^https://www\\.ecampus\\.jp/reading-(?!category)[a-z0-9-]+/?$"
```

`archive_url` の HTML から `link_re` にマッチする URL を抽出し、個別ページから h1 / `<article>` 等を抜いて保存します。日付は JSON-LD / OGP meta / `<time>` の順で抽出を試みます。

---

## クロール戦略 (内部仕様)

### REST API モード (通常)

1. 投稿タイプ・追加パラメータを組み立てて `/wp-json/wp/v2/{post_type}` を取得
2. `_embed=1` でカテゴリ・タグ・著者も同時取得
3. `orderby=id&order=asc` で安定ページネーション
4. `modified_after` で差分取得

### フォールバック処理

サイトごとの REST 設定の違いに対応するため、自動で経路を切り替える:

| 元の挙動 | フォールバック |
|---|---|
| `/wp-json/...` が 404 | `?rest_route=/wp/v2/...` 形式で再リクエスト |
| `/wp-json/...` が 3xx リダイレクト | 同上 (リダイレクト追跡はしない) |
| 応答が非JSON | 同上 |
| タイムアウト | `_embed=1` を外して page=1 から再走 → さらに per_page 縮小 |

縮退モードは **サイト単位で1モード貫徹**。ページ途中で per_page が変わってオフセットがズレることはありません。

### ファイル構成

```
wp-search/
├── README.md
├── requirements.txt
├── sites.yaml              # クロール対象サイト一覧
├── data/
│   └── posts.db            # SQLite データベース(自動生成)
├── logs/
│   └── uvicorn.log         # サーバログ (任意)
└── app/
    ├── main.py             # FastAPI (検索API + UI + クロールAPI)
    ├── crawler.py          # WP REST / HTML スクレイピング クローラ
    ├── db.py               # SQLite + FTS5 操作
    ├── templates/
    │   └── index.html      # 検索UI
    └── static/
        ├── app.js
        └── style.css
```

---

## トラブルシューティング

### クロールが全件 -1 で失敗する

DBスキーマが壊れている可能性。サーバ停止 → `data/posts.db*` を削除 → サーバ再起動でスキーマ再生成。

### 特定サイトだけ 0 件になる

1. ブラウザか curl で `https://対象/wp-json/wp/v2/posts` の挙動確認
2. 404/3xx/非JSON なら `?rest_route=` 形式が効くか確認
3. それも駄目なら REST API がそのサイトで無効化されている可能性 → スクレイピング設定を検討
4. 認証要求 (401) の場合は取得不可

### 件数が前回より減った/増えた

差分クロール (`modified_after`) の影響。確実に全件揃えたい場合は `?full=true` で取り直す。

### サーバが起動しているはずなのに 500 が返る

uvicorn は走っているが DB スキーマが消えた状態の可能性。`sqlite3 data/posts.db ".tables"` で確認し、空ならサーバ停止 + DB削除 + 再起動。

---

## 仕組み (まとめ)

1. **クロール**: 各サイトの `/wp-json/wp/v2/posts` または HTML から記事取得
2. **インデックス**: SQLite FTS5 (タイトル+本文+抜粋を日本語ユニグラム化)
3. **検索**: FTS5 MATCH + サイト/カテゴリ/タグでの絞り込み
4. **スケジュール**: APScheduler で `schedule_hours` ごとに自動クロール
