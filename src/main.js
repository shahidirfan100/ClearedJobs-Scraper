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

// Sleep utility function
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

function mapApiJob(job, detail = {}) {
    const id = job.id ?? detail.id ?? null;
    let url = job.url || detail.url || (id ? `${BASE}/job/${id}` : null);
    if (url) url = new URL(url, BASE).href;

    // Extract description from API
    const descriptionHtml = detail.description || job.description || null;

    // Extract from JSON-LD if available
    const jsonLd = detail.jsonLd || {};

    // Extract from customBlockBottom for security clearance
    const customBlocks = detail.customBlockBottom || detail.customBlockList || [];
    const clearanceFromBlocks = extractFromBlocks(customBlocks, 'Security Clearance');

    // Extract location - prioritize API fields
    const location = normalizeSpace(
        detail.location ||
        job.location ||
        jsonLd.jobLocation?.address?.addressLocality ||
        jsonLd.jobLocation?.address?.addressRegion ||
        ''
    );

    // Extract salary
    const salary = detail.salary ||
        job.salary ||
        jsonLd.baseSalary?.value?.value ||
        null;

    // Extract security clearance
    const security_clearance = clearanceFromBlocks ||
        detail.security_clearance ||
        job.security_clearance ||
        jsonLd.industry ||
        null;

    // Extract job type
    const job_type = detail.position_type ||
        detail.job_type ||
        detail.employment_type ||
        job.position_type ||
        job.job_type ||
        (Array.isArray(jsonLd.employmentType) ? jsonLd.employmentType.join(', ') : jsonLd.employmentType) ||
        null;

    return {
        id,
        url: url || null,
        title: normalizeSpace(job.title || job.job_title || jsonLd.title || ''),
        company: normalizeSpace(job.company?.name || job.company || detail.company?.name || jsonLd.hiringOrganization?.name || ''),
        location,
        security_clearance,
        salary: salary ? String(salary) : null,
        job_type,
        date_posted: job.posted_date || job.modified_time || job.created_at || detail.time || jsonLd.datePosted || null,
        description_html: descriptionHtml,
        description_text: descriptionHtml
            ? normalizeSpace(cheerio.load(descriptionHtml).text())
            : job.shortDescription
                ? normalizeSpace(job.shortDescription)
                : jsonLd.description
                    ? normalizeSpace(jsonLd.description)
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

        log.info(`Page ${page}: found ${data.length} jobs`);

        // Maximum concurrency for speed - API can handle it!
        const CONCURRENCY = 25;
        const batch = [...data];

        while (batch.length && saved < resultsWanted) {
            const chunk = batch.splice(0, CONCURRENCY);

            // Fetch all details in parallel - NO delays between requests
            const results = await Promise.all(
                chunk.map(async (job) => {
                    try {
                        const detailRes = await gotScraping({
                            url: `${BASE}/api/v1/jobs/${job.id}`,
                            headers: getStealthHeaders(),
                            throwHttpErrors: false,
                            proxyUrl: await getProxyUrl(),
                        });

                        if (detailRes.statusCode < 400) {
                            const detailJson = safeJsonParse(detailRes.body, {});
                            const detail = detailJson?.data || {};
                            return mapApiJob(job, detail);
                        }

                        return mapApiJob(job, {});
                    } catch (err) {
                        log.debug(`Failed to fetch detail for job ${job.id}: ${err.message}`);
                        return mapApiJob(job, {});
                    }
                })
            );

            // Save all results from this batch
            for (const item of results) {
                if (saved >= resultsWanted) break;
                const key = item.url || item.id || JSON.stringify(item);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                await dataset.pushData(item);
                saved += 1;
            }
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
