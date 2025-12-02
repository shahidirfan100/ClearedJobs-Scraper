import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

const BASE = 'https://clearedjobs.net';
const DEFAULT_HEADERS = {
    'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    accept: 'application/json, text/plain, */*',
    referer: `${BASE}/jobs`,
    'x-requested-with': 'XMLHttpRequest',
};

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

function buildRouteResolver(html) {
    const routeMatch = html.match(/namedRoutes:\s*({.*?}),\s*baseUrl:/s);
    if (!routeMatch) return {};
    const raw = routeMatch[1];
    const routes = safeJsonParse(raw, {});

    const make = (name) => {
        const def = routes?.[name];
        if (!def) return null;
        return (params = {}) => {
            let path = def.uri;
            path = path.replace(/\{([^}?]+)\??\}/g, (_, key) =>
                params[key] !== undefined && params[key] !== null
                    ? encodeURIComponent(String(params[key]))
                    : ''
            );
            return `${BASE}/${path}`;
        };
    };

    return {
        index: make('api.jobs.index') || (() => `${BASE}/api/v1/jobs`),
        sponsored: make('api.jobs.sponsored') || (() => `${BASE}/api/v1/jobs/sponsored`),
        show: make('api.jobs.show') || (({ job }) => `${BASE}/api/v1/jobs/${job}`),
        additional:
            make('api.jobs.additional') ||
            (({ job }) => `${BASE}/api/v1/jobs/${job}/additional`),
    };
}

function extractCsrf(html) {
    const match = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
    return match ? match[1] : null;
}

function extractFromBlocks(job, label) {
    const blocks = job?.customBlockList || job?.customBlocklist || [];
    const target = normalizeSpace(label || '').toLowerCase();
    const block = blocks.find(
        (b) =>
            normalizeSpace(b?.label || '').toLowerCase() === target ||
            normalizeSpace(b?.title || '').toLowerCase() === target
    );
    return block?.value || null;
}

function extractClearance(job) {
    return (
        extractFromBlocks(job, 'Security Clearance') ||
        job.security_clearance ||
        job.job_type ||
        null
    );
}

function extractJobType(job, detail, additional) {
    return (
        detail.position_type ||
        detail.positionType ||
        detail.job_type ||
        detail.employment_type ||
        additional.position_type ||
        additional.positionType ||
        additional.job_type ||
        additional.employment_type ||
        job.position_type ||
        job.positionType ||
        job.job_type ||
        extractFromBlocks(job, 'Job Type') ||
        null
    );
}

function mapApiJob(job, detail = {}, additional = {}, source = 'api') {
    const url = job.url ? new URL(job.url, BASE).href : `${BASE}/job/${job.id}`;
    const descriptionHtml =
        detail.description ||
        detail.body ||
        job.description ||
        job.body ||
        additional.description ||
        null;
    const salary =
        detail.salary ||
        detail.salary_min ||
        detail.salary_max ||
        additional.salary ||
        additional.salary_min ||
        additional.salary_max ||
        job.salary ||
        job.salary_min ||
        job.salary_max ||
        extractFromBlocks(job, 'Salary') ||
        null;
    const clearance =
        detail.security_clearance ||
        additional.security_clearance ||
        extractClearance(job) ||
        job.job_type ||
        job.security_clearance ||
        null;

    return {
        source,
        id: job.id ?? null,
        url,
        title: normalizeSpace(job.title || job.job_title || ''),
        company: normalizeSpace(job.company?.name || job.company || ''),
        location: normalizeSpace(
            job.location ||
                detail.location ||
                additional.location ||
                extractFromBlocks(job, 'Location') ||
                ''
        ),
        security_clearance: clearance || null,
        salary: salary || null,
        job_type: extractJobType(job, detail, additional),
        date_posted: job.posted_date || job.modified_time || job.created_at || null,
        description_html: descriptionHtml,
        description_text: descriptionHtml
            ? normalizeSpace(cheerio.load(descriptionHtml).text())
            : job.shortDescription
              ? normalizeSpace(job.shortDescription)
              : null,
    };
}

function mapJsonLdJob(ld) {
    const url = ld.url ? new URL(ld.url, BASE).href : null;
    return {
        source: 'jsonld',
        id: ld.identifier || null,
        url,
        title: normalizeSpace(ld.title || ''),
        company: normalizeSpace(ld.hiringOrganization?.name || ''),
        location: normalizeSpace(
            ld.jobLocation?.address?.addressLocality
                ? `${ld.jobLocation.address.addressLocality}, ${
                      ld.jobLocation.address.addressRegion || ''
                  }`.trim()
                : ld.jobLocation?.address?.addressRegion || ''
        ),
        security_clearance: ld.securityClearanceRequirement || null,
        salary:
            ld.baseSalary?.value?.value && ld.baseSalary?.value?.currency
                ? `${ld.baseSalary.value.value} ${ld.baseSalary.value.currency}`
                : null,
        job_type: Array.isArray(ld.employmentType)
            ? ld.employmentType.join(', ')
            : ld.employmentType || null,
        date_posted: ld.datePosted || null,
        description_html: ld.description || null,
        description_text: ld.description ? normalizeSpace(cheerio.load(ld.description).text()) : null,
    };
}

async function fetchJobPage(url, clientOpts) {
    const res = await gotScraping({
        url,
        headers: DEFAULT_HEADERS,
        throwHttpErrors: false,
        ...clientOpts,
    });

    if (res.statusCode >= 400) {
        log.warning(`Job page blocked (${res.statusCode}) for ${url}`);
        return null;
    }

    const $ = cheerio.load(res.body);
    const ldScript = $('script[type="application/ld+json"]').first().text();
    if (ldScript) {
        const ld = safeJsonParse(ldScript);
        if (ld && ld['@type'] === 'JobPosting') return mapJsonLdJob(ld);
    }

    const title = normalizeSpace($('h1').first().text());
    const company = normalizeSpace($('.company,.employer').first().text());
    const location = normalizeSpace($('.location').first().text());
    const descHtml = $('main, .job-description').first().html() || null;
    const descText = descHtml ? normalizeSpace(cheerio.load(descHtml).text()) : null;

    return {
        source: 'html',
        url,
        title,
        company,
        location,
        description_html: descHtml,
        description_text: descText,
    };
}

async function collectFromApi({
    routes,
    csrfToken,
    searchParams,
    maxPages,
    resultsWanted,
    seen,
    dataset,
    clientOpts,
}) {
    let saved = 0;
    let page = 1;
    const indexFn = typeof routes.index === 'function' ? routes.index : () => `${BASE}/api/v1/jobs`;
    let endpoint = indexFn();
    const headers = {
        ...DEFAULT_HEADERS,
        'x-csrf-token': csrfToken || '',
    };

    async function fetchDetails(jobId) {
        const results = { detail: {}, additional: {} };
        try {
            const res = await gotScraping({
                url: routes.show({ job: jobId }),
                headers,
                throwHttpErrors: false,
                ...clientOpts,
            });
            if (res.statusCode < 400) {
                const json = safeJsonParse(res.body, {});
                results.detail = json?.data || json || {};
            }
        } catch (err) {
            log.debug?.(`Job detail fetch failed for ${jobId}: ${err.message}`);
        }

        try {
            const res = await gotScraping({
                url: routes.additional({ job: jobId }),
                headers,
                throwHttpErrors: false,
                ...clientOpts,
            });
            if (res.statusCode < 400) {
                const json = safeJsonParse(res.body, {});
                results.additional = json?.data || json || {};
            }
        } catch (err) {
            log.debug?.(`Job additional fetch failed for ${jobId}: ${err.message}`);
        }

        return results;
    }

    while (saved < resultsWanted && page <= maxPages) {
        const params = { ...searchParams, page };
        let json;
        let attempt = 0;
        while (attempt < 3 && !json) {
            attempt += 1;
            try {
                const res = await gotScraping({
                    url: endpoint,
                    headers,
                    searchParams: params,
                    throwHttpErrors: false,
                    ...clientOpts,
                });
                const contentType = res.headers['content-type'] || '';
                if (res.statusCode >= 500) {
                    log.warning(`API ${res.statusCode} on page ${page}, retry ${attempt}`);
                    await Actor.sleep(1500 * attempt);
                    continue;
                }
                json = safeJsonParse(res.body);

                if (!json || typeof json !== 'object') {
                    log.warning(
                        `API non-JSON response (ct=${contentType}) page=${page}, snippet=${res.body?.slice?.(
                            0,
                            200
                        ) || ''}`
                    );
                    break;
                }
            } catch (err) {
                log.warning(`API request failed page=${page} (attempt ${attempt}): ${err.message}`);
                await Actor.sleep(1000 * attempt);
            }
        }

        if (!json || typeof json !== 'object') break;

        const data = Array.isArray(json?.data)
            ? json.data
            : Array.isArray(json?.jobs)
              ? json.jobs
              : [];
        if (!data.length) {
            log.warning(
                `API returned no jobs on page ${page} (keys=${Object.keys(json || {}).join(',')})`
            );
            break;
        }

        log.info(`API page ${page}: received ${data.length} jobs`);
        for (const job of data) {
            if (saved >= resultsWanted) break;
            const { detail, additional } = await fetchDetails(job.id);
            const item = mapApiJob(job, detail, additional, 'api');
            if ((!item.description_html || !item.description_text) && item.url && !seen.has(item.url)) {
                const htmlItem = await fetchJobPage(item.url, clientOpts);
                if (htmlItem) {
                    item.description_html = item.description_html || htmlItem.description_html;
                    item.description_text = item.description_text || htmlItem.description_text;
                }
            }
            const key = item.url || item.id || JSON.stringify(job);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            await dataset.pushData(item);
            saved += 1;
        }

        const nextLink = json?.links?.next || null;
        if (!nextLink) break;
        page += 1;
        endpoint = nextLink.startsWith('http') ? nextLink : endpoint;
    }

    return saved;
}

async function collectFromSitemaps({ resultsWanted, seen, dataset, clientOpts }) {
    let saved = 0;
    const indexUrl = `${BASE}/sitemap.xml`;
    let sitemapList = [];
    try {
        const res = await gotScraping({ url: indexUrl, headers: DEFAULT_HEADERS, ...clientOpts });
        sitemapList = [...res.body.matchAll(/<loc>([^<]+sitemap_[^<]+\.xml)<\/loc>/g)].map(
            (m) => m[1]
        );
    } catch (err) {
        log.warning(`Failed to fetch sitemap index: ${err.message}`);
        return saved;
    }

    const jobSitemaps = sitemapList.filter((u) => u.includes('sitemap_active_jobs'));
    if (!jobSitemaps.length) {
        log.warning('No job sitemaps discovered in sitemap index.');
        return saved;
    }

    const urls = [];
    for (const sm of jobSitemaps) {
        if (urls.length >= resultsWanted * 2) break;
        try {
            const res = await gotScraping({
                url: sm,
                headers: DEFAULT_HEADERS,
                throwHttpErrors: false,
                ...clientOpts,
            });
            if (res.statusCode >= 400) {
                log.warning(`Sitemap ${sm} blocked (${res.statusCode})`);
                continue;
            }
            urls.push(
                ...[...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).slice(0, resultsWanted)
            );
        } catch (err) {
            log.warning(`Failed to fetch sitemap ${sm}: ${err.message}`);
        }
    }
    log.info(`Sitemap seed URLs: ${urls.length}`);

    for (const url of urls) {
        if (saved >= resultsWanted) break;
        if (seen.has(url)) continue;
        try {
            const item = await fetchJobPage(url, clientOpts);
            if (!item) continue;
            await dataset.pushData(item);
            seen.add(url);
            saved += 1;
            log.info(`Saved from sitemap/html: ${item.title || url}`);
        } catch (err) {
            log.warning(`Failed to parse job ${url}: ${err.message}`);
        }
    }

    return saved;
}

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    keywords = '',
    location = '',
    city = '',
    state = '',
    zip = '',
    searchUrl = '',
    startUrls = [],
    results_wanted: RESULTS_WANTED_RAW = 50,
    max_pages: MAX_PAGES_RAW = 5,
    sort = 'date',
    remote = '',
    proxyConfiguration,
} = input;

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
    ? Math.max(1, +RESULTS_WANTED_RAW)
    : 50;
const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 5;

log.info('Actor input', {
    keywords,
    location,
    city,
    state,
    zip,
    results_wanted: RESULTS_WANTED,
    max_pages: MAX_PAGES,
    startUrlsCount: Array.isArray(startUrls) ? startUrls.length : 0,
});

const dataset = await Dataset.open();
const proxyConf = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : await Actor.createProxyConfiguration({ useApifyProxy: true });
const clientOpts = proxyConf ? { proxyUrl: await proxyConf.newUrl() } : {};

const seen = new Set();
let totalSaved = 0;

// 1) Discover routes + CSRF token
const searchPageHtml = (
    await gotScraping({
        url: searchUrl || `${BASE}/jobs`,
        headers: DEFAULT_HEADERS,
        ...clientOpts,
    })
).body;
const csrfToken = extractCsrf(searchPageHtml);
const routes = buildRouteResolver(searchPageHtml);

// 2) Build search params consistent with site
const searchParams = {
    locale: 'en',
    sort,
    keywords,
    city_state_zip: location,
    city,
    state,
    zip,
};
if (remote === 'remote') searchParams.location_remote_option_filter = 'remote';
if (remote === 'hybrid') searchParams.location_remote_option_filter = 'hybrid';

// 3) Collect from API
totalSaved += await collectFromApi({
    routes,
    csrfToken,
    searchParams,
    maxPages: MAX_PAGES,
    resultsWanted: RESULTS_WANTED,
    seen,
    dataset,
    clientOpts,
});

// 4) Add any direct startUrls/job URLs
if (Array.isArray(startUrls)) {
    for (const entry of startUrls) {
        if (totalSaved >= RESULTS_WANTED) break;
        const url = typeof entry === 'string' ? entry : entry?.url;
        if (!url || seen.has(url)) continue;
        try {
            const item = await fetchJobPage(url, clientOpts);
            await dataset.pushData(item);
            seen.add(url);
            totalSaved += 1;
            log.info(`Saved from startUrl: ${item.title || url}`);
        } catch (err) {
            log.warning(`Failed to parse startUrl ${url}: ${err.message}`);
        }
    }
}

// 5) Fallback to sitemap/HTML if needed
if (totalSaved < RESULTS_WANTED) {
    totalSaved += await collectFromSitemaps({
        resultsWanted: RESULTS_WANTED - totalSaved,
        seen,
        dataset,
        clientOpts,
    });
}

log.info(`Done. Saved ${totalSaved} jobs (results_wanted=${RESULTS_WANTED}).`);
await Actor.exit();
