// WP Multi-Site Search - Static Frontend (Supabase 直接呼び出し版)

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const state = {
    q: "",
    sites: new Set(),
    sort: "relevance",
    page: 0,
    pageSize: 20,
    sitesByGroup: { corporate: [], backlink: [] },
    siteMeta: {},          // id -> {name, group_id, count}
    lastTotal: 0,
    lastCrawledAt: null,   // データ最終更新の概算 (結果の最大 published_at)
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ============================================================================
// ユーティリティ
// ============================================================================

function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

// クエリのキーワードをハイライト (簡易、既存実装を踏襲)
function highlight(text, query) {
    if (!query || !text) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const terms = [];
    const phraseRe = /"([^"]+)"/g;
    let m;
    let rest = query;
    while ((m = phraseRe.exec(query)) !== null) {
        terms.push(m[1]);
        rest = rest.replace(m[0], " ");
    }
    rest.split(/[\s　]+/).filter(Boolean).forEach(tok => {
        if (/^[A-Za-z0-9_\-.]+$/.test(tok)) {
            terms.push(tok);
        } else {
            for (const ch of tok) terms.push(ch);
        }
    });
    if (terms.length === 0) return escaped;
    const reSrc = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`(${reSrc})`, "gi");
    return escaped.replace(re, "<mark>$1</mark>");
}

function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
}

function splitPipe(s) {
    if (!s) return [];
    if (Array.isArray(s)) return s;
    return String(s).split("|").filter(Boolean);
}

// ============================================================================
// FTS クエリ組み立て (app/db.py の _build_fts_query / tokenize_for_index を移植)
// PostgreSQL の to_tsquery('simple', ...) 用なので、構文は以下の通り:
//   AND -> &
//   フレーズ隣接 -> a <-> b <-> c   (Python版の "a b c" を <-> 連結に置換)
//   ASCII 前方一致 -> tok:*         (Python版の tok* を tok:* に置換)
//   日本語単独 -> 'x'                (引用なしでもOK)
// ============================================================================

function isCJK(ch) {
    const code = ch.codePointAt(0);
    if (code >= 0x3040 && code <= 0x30FF) return true; // ひらがな・カタカナ
    if (code >= 0x4E00 && code <= 0x9FFF) return true; // CJK統合漢字
    if (code >= 0x3400 && code <= 0x4DBF) return true; // CJK拡張A
    if (code >= 0xF900 && code <= 0xFAFF) return true; // CJK互換漢字
    if (code >= 0xFF66 && code <= 0xFF9F) return true; // 半角カナ
    return false;
}

function isSpace(ch) {
    return /\s/.test(ch);
}

// インデックス用に日本語文字の前後に空白を挿入 (NFKC正規化)
function tokenizeForIndex(text) {
    if (!text) return "";
    text = text.normalize("NFKC");
    const out = [];
    let prevCjk = false;
    let prevSpace = true;
    for (const ch of text) {
        if (isSpace(ch)) {
            out.push(" ");
            prevCjk = false;
            prevSpace = true;
            continue;
        }
        if (isCJK(ch)) {
            if (!prevSpace) out.push(" ");
            out.push(ch);
            out.push(" ");
            prevCjk = true;
            prevSpace = true;
        } else {
            const isAllowed = /[A-Za-z0-9_\-.@/]/.test(ch);
            if (!isAllowed) {
                out.push(" ");
                prevSpace = true;
                prevCjk = false;
                continue;
            }
            if (prevCjk && !prevSpace) out.push(" ");
            out.push(ch.toLowerCase());
            prevCjk = false;
            prevSpace = false;
        }
    }
    return out.join("").split(/\s+/).filter(Boolean).join(" ");
}

function toIndexTokens(text) {
    const s = tokenizeForIndex(text);
    return s ? s.split(" ").filter(Boolean) : [];
}

function isAsciiWord(s) {
    return /^[A-Za-z0-9_\-.@/]+$/.test(s);
}

// tsquery で予約された文字を除去 (Python版の _FTS_SPECIAL に加えて & | ! も除去)
const TSQUERY_SPECIAL_RE = /["&|!:*()<>]/g;

function buildFtsQuery(raw) {
    if (!raw) return "";
    raw = raw.normalize("NFKC").trim();
    if (!raw) return "";

    // フレーズ ("...") 抽出
    const parts = []; // [text, isPhrase]
    let buf = "";
    let inPhrase = false;
    let phraseBuf = "";
    for (const ch of raw) {
        if (ch === '"') {
            if (inPhrase) {
                const p = phraseBuf.trim();
                if (p) parts.push([p, true]);
                phraseBuf = "";
                inPhrase = false;
            } else {
                if (buf) {
                    parts.push([buf, false]);
                    buf = "";
                }
                inPhrase = true;
            }
        } else if (inPhrase) {
            phraseBuf += ch;
        } else {
            buf += ch;
        }
    }
    if (buf) parts.push([buf, false]);
    if (inPhrase && phraseBuf) parts.push([phraseBuf, false]);

    const ftsParts = [];
    for (const [textRaw, isPhrase] of parts) {
        const text = textRaw.replace(TSQUERY_SPECIAL_RE, " ");
        if (isPhrase) {
            const toks = toIndexTokens(text);
            if (toks.length) {
                ftsParts.push(toks.join(" <-> "));
            }
        } else {
            for (const tok of text.split(/[\s　]+/)) {
                if (!tok) continue;
                const idxToks = toIndexTokens(tok);
                if (!idxToks.length) continue;
                if (idxToks.length === 1) {
                    const t = idxToks[0];
                    if (isAsciiWord(t)) {
                        ftsParts.push(`${t}:*`);
                    } else {
                        ftsParts.push(t);
                    }
                } else {
                    if (idxToks.every(t => !isAsciiWord(t))) {
                        // 日本語連続 → 隣接
                        ftsParts.push(idxToks.join(" <-> "));
                    } else {
                        const sub = idxToks.map(t => isAsciiWord(t) ? `${t}:*` : t);
                        ftsParts.push("(" + sub.join(" & ") + ")");
                    }
                }
            }
        }
    }

    return ftsParts.join(" & ");
}

// ============================================================================
// API 呼び出し (Supabase RPC)
// ============================================================================

async function rpcSearch({ limit, offset }) {
    const fts = buildFtsQuery(state.q);
    const args = {
        fts_query: fts,
        p_site_ids: state.sites.size ? Array.from(state.sites) : null,
        p_group_id: null,
        p_sort: state.sort,
        p_limit: limit,
        p_offset: offset,
    };
    const { data, error } = await sb.rpc("search_posts", args);
    if (error) {
        console.error("search_posts error", error);
        throw error;
    }
    return data || [];
}

async function rpcListSites() {
    const { data, error } = await sb.rpc("list_sites_with_counts");
    if (error) {
        console.error("list_sites_with_counts error", error);
        throw error;
    }
    return data || [];
}

// ============================================================================
// レンダリング
// ============================================================================

function renderSiteList(container, sites) {
    container.innerHTML = "";
    sites.forEach(site => {
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = site.id;
        cb.checked = state.sites.has(site.id);
        cb.addEventListener("change", () => {
            if (cb.checked) state.sites.add(site.id); else state.sites.delete(site.id);
            state.page = 0;
            runSearch();
            renderChips();
        });
        const span = document.createElement("span");
        span.textContent = site.name;
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = site.count ?? "";
        label.append(cb, span, count);
        container.append(label);
    });
}

function renderFacets(sites) {
    const byGroup = { corporate: [], backlink: [] };
    const meta = {};
    sites.forEach(s => {
        meta[s.id] = s;
        const g = s.group_id || "backlink";
        if (!byGroup[g]) byGroup[g] = [];
        byGroup[g].push(s);
    });
    state.sitesByGroup = byGroup;
    state.siteMeta = meta;

    renderSiteList($("#facet-sites-corporate"), byGroup.corporate || []);
    renderSiteList($("#facet-sites-backlink"), byGroup.backlink || []);

    // 統計表示: サイト数 / 総記事数
    const totalPosts = sites.reduce((a, b) => a + (Number(b.count) || 0), 0);
    const siteCount = sites.length;
    $("#stats").textContent = `${siteCount} サイト / ${totalPosts.toLocaleString()} 記事`;
}

function renderChips() {
    const container = $("#filter-chips");
    container.innerHTML = "";
    const makeChip = (label, onRemove) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.innerHTML = `${escapeHtml(label)} <button title="解除">✕</button>`;
        chip.querySelector("button").addEventListener("click", onRemove);
        container.append(chip);
    };
    state.sites.forEach(id => {
        const name = state.siteMeta[id]?.name || id;
        makeChip(`サイト: ${name}`, () => {
            state.sites.delete(id);
            refreshAll();
        });
    });
}

function renderResults(rows, offset) {
    const list = $("#results");
    const meta = $("#results-meta");
    const total = rows.length > 0 ? Number(rows[0].total_count) || 0 : 0;
    state.lastTotal = total;
    $("#copy-urls-btn").disabled = total === 0;

    if (total === 0) {
        meta.textContent = "";
        list.innerHTML = '<li class="empty">該当する記事はありません</li>';
        $("#pagination").innerHTML = "";
        return;
    }

    const from = offset + 1;
    const to = Math.min(offset + rows.length, total);

    // 結果から最新 published_at を取得 (最終クロール時刻の代理表示)
    let latest = null;
    for (const r of rows) {
        if (!r.published_at) continue;
        if (!latest || r.published_at > latest) latest = r.published_at;
    }
    const latestStr = latest ? ` · 最新記事: ${formatDateTime(latest)}` : "";
    meta.textContent = `${total.toLocaleString()} 件中 ${from}–${to} 件を表示${latestStr}`;

    list.innerHTML = "";
    for (const r of rows) {
        const li = document.createElement("li");
        li.className = "result";
        const cats = splitPipe(r.categories).map(c => `<span>${escapeHtml(c)}</span>`).join("");
        const tags = splitPipe(r.tags).map(t => `<span>#${escapeHtml(t)}</span>`).join("");
        const siteName = state.siteMeta[r.site_id]?.name || r.site_id;
        li.innerHTML = `
            <a class="result-title" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">
                ${highlight(r.title || "(無題)", state.q)}
            </a>
            <div class="result-meta">
                <span class="site-tag">${escapeHtml(siteName)}</span>
                <span>${formatDate(r.published_at)}</span>
                ${r.author ? `<span>by ${escapeHtml(r.author)}</span>` : ""}
            </div>
            <div class="result-excerpt">${highlight(truncate(r.excerpt || "", 200), state.q)}</div>
            ${(cats || tags) ? `<div class="result-taxonomies">${cats}${tags}</div>` : ""}
        `;
        list.append(li);
    }

    renderPagination(total);
}

function renderPagination(total) {
    const pag = $("#pagination");
    pag.innerHTML = "";
    const totalPages = Math.ceil(total / state.pageSize);
    if (totalPages <= 1) return;

    const mk = (label, page, disabled = false, current = false) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.disabled = disabled;
        if (current) b.classList.add("current");
        b.addEventListener("click", () => {
            state.page = page;
            runSearch();
            window.scrollTo({ top: 0, behavior: "smooth" });
        });
        return b;
    };

    pag.append(mk("‹", state.page - 1, state.page <= 0));

    const cur = state.page;
    const start = Math.max(0, cur - 2);
    const end = Math.min(totalPages, start + 5);
    for (let i = start; i < end; i++) {
        pag.append(mk(String(i + 1), i, false, i === cur));
    }
    pag.append(mk("›", state.page + 1, state.page >= totalPages - 1));
}

// ============================================================================
// アクション
// ============================================================================

let searchTimer = null;
function debouncedSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        state.page = 0;
        runSearch();
    }, 250);
}

let searchSeq = 0;
async function runSearch() {
    const mySeq = ++searchSeq;
    try {
        const offset = state.page * state.pageSize;
        const rows = await rpcSearch({ limit: state.pageSize, offset });
        if (mySeq !== searchSeq) return; // 古いレスポンスは破棄
        renderResults(rows, offset);
    } catch (e) {
        if (mySeq !== searchSeq) return;
        const meta = $("#results-meta");
        meta.textContent = "検索エラー: " + (e.message || e);
        $("#results").innerHTML = "";
        $("#pagination").innerHTML = "";
    }
}

async function refreshAll() {
    renderChips();
    try {
        const [sites] = await Promise.all([rpcListSites(), runSearch()]);
        renderFacets(sites);
    } catch (e) {
        console.error(e);
    }
}

function selectGroupSites(groupId) {
    (state.sitesByGroup[groupId] || []).forEach(s => state.sites.add(s.id));
    state.page = 0;
    refreshAll();
}

function clearGroupSites(groupId) {
    (state.sitesByGroup[groupId] || []).forEach(s => state.sites.delete(s.id));
    state.page = 0;
    refreshAll();
}

async function fetchAllResultUrls() {
    const urls = [];
    const pageSize = 100;
    let offset = 0;
    const maxOffset = 10000; // 安全弁
    while (offset <= maxOffset) {
        const fts = buildFtsQuery(state.q);
        const { data, error } = await sb.rpc("search_posts", {
            fts_query: fts,
            p_site_ids: state.sites.size ? Array.from(state.sites) : null,
            p_group_id: null,
            p_sort: state.sort,
            p_limit: pageSize,
            p_offset: offset,
        });
        if (error) throw error;
        const rows = data || [];
        for (const item of rows) {
            if (item.url) urls.push(item.url);
        }
        if (rows.length < pageSize) break;
        offset += pageSize;
    }
    return urls;
}

async function copyResultUrls() {
    const btn = $("#copy-urls-btn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "取得中…";
    try {
        const urls = await fetchAllResultUrls();
        if (urls.length === 0) {
            alert("コピーできるURLがありません");
            return;
        }
        const text = urls.join("\n");
        try {
            await navigator.clipboard.writeText(text);
            btn.textContent = `${urls.length} 件コピー済み`;
            setTimeout(() => { btn.textContent = original; }, 1800);
        } catch (e) {
            const ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            btn.textContent = `${urls.length} 件コピー済み`;
            setTimeout(() => { btn.textContent = original; }, 1800);
        }
    } catch (e) {
        alert("URLの取得に失敗しました: " + (e.message || e));
        btn.textContent = original;
    } finally {
        btn.disabled = state.lastTotal === 0;
    }
}

// ============================================================================
// 初期化
// ============================================================================

$("#query").addEventListener("input", (e) => {
    state.q = e.target.value;
    debouncedSearch();
});
$("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    state.page = 0;
    runSearch();
});
$("#copy-urls-btn").addEventListener("click", copyResultUrls);
$$(".js-select-group").forEach(b => b.addEventListener("click", () => selectGroupSites(b.dataset.group)));
$$(".js-clear-group").forEach(b => b.addEventListener("click", () => clearGroupSites(b.dataset.group)));

refreshAll();
