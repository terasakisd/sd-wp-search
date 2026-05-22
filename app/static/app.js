// WP Multi-Site Search - Frontend

const state = {
    q: "",
    sites: new Set(),
    sort: "relevance",
    page: 0,
    pageSize: 20,
    sitesByGroup: { corporate: [], backlink: [] },  // {groupId: [siteObj...]}
    lastTotal: 0,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ----- ユーティリティ -------------------------------------------------------

function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

// クエリのキーワードをハイライト (簡易)
function highlight(text, query) {
    if (!query || !text) return escapeHtml(text);
    const escaped = escapeHtml(text);
    // クエリを単語/文字に分解
    const terms = [];
    // フレーズ抽出
    const phraseRe = /"([^"]+)"/g;
    let m;
    let rest = query;
    while ((m = phraseRe.exec(query)) !== null) {
        terms.push(m[1]);
        rest = rest.replace(m[0], " ");
    }
    rest.split(/[\s\u3000]+/).filter(Boolean).forEach(tok => {
        if (/^[A-Za-z0-9_\-.]+$/.test(tok)) {
            terms.push(tok);
        } else {
            // 日本語などは1文字ずつ
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

function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
}

// ----- API 呼び出し ---------------------------------------------------------

async function fetchFacets() {
    const r = await fetch("/api/facets");
    return r.json();
}

async function fetchStats() {
    const r = await fetch("/api/stats");
    return r.json();
}

async function fetchSearch() {
    const params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    state.sites.forEach(s => params.append("site", s));
    params.set("sort", state.sort);
    params.set("limit", state.pageSize);
    params.set("offset", state.page * state.pageSize);
    const r = await fetch("/api/search?" + params.toString());
    return r.json();
}

// ----- レンダリング ---------------------------------------------------------

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

function renderFacets(facets) {
    // サイトをグループ別に振り分けて保持
    const byGroup = { corporate: [], backlink: [] };
    facets.sites.forEach(s => {
        const g = s.group_id || "backlink";
        (byGroup[g] || (byGroup[g] = [])).push(s);
    });
    state.sitesByGroup = byGroup;

    renderSiteList($("#facet-sites-corporate"), byGroup.corporate || []);
    renderSiteList($("#facet-sites-backlink"), byGroup.backlink || []);
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
    state.sites.forEach(s => makeChip(`サイト: ${s}`, () => { state.sites.delete(s); refreshAll(); }));
}

function renderResults(data) {
    const list = $("#results");
    const meta = $("#results-meta");
    state.lastTotal = data.total || 0;
    $("#copy-urls-btn").disabled = state.lastTotal === 0;

    if (data.total === 0) {
        meta.textContent = "";
        list.innerHTML = '<li class="empty">該当する記事はありません</li>';
        $("#pagination").innerHTML = "";
        return;
    }

    const from = data.offset + 1;
    const to = Math.min(data.offset + data.results.length, data.total);
    meta.textContent = `${data.total.toLocaleString()} 件中 ${from}–${to} 件を表示`;

    list.innerHTML = "";
    for (const r of data.results) {
        const li = document.createElement("li");
        li.className = "result";
        const cats = (r.categories || []).map(c => `<span>${escapeHtml(c)}</span>`).join("");
        const tags = (r.tags || []).map(t => `<span>#${escapeHtml(t)}</span>`).join("");
        li.innerHTML = `
            <a class="result-title" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">
                ${highlight(r.title || "(無題)", state.q)}
            </a>
            <div class="result-meta">
                <span class="site-tag">${escapeHtml(r.site_id)}</span>
                <span>${formatDate(r.published_at)}</span>
                ${r.author ? `<span>by ${escapeHtml(r.author)}</span>` : ""}
            </div>
            <div class="result-excerpt">${highlight(truncate(r.excerpt || "", 200), state.q)}</div>
            ${(cats || tags) ? `<div class="result-taxonomies">${cats}${tags}</div>` : ""}
        `;
        list.append(li);
    }

    renderPagination(data.total);
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

    // 表示するページ番号 (現在の前後数件)
    const cur = state.page;
    const start = Math.max(0, cur - 2);
    const end = Math.min(totalPages, start + 5);
    for (let i = start; i < end; i++) {
        pag.append(mk(String(i + 1), i, false, i === cur));
    }
    pag.append(mk("›", state.page + 1, state.page >= totalPages - 1));
}

async function renderStats() {
    const s = await fetchStats();
    const total = (s.total_posts || 0).toLocaleString();
    const sites = Object.keys(s.posts_by_site || {}).length;
    const status = s.crawl_status?.running ? " · クロール中…" : "";
    $("#stats").textContent = `${sites} サイト / ${total} 記事${status}`;
}

// ----- アクション -----------------------------------------------------------

let searchTimer = null;
function debouncedSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        state.page = 0;
        runSearch();
    }, 250);
}

async function runSearch() {
    const data = await fetchSearch();
    renderResults(data);
}

async function refreshAll() {
    renderChips();
    const [facets, _] = await Promise.all([fetchFacets(), runSearch()]);
    renderFacets(facets);
    renderStats();
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
    const maxOffset = 10000;  // 安全弁
    while (offset <= maxOffset) {
        const params = new URLSearchParams();
        if (state.q) params.set("q", state.q);
        state.sites.forEach(s => params.append("site", s));
        params.set("sort", state.sort);
        params.set("limit", pageSize);
        params.set("offset", offset);
        const r = await fetch("/api/search?" + params.toString());
        const j = await r.json();
        for (const item of (j.results || [])) {
            if (item.url) urls.push(item.url);
        }
        if (!j.results || j.results.length < pageSize) break;
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
            // クリップボードAPIが使えない場合のフォールバック
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
        alert("URLの取得に失敗しました: " + e);
        btn.textContent = original;
    } finally {
        btn.disabled = state.lastTotal === 0;
    }
}

async function triggerCrawl() {
    const btn = $("#crawl-btn");
    btn.disabled = true;
    btn.textContent = "クロール開始中…";
    try {
        const r = await fetch("/api/crawl", { method: "POST" });
        const j = await r.json();
        alert(j.message);
        // 完了するまで定期的にstats更新
        const iv = setInterval(async () => {
            await renderStats();
            const s = await fetchStats();
            if (!s.crawl_status?.running) {
                clearInterval(iv);
                btn.disabled = false;
                btn.textContent = "クロール実行";
                refreshAll();
            }
        }, 3000);
    } catch (e) {
        alert("クロールの開始に失敗しました: " + e);
        btn.disabled = false;
        btn.textContent = "クロール実行";
    }
}

// ----- 初期化 ---------------------------------------------------------------

$("#query").addEventListener("input", (e) => {
    state.q = e.target.value;
    debouncedSearch();
});
$("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    state.page = 0;
    runSearch();
});
$("#crawl-btn").addEventListener("click", triggerCrawl);
$("#copy-urls-btn").addEventListener("click", copyResultUrls);
$$(".js-select-group").forEach(b => b.addEventListener("click", () => selectGroupSites(b.dataset.group)));
$$(".js-clear-group").forEach(b => b.addEventListener("click", () => clearGroupSites(b.dataset.group)));

refreshAll();
