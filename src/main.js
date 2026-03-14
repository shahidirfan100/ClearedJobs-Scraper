import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';
import { HeaderGenerator } from 'header-generator';

const BASE = 'https://clearedjobs.net';

// Production-ready header generator for stealth
const headerGenerator = new HeaderGenerator({
    browsers: [
        { name: 'chrome', minVersion: 120, maxVersion: 130 },
        { name: 'firefox', minVersion: 115, maxVersion: 125 }
    ],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
    locales: ['en-US'],
});

// Generate fresh stealth headers
function getStealthHeaders() {
    const headers = headerGenerator.getHeaders();
    return {
        ...headers,
        'sec-ch-ua': '"Chromium";v="122", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'accept': 'application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'max-age=0',
        'upgrade-insecure-requests': '1',
    };
}

// Sleep utility
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSpace(text = '') {
    return text.replace(/\s+/g, ' ').trim();
}

function safeJsonParse(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeUrl(value) {
    if (!value) return null;
    try {
        const parsed = new URL(value, BASE);
        parsed.hash = '';
        parsed.searchParams.delete('ref');
        return parsed.href;
    } catch {
        return null;
    }
}

function compactValue(value) {
    if (value === null || value === undefined) return undefined;

    if (typeof value === 'string') {
        const normalized = normalizeSpace(value);
        return normalized ? normalized : undefined;
    }

    if (Array.isArray(value)) {
        const cleaned = value
            .map((entry) => compactValue(entry))
            .filter((entry) => entry !== undefined);
        return cleaned.length ? cleaned : undefined;
    }

    if (typeof value === 'object') {
        const cleaned = {};
        for (const [key, entry] of Object.entries(value)) {
            const compacted = compactValue(entry);
            if (compacted !== undefined) cleaned[key] = compacted;
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
        const parsed = safeJsonParse(input, {});
        if (Array.isArray(parsed)) {
            return parsed.find((entry) => entry && typeof entry === 'object') || {};
        }
        return parsed && typeof parsed === 'object' ? parsed : {};
    }

    if (Array.isArray(input)) {
        return input.find((entry) => entry && typeof entry === 'object') || {};
    }

    return typeof input === 'object' ? input : {};
}

function extractFromBlocks(blocks, label) {
    if (!Array.isArray(blocks)) return null;
    const target = normalizeSpace(label || '').toLowerCase();
    const block = blocks.find(
        (b) =>
            normalizeSpace(b?.label || '').toLowerCase() === target ||
            normalizeSpace(b?.title || '').toLowerCase() === target
    );
    return block?.value ? normalizeSpace(block.value) : null;
}

function buildDedupKey(item) {
    if (item?.id !== null && item?.id !== undefined) {
        return `id:${String(item.id)}`;
    }

    const normalizedItemUrl = normalizeUrl(item?.url);
    if (normalizedItemUrl) {
        return `url:${normalizedItemUrl.toLowerCase()}`;
    }

    const title = normalizeSpace(item?.title || '').toLowerCase();
    const company = normalizeSpace(item?.company || '').toLowerCase();
    const location = normalizeSpace(item?.location || '').toLowerCase();
    if (title || company || location) {
        return `tcl:${title}|${company}|${location}`;
    }

    return null;
}

function buildSearchParams({ startUrl, keywords, location, sort, remote }) {
    const params = {
        locale: 'en',
        sort,
        keywords,
    };

    if (location) {
        params.city_state_zip = location;
    }

    if (remote === 'remote' || remote === 'hybrid') {
        params.location_remote_option_filter = remote;
    }

    if (!startUrl) return params;

    try {
        const parsed = new URL(startUrl, BASE);
        const sp = parsed.searchParams;

        if (sp.has('keywords')) params.keywords = sp.get('keywords') || '';
        if (sp.has('city_state_zip')) params.city_state_zip = sp.get('city_state_zip') || '';
        if (sp.has('sort')) params.sort = sp.get('sort') || params.sort;
        if (sp.has('locale')) params.locale = sp.get('locale') || params.locale;
        if (sp.has('location_remote_option_filter')) {
            params.location_remote_option_filter = sp.get('location_remote_option_filter') || '';
        }
    } catch (err) {
        log.warning(`Invalid startUrl provided, using filter params instead: ${err.message}`);
    }

    return params;
}

function mapApiJob(job, detail = {}) {
    const id = job.id ?? detail.id ?? null;
    const url = normalizeUrl(job.url || detail.url || (id ? `${BASE}/job/${id}` : null));

    const descriptionHtml = detail.description || job.description || null;
    const jsonLd = parseJsonLd(detail.jsonLd || job.jsonLd);
    const customBlocks = [
        ...(Array.isArray(detail.customBlockBottom) ? detail.customBlockBottom : []),
        ...(Array.isArray(detail.customBlockTop) ? detail.customBlockTop : []),
        ...(Array.isArray(job.customBlockList) ? job.customBlockList : []),
    ];
    const clearanceFromBlocks = extractFromBlocks(customBlocks, 'Security Clearance');
    const postedFromBlocks = extractFromBlocks(customBlocks, 'Posted');
    const jobReferenceId = extractFromBlocks(customBlocks, 'Job Reference ID');

    const location = normalizeSpace(
        detail.location ||
        job.location ||
        jsonLd.jobLocation?.address?.addressLocality ||
        jsonLd.jobLocation?.address?.addressRegion ||
        ''
    );

    const salary = detail.salary || job.salary || jsonLd.baseSalary?.value?.value || null;
    const companyRaw = detail.company || job.company || null;
    const companyName = normalizeSpace(
        (typeof companyRaw === 'object' ? companyRaw?.name : companyRaw) ||
        jsonLd.hiringOrganization?.name ||
        ''
    );

    const security_clearance = clearanceFromBlocks ||
        detail.security_clearance ||
        job.security_clearance ||
        jsonLd.industry ||
        null;

    const employmentType = detail.positionType ||
        detail.position_type ||
        detail.job_type ||
        detail.employment_type ||
        job.positionType ||
        job.position_type ||
        job.job_type ||
        (Array.isArray(jsonLd.employmentType) ? jsonLd.employmentType.join(', ') : jsonLd.employmentType) ||
        null;

    return compactRecord({
        id,
        url,
        title: normalizeSpace(job.title || job.job_title || jsonLd.title || ''),
        company: companyName,
        company_details: typeof companyRaw === 'object' ? companyRaw : undefined,
        location,
        coordinates: detail.coordinates || job.coordinates,
        address: detail.address,
        security_clearance,
        salary: salary ? String(salary) : undefined,
        job_type: employmentType,
        experience: detail.experience,
        education: detail.education,
        posted_date: postedFromBlocks || job.posted_date,
        modified_time: job.modified_time,
        date_posted: job.posted_date || job.modified_time || job.created_at || detail.time || jsonLd.datePosted || null,
        date_modified: jsonLd.dateModified || job.modified_time,
        job_reference_id: jobReferenceId,
        is_sponsored: detail.isSponsored ?? job.isSponsored,
        is_backfilled: detail.isBackfilled ?? job.isBackfilled,
        can_view_local: detail.canViewLocal ?? job.canViewLocal,
        omitted: job.omitted,
        cant_see_content: detail.cantSeeContent ?? job.cantSeeContent,
        display_logo: job.display_logo,
        short_description: job.shortDescription,
        description_html: descriptionHtml,
        description_text: descriptionHtml
            ? normalizeSpace(cheerio.load(descriptionHtml).text())
            : job.shortDescription
                ? normalizeSpace(job.shortDescription)
                : jsonLd.description
                    ? normalizeSpace(jsonLd.description)
                    : undefined,
        badge: detail.badge || job.badge,
        epp: detail.epp || job.epp,
        source: BASE,
    });
}

// Retry wrapper for API requests
async function fetchWithRetry(url, options, getProxyUrl, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const res = await gotScraping({
                url,
                headers: getStealthHeaders(),
                throwHttpErrors: false,
                proxyUrl: await getProxyUrl(),
                ...options,
            });

            if (res.statusCode < 400) {
                return res;
            }

            if (res.statusCode >= 500 && attempt < maxRetries) {
                log.debug(`HTTP ${res.statusCode}, retry ${attempt}/${maxRetries}`);
                await sleep(500 * attempt);
                continue;
            }

            return res;
        } catch (err) {
            const msg = err.message || '';
            if ((msg.includes('595') || msg.includes('ECONNRESET') || msg.includes('proxy')) && attempt < maxRetries) {
                log.debug(`Proxy error, retry ${attempt}/${maxRetries}`);
                await sleep(500 * attempt);
                continue;
            }
            if (attempt >= maxRetries) throw err;
        }
    }
}

async function collectFromApi({
    searchParams,
    maxPages,
    resultsWanted,
    seen,
    dataset,
    getProxyUrl,
}) {
    let saved = 0;
    let page = 1;
    const endpoint = `${BASE}/api/v1/jobs`;

    while (saved < resultsWanted && page <= maxPages) {
        const params = { ...searchParams, page };

        let json;
        try {
            const res = await fetchWithRetry(endpoint, { searchParams: params }, getProxyUrl, 5);

            if (!res || res.statusCode >= 400) {
                log.warning(`API HTTP ${res?.statusCode || 'unknown'} on page ${page}`);
                // Try next page instead of breaking
                page += 1;
                continue;
            }

            json = safeJsonParse(res.body);

            if (!json || typeof json !== 'object') {
                log.warning(`API non-JSON response on page ${page}`);
                page += 1;
                continue;
            }
        } catch (err) {
            log.warning(`API request failed page=${page}: ${err.message}`);
            // Try next page instead of breaking
            page += 1;
            continue;
        }

        const data = Array.isArray(json?.data) ? json.data : [];
        if (!data.length) {
            log.info(`Page ${page}: no jobs found`);
            break;
        }

        log.info(`Page ${page}: fetching details for ${data.length} jobs`);

        // Fetch all job details in parallel
        const results = await Promise.all(
            data.map(async (job) => {
                try {
                    const detailRes = await fetchWithRetry(
                        `${BASE}/api/v1/jobs/${job.id}`,
                        {},
                        getProxyUrl,
                        2
                    );

                    if (detailRes && detailRes.statusCode < 400) {
                        const detailJson = safeJsonParse(detailRes.body, {});
                        const detail = detailJson?.data || {};
                        return mapApiJob(job, detail);
                    }

                    return mapApiJob(job, {});
                } catch (err) {
                    log.debug(`Failed detail for job ${job.id}`);
                    return mapApiJob(job, {});
                }
            })
        );

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
            await dataset.pushData(uniqueBatch);
        }

        log.info(`Progress: ${saved}/${resultsWanted} jobs collected`);

        const nextLink = json?.links?.next || null;
        if (!nextLink || page >= maxPages) break;

        page += 1;
    }

    return saved;
}

await Actor.main(async () => {
    const input = await Actor.getInput() || {};

    const {
        startUrl = '',
        keywords = '',
        location = '',
        sort = 'date',
        remote = '',
        results_wanted: RESULTS_WANTED_RAW = 50,
        max_pages: MAX_PAGES_RAW = 5,
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
        ? Math.max(1, +RESULTS_WANTED_RAW)
        : 50;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 5;

    log.info(`Scraper started - target: ${RESULTS_WANTED} jobs, max ${MAX_PAGES} pages`);

    const dataset = await Dataset.open();
    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : await Actor.createProxyConfiguration({ useApifyProxy: true });

    if (!proxyConf) {
        log.warning('Proxy configuration failed. Running without proxy.');
    }

    const getProxyUrl = async () => proxyConf ? await proxyConf.newUrl() : undefined;

    const seen = new Set();

    const searchParams = buildSearchParams({
        startUrl,
        keywords,
        location,
        sort,
        remote,
    });

    const totalSaved = await collectFromApi({
        searchParams,
        maxPages: MAX_PAGES,
        resultsWanted: RESULTS_WANTED,
        seen,
        dataset,
        getProxyUrl,
    });

    log.info(`Done - scraped ${totalSaved} jobs`);
});
