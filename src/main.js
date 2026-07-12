import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Dataset } from 'crawlee';
import { Impit } from 'impit';

const BASE = 'https://clearedjobs.net';

// ─── Concurrency cap for detail fetches ──────────────────────────────────────
// 25 simultaneous connections saturates most proxies; 10 is the sweet spot to prevent 429 errors.
// For local runs, reduce concurrency to prevent 429/403 errors from single IP (using 4 for optimal speed and safety).
const DETAIL_CONCURRENCY = Actor.isAtHome() ? 10 : 4;

// ─── Client Manager for Proxy Rotation ────────────────────────────────────────

class ClientManager {
    constructor(proxyConf) {
        this.proxyConf = proxyConf;
        this.client = null;
    }

    async getClient(forceRotate = false) {
        if (!this.client || forceRotate) {
            let proxyUrl;
            try {
                proxyUrl = this.proxyConf ? await this.proxyConf.newUrl() : undefined;
            } catch (err) {
                log.warning(`Failed to rotate proxy session: ${err.message}`);
            }
            this.client = new Impit({
                browser: 'chrome',
                ignoreTlsErrors: true,
                ...(proxyUrl && { proxyUrl }),
            });
            if (forceRotate) {
                log.debug('Rotated proxy client due to rate limit or connection error.');
            }
        }
        return this.client;
    }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

let last429Time = 0;
const COOLDOWN_MS = 5000; // 5 seconds cooldown for faster recovery

async function check429Cooldown() {
    const now = Date.now();
    const timeSinceLast429 = now - last429Time;
    if (timeSinceLast429 < COOLDOWN_MS) {
        const wait = COOLDOWN_MS - timeSinceLast429 + Math.random() * 2000;
        log.warning(`Global 429 cooldown active. Waiting ${Math.round(wait)}ms before next request.`);
        await sleep(wait);
    }
}

function normalizeSpace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function safeJson(text) {
    try { return JSON.parse(text); } catch { return null; }
}

function normalizeUrl(value) {
    if (!value) return null;
    try {
        const parsed = new URL(value, BASE);
        parsed.hash = '';
        parsed.searchParams.delete('ref');
        return parsed.href;
    } catch { return null; }
}

// Strips null / empty strings / empty arrays / empty objects recursively
function compactValue(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') {
        const s = normalizeSpace(value);
        return s || undefined;
    }
    if (Array.isArray(value)) {
        const cleaned = value.map(compactValue).filter((e) => e !== undefined);
        return cleaned.length ? cleaned : undefined;
    }
    if (typeof value === 'object') {
        const cleaned = /** @type {Record<string, unknown>} */ ({});
        for (const [k, v] of Object.entries(value)) {
            const c = compactValue(v);
            if (c !== undefined) cleaned[k] = c;
        }
        return Object.keys(cleaned).length ? cleaned : undefined;
    }
    return value;
}

function compactRecord(record) {
    return compactValue(record) || {};
}

function parseJsonLd(input) {
    if (!input) return {};
    if (typeof input === 'string') {
        const parsed = safeJson(input) || {};
        if (Array.isArray(parsed)) return parsed.find((e) => e && typeof e === 'object') || {};
        return typeof parsed === 'object' ? parsed : {};
    }
    if (Array.isArray(input)) return input.find((e) => e && typeof e === 'object') || {};
    return typeof input === 'object' ? input : {};
}

function getValueCaseInsensitive(obj, path) {
    if (!obj || typeof obj !== 'object') return undefined;
    const parts = path.toLowerCase().split('.');
    let current = obj;
    for (const part of parts) {
        if (!current || typeof current !== 'object') return undefined;
        const keys = Object.keys(current);
        const matchedKey = keys.find(k => k.toLowerCase() === part);
        if (matchedKey === undefined) return undefined;
        current = current[matchedKey];
    }
    return current;
}

function extractFromBlocks(blocks, label) {
    if (!Array.isArray(blocks)) return null;
    const target = label.toLowerCase();
    const block = blocks.find((b) => {
        if (!b || typeof b !== 'object') return false;
        const bLabel = getValueCaseInsensitive(b, 'label') || getValueCaseInsensitive(b, 'title');
        return String(bLabel || '').toLowerCase().trim() === target;
    });
    const val = block ? getValueCaseInsensitive(block, 'value') : null;
    return val ? normalizeSpace(String(val)) : null;
}

function buildDedupKey(item) {
    const itemId = getValueCaseInsensitive(item, 'id');
    if (itemId != null) return `id:${itemId}`;
    const u = normalizeUrl(getValueCaseInsensitive(item, 'url'));
    if (u) return `url:${u.toLowerCase()}`;
    const t = normalizeSpace(getValueCaseInsensitive(item, 'title') || '').toLowerCase();
    const c = normalizeSpace(getValueCaseInsensitive(item, 'company') || '').toLowerCase();
    const l = normalizeSpace(getValueCaseInsensitive(item, 'location') || '').toLowerCase();
    if (t || c || l) return `tcl:${t}|${c}|${l}`;
    return null;
}

function buildSearchParams({ startUrl, keywords, location }) {
    const params = { locale: 'en', sort: 'date', keywords };
    if (location) params.city_state_zip = location;

    if (!startUrl) return params;
    try {
        const parsed = new URL(startUrl, BASE);
        const sp = parsed.searchParams;
        const getSpValue = (spObj, key) => {
            const keys = Array.from(spObj.keys());
            const matchedKey = keys.find(k => k.toLowerCase() === key.toLowerCase());
            return matchedKey ? spObj.get(matchedKey) : null;
        };

        const kw = getSpValue(sp, 'keywords');
        const csz = getSpValue(sp, 'city_state_zip');
        const s = getSpValue(sp, 'sort');
        const loc = getSpValue(sp, 'locale');
        const lro = getSpValue(sp, 'location_remote_option_filter');

        if (kw !== null) params.keywords = kw;
        if (csz !== null) params.city_state_zip = csz;
        if (s !== null) params.sort = s;
        if (loc !== null) params.locale = loc;
        if (lro !== null) params.location_remote_option_filter = lro;
    } catch (err) {
        log.warning(`Invalid startUrl: ${err.message}`);
    }
    return params;
}

function mapApiJob(job, detail = {}) {
    const id = getValueCaseInsensitive(job, 'id') ?? getValueCaseInsensitive(detail, 'id') ?? null;
    const url = normalizeUrl(
        getValueCaseInsensitive(job, 'url') ||
        getValueCaseInsensitive(detail, 'url') ||
        (id ? `${BASE}/job/${id}` : null),
    );

    const descriptionHtml = getValueCaseInsensitive(detail, 'description') || getValueCaseInsensitive(job, 'description') || null;
    const jsonLd = parseJsonLd(getValueCaseInsensitive(detail, 'jsonLd') || getValueCaseInsensitive(job, 'jsonLd'));

    const detailBottom = getValueCaseInsensitive(detail, 'customBlockBottom');
    const detailTop = getValueCaseInsensitive(detail, 'customBlockTop');
    const jobList = getValueCaseInsensitive(job, 'customBlockList');
    const customBlocks = [
        ...(Array.isArray(detailBottom) ? detailBottom : []),
        ...(Array.isArray(detailTop) ? detailTop : []),
        ...(Array.isArray(jobList) ? jobList : []),
    ];

    const clearanceFromBlocks = extractFromBlocks(customBlocks, 'security clearance');
    const postedFromBlocks = extractFromBlocks(customBlocks, 'posted');
    const jobReferenceId = extractFromBlocks(customBlocks, 'job reference id');

    const jobLoc = getValueCaseInsensitive(jsonLd, 'jobLocation');
    const address = getValueCaseInsensitive(jobLoc, 'address');
    const locality = getValueCaseInsensitive(address, 'addressLocality');
    const region = getValueCaseInsensitive(address, 'addressRegion');

    const location = normalizeSpace(
        getValueCaseInsensitive(detail, 'location') ||
        getValueCaseInsensitive(job, 'location') ||
        locality ||
        region || '',
    );

    const baseSal = getValueCaseInsensitive(jsonLd, 'baseSalary');
    const baseSalVal = getValueCaseInsensitive(baseSal, 'value');
    const baseSalValVal = getValueCaseInsensitive(baseSalVal, 'value');
    const salary = getValueCaseInsensitive(detail, 'salary') || getValueCaseInsensitive(job, 'salary') || baseSalValVal || null;

    const companyRaw = getValueCaseInsensitive(detail, 'company') || getValueCaseInsensitive(job, 'company') || null;
    const hiringOrg = getValueCaseInsensitive(jsonLd, 'hiringOrganization');
    const hiringOrgName = getValueCaseInsensitive(hiringOrg, 'name');
    const companyName = normalizeSpace(
        (typeof companyRaw === 'object' ? getValueCaseInsensitive(companyRaw, 'name') : companyRaw) ||
        hiringOrgName || '',
    );

    const security_clearance =
        clearanceFromBlocks ||
        getValueCaseInsensitive(detail, 'security_clearance') ||
        getValueCaseInsensitive(job, 'security_clearance') ||
        getValueCaseInsensitive(jsonLd, 'industry') || null;

    const employmentType =
        getValueCaseInsensitive(detail, 'positionType') ||
        getValueCaseInsensitive(detail, 'position_type') ||
        getValueCaseInsensitive(detail, 'job_type') ||
        getValueCaseInsensitive(detail, 'employment_type') ||
        getValueCaseInsensitive(job, 'positionType') ||
        getValueCaseInsensitive(job, 'position_type') ||
        getValueCaseInsensitive(job, 'job_type') ||
        (() => {
            const empType = getValueCaseInsensitive(jsonLd, 'employmentType');
            return Array.isArray(empType) ? empType.join(', ') : empType;
        })() || null;

    let descriptionText;
    const shortDesc = getValueCaseInsensitive(job, 'shortDescription');
    const descLd = getValueCaseInsensitive(jsonLd, 'description');
    if (descriptionHtml) {
        descriptionText = normalizeSpace(cheerio.load(descriptionHtml).text());
    } else if (shortDesc) {
        descriptionText = normalizeSpace(shortDesc);
    } else if (descLd) {
        descriptionText = normalizeSpace(descLd);
    }

    return compactRecord({
        id,
        url,
        title: normalizeSpace(
            getValueCaseInsensitive(job, 'title') ||
            getValueCaseInsensitive(job, 'job_title') ||
            getValueCaseInsensitive(jsonLd, 'title') || '',
        ),
        company: companyName,
        company_details: typeof companyRaw === 'object' ? companyRaw : undefined,
        location,
        coordinates: getValueCaseInsensitive(detail, 'coordinates') || getValueCaseInsensitive(job, 'coordinates'),
        address: getValueCaseInsensitive(detail, 'address'),
        security_clearance,
        salary: salary ? String(salary) : undefined,
        job_type: employmentType,
        experience: getValueCaseInsensitive(detail, 'experience'),
        education: getValueCaseInsensitive(detail, 'education'),
        posted_date: postedFromBlocks || getValueCaseInsensitive(job, 'posted_date'),
        modified_time: getValueCaseInsensitive(job, 'modified_time'),
        date_posted:
            getValueCaseInsensitive(job, 'posted_date') ||
            getValueCaseInsensitive(job, 'modified_time') ||
            getValueCaseInsensitive(job, 'created_at') ||
            getValueCaseInsensitive(detail, 'time') ||
            getValueCaseInsensitive(jsonLd, 'datePosted') || null,
        date_modified: getValueCaseInsensitive(jsonLd, 'dateModified') || getValueCaseInsensitive(job, 'modified_time'),
        job_reference_id: jobReferenceId,
        is_sponsored: getValueCaseInsensitive(detail, 'isSponsored') ?? getValueCaseInsensitive(job, 'isSponsored'),
        is_backfilled: getValueCaseInsensitive(detail, 'isBackfilled') ?? getValueCaseInsensitive(job, 'isBackfilled'),
        can_view_local: getValueCaseInsensitive(detail, 'canViewLocal') ?? getValueCaseInsensitive(job, 'canViewLocal'),
        omitted: getValueCaseInsensitive(job, 'omitted'),
        cant_see_content: getValueCaseInsensitive(detail, 'cantSeeContent') ?? getValueCaseInsensitive(job, 'cantSeeContent'),
        display_logo: getValueCaseInsensitive(job, 'display_logo'),
        short_description: shortDesc,
        description_html: descriptionHtml,
        description_text: descriptionText,
        badge: getValueCaseInsensitive(detail, 'badge') || getValueCaseInsensitive(job, 'badge'),
        epp: getValueCaseInsensitive(detail, 'epp') || getValueCaseInsensitive(job, 'epp'),
        source: BASE,
    });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch with exponential-backoff retry.
 * Only sleeps on 429 / 5xx — not on successful responses.
 */
async function fetchWithRetry(clientManager, url, options = {}, maxRetries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await check429Cooldown();

            const client = await clientManager.getClient(attempt > 1);
            const res = await client.fetch(url, options);

            if (res.status === 429) {
                last429Time = Date.now();
                if (attempt < maxRetries) {
                    const wait = 5000 * attempt + Math.random() * 2000;
                    log.warning(`Rate limited (429) on ${url}, waiting ${Math.round(wait)}ms before retry ${attempt}`);
                    await sleep(wait);
                    continue;
                }
            }

            if (res.status >= 500 && attempt < maxRetries) {
                const wait = 2000 * attempt + Math.random() * 1000;
                log.debug(`Server error (${res.status}), retrying in ${wait}ms`);
                await sleep(wait);
                continue;
            }

            return res;
        } catch (err) {
            lastErr = err;
            const msg = err.message || '';
            if (
                (msg.includes('595') || msg.includes('ECONNRESET') || msg.includes('proxy') || msg.includes('socket') || msg.includes('fetch')) &&
                attempt < maxRetries
            ) {
                log.debug(`Network/proxy error, retry ${attempt}/${maxRetries}`);
                await sleep(500 * attempt);
                continue;
            }
            if (attempt >= maxRetries) throw err;
        }
    }
    throw lastErr || new Error(`All ${maxRetries} retries failed for ${url}`);
}

/**
 * Concurrency-limited parallel map.
 * Keeps at most `limit` promises in-flight at once, preserving order.
 */
async function pMap(items, fn, limit) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await fn(items[index], index);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results;
}

// ─── Core scraping pipeline ───────────────────────────────────────────────────

/**
 * Fetch one list page and return { data, hasNext }.
 */
async function fetchListPage(clientManager, endpoint, searchParams, page) {
    const qs = new URLSearchParams({ ...searchParams, page: String(page) }).toString();
    const url = `${endpoint}?${qs}`;

    try {
        const res = await fetchWithRetry(clientManager, url, {}, 5);
        if (!res || res.status >= 400) {
            log.warning(`List API HTTP ${res?.status ?? 'unknown'} on page ${page}`);
            return { data: [], hasNext: false, error: true };
        }

        const body = await res.text();
        const json = safeJson(body);

        if (!json || typeof json !== 'object') {
            log.warning(`Non-JSON response on page ${page}`);
            return { data: [], hasNext: false, error: true };
        }

        const dataKey = Object.keys(json).find(k => k.toLowerCase() === 'data');
        const data = dataKey && Array.isArray(json[dataKey]) ? json[dataKey] : [];

        const linksKey = Object.keys(json).find(k => k.toLowerCase() === 'links');
        const links = linksKey ? json[linksKey] : null;
        const nextKey = links ? Object.keys(links).find(k => k.toLowerCase() === 'next') : null;
        const hasNext = nextKey ? Boolean(links[nextKey]) : false;

        return { data, hasNext, error: false };
    } catch (err) {
        log.warning(`Failed to fetch page ${page}: ${err.message}`);
        return { data: [], hasNext: false, error: true };
    }
}

/**
 * Fetch one job detail and return the merged record.
 */
async function fetchJobDetail(clientManager, job) {
    const jobId = getValueCaseInsensitive(job, 'id');
    if (jobId == null) {
        return mapApiJob(job, {});
    }
    try {
        const res = await fetchWithRetry(clientManager, `${BASE}/api/v1/jobs/${jobId}`, {}, 2);
        if (res && res.status < 400) {
            const body = await res.text();
            const detailJson = safeJson(body);
            const dataKey = detailJson ? Object.keys(detailJson).find(k => k.toLowerCase() === 'data') : null;
            const detail = dataKey ? detailJson[dataKey] : {};
            return mapApiJob(job, detail || {});
        }
    } catch (err) {
        log.debug(`Detail fetch failed for job ${jobId}: ${err.message}`);
    }
    return mapApiJob(job, {});
}

async function collectFromApi({
    searchParams,
    maxPages,
    resultsWanted,
    seen,
    dataset,
    clientManager,
}) {
    let saved = 0;
    let page = 1;
    const endpoint = `${BASE}/api/v1/jobs`;

    // Prefetch page 1 immediately
    let nextPagePromise = fetchListPage(clientManager, endpoint, searchParams, page).catch((err) => {
        log.warning(`Failed to fetch page ${page}: ${err.message}`);
        return { data: [], hasNext: false, error: true };
    });

    while (saved < resultsWanted && page <= maxPages) {
        // Await the already-in-flight list request
        const { data, hasNext, error } = await nextPagePromise;

        if (!data.length) {
            if (error) {
                log.warning(`Page ${page} failed with error. Skipping to next page.`);
                const isLastPage = page >= maxPages;
                if (!isLastPage && saved < resultsWanted) {
                    const nextPage = page + 1;
                    nextPagePromise = fetchListPage(clientManager, endpoint, searchParams, nextPage).catch((err) => {
                        log.warning(`Failed to prefetch page ${nextPage}: ${err.message}`);
                        return { data: [], hasNext: false, error: true };
                    });
                }
                page += 1;
                continue;
            } else {
                log.info(`Page ${page}: no jobs found — stopping`);
                break;
            }
        }

        // ── Kick off next page fetch in parallel with detail fetches ──────────
        const isLastPage = !hasNext || page >= maxPages;
        if (!isLastPage && saved + data.length < resultsWanted) {
            const nextPage = page + 1;
            nextPagePromise = fetchListPage(clientManager, endpoint, searchParams, nextPage).catch((err) => {
                log.warning(`Failed to prefetch page ${nextPage}: ${err.message}`);
                return { data: [], hasNext: false, error: true };
            });
        }

        log.info(`Page ${page}: enriching ${data.length} jobs (concurrency=${DETAIL_CONCURRENCY})`);

        // ── Fetch job details with bounded concurrency ────────────────────────
        const results = await pMap(
            data,
            async (job, index) => {
                try {
                    if (!Actor.isAtHome()) {
                        // Stagger only the initial concurrent burst of requests by spacing them slightly
                        const staggerIndex = index % DETAIL_CONCURRENCY;
                        await sleep(staggerIndex * 250 + Math.random() * 150);
                    }
                    return await fetchJobDetail(clientManager, job);
                } catch (err) {
                    log.warning(`Failed to process job ${getValueCaseInsensitive(job, 'id') ?? 'unknown'}: ${err.message}`);
                    return mapApiJob(job, {});
                }
            },
            DETAIL_CONCURRENCY,
        );

        // ── Dedup + cap ───────────────────────────────────────────────────────
        const uniqueBatch = [];
        for (const item of results) {
            if (saved >= resultsWanted) break;
            const key = buildDedupKey(item);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            uniqueBatch.push(item);
            saved += 1;
        }

        if (uniqueBatch.length) {
            try {
                await dataset.pushData(uniqueBatch);
                log.info(`Page ${page}: saved ${uniqueBatch.length} jobs — total ${saved}/${resultsWanted}`);
            } catch (err) {
                log.error(`Failed to push data to dataset: ${err.message}`);
            }
        }

        if (isLastPage || saved >= resultsWanted) break;
        page += 1;
    }

    return saved;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};

    const {
        results_wanted: RESULTS_WANTED_RAW = 50,
        max_pages: MAX_PAGES_RAW = 5,
        proxyConfiguration,
    } = input;

    let {
        startUrl = '',
        keywords = '',
        location = '',
    } = input;

    // Clean and normalize inputs
    if (typeof startUrl === 'string') {
        startUrl = startUrl.trim();
        if (startUrl && !/^https?:\/\//i.test(startUrl)) {
            startUrl = `https://${startUrl}`;
        }
    } else {
        startUrl = '';
    }

    if (typeof keywords === 'string') {
        keywords = normalizeSpace(keywords);
    } else {
        keywords = '';
    }

    if (typeof location === 'string') {
        location = normalizeSpace(location);
    } else {
        location = '';
    }

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
        ? Math.max(1, +RESULTS_WANTED_RAW) : 50;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
        ? Math.max(1, +MAX_PAGES_RAW) : 5;

    log.info(`Scraper started — target: ${RESULTS_WANTED} jobs, max ${MAX_PAGES} pages`);

    const dataset = await Dataset.open();

    const isCloud = Actor.isAtHome();
    let proxyConf;
    try {
        if (proxyConfiguration) {
            proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
        } else if (isCloud) {
            proxyConf = await Actor.createProxyConfiguration({ useApifyProxy: true });
        }
    } catch (err) {
        log.warning(`Proxy configuration failed: ${err.message}. Proceeding without proxy.`);
    }

    const clientManager = new ClientManager(proxyConf);

    const seen = new Set();

    const searchParams = buildSearchParams({ startUrl, keywords, location });

    const start = Date.now();
    const totalSaved = await collectFromApi({
        searchParams,
        maxPages: MAX_PAGES,
        resultsWanted: RESULTS_WANTED,
        seen,
        dataset,
        clientManager,
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log.info(`Done — scraped ${totalSaved} jobs in ${elapsed}s`);
});
