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
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'max-age=0',
        'upgrade-insecure-requests': '1',
    };
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

function mapApiJob(job) {
    const id = job.id || null;
    let url = job.url || (id ? `${BASE}/job/${id}` : null);
    if (url) url = new URL(url, BASE).href;

    // Extract data directly from listing API
    const description = job.description || job.shortDescription || job.body || null;

    return {
        id,
        url: url || null,
        title: normalizeSpace(job.title || job.job_title || ''),
        company: normalizeSpace(job.company?.name || job.company || ''),
        location: normalizeSpace(job.location || ''),
        security_clearance: job.security_clearance || job.clearance || null,
        salary: job.salary || job.salary_min || job.salary_max || null,
        job_type: job.job_type || job.position_type || job.employment_type || null,
        date_posted: job.posted_date || job.modified_time || job.created_at || job.date || null,
        description_html: description,
        description_text: description
            ? normalizeSpace(cheerio.load(description).text())
            : null,
    };
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
        const headers = getStealthHeaders();

        let json;
        try {
            const res = await gotScraping({
                url: endpoint,
                headers,
                searchParams: params,
                throwHttpErrors: false,
                proxyUrl: await getProxyUrl(),
            });

            if (res.statusCode >= 400) {
                log.warning(`API HTTP ${res.statusCode} on page ${page}`);
                break;
            }

            json = safeJsonParse(res.body);

            if (!json || typeof json !== 'object') {
                log.warning(`API non-JSON response on page ${page}`);
                break;
            }
        } catch (err) {
            log.warning(`API request failed page=${page}: ${err.message}`);
            break;
        }

        const data = Array.isArray(json?.data) ? json.data : [];
        if (!data.length) {
            log.info(`Page ${page}: no jobs found`);
            break;
        }

        log.info(`Page ${page}: processing ${data.length} jobs`);

        // Process all jobs from listing API directly - NO detail API calls!
        for (const job of data) {
            if (saved >= resultsWanted) break;

            const item = mapApiJob(job);
            const key = item.url || item.id || JSON.stringify(item);

            if (!key || seen.has(key)) continue;

            seen.add(key);
            await dataset.pushData(item);
            saved += 1;
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

    // Proxy rotation function
    const getProxyUrl = async () => proxyConf ? await proxyConf.newUrl() : undefined;

    const seen = new Set();

    // Build search params
    const searchParams = {
        locale: 'en',
        sort,
        keywords,
    };

    // Add location if provided
    if (location) {
        searchParams.city_state_zip = location;
    }

    // Add remote filter if provided
    if (remote === 'remote') searchParams.location_remote_option_filter = 'remote';
    if (remote === 'hybrid') searchParams.location_remote_option_filter = 'hybrid';

    // Collect from API
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
