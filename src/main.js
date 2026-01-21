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

// Human-like delay helper
function randomDelay(min = 500, max = 1500) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
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
    return block?.value ? normalizeSpace(block.value) : null;
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

function mapApiJob(job, detail = {}, additional = {}) {
    const rawUrl =
        job.url || detail.url || additional.url || (job.id ? `${BASE}/job/${job.id}` : null);
    const id = job.id ?? detail.id ?? additional.id ?? null;
    let url = rawUrl ? new URL(rawUrl, BASE).href : null;
    if (!url && id) url = `${BASE}/job/${id}`;
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
        id,
        url: url || null,
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
        id: ld.identifier || null,
        url,
        title: normalizeSpace(ld.title || ''),
        company: normalizeSpace(ld.hiringOrganization?.name || ''),
        location: normalizeSpace(
            ld.jobLocation?.address?.addressLocality
                ? `${ld.jobLocation.address.addressLocality}, ${ld.jobLocation.address.addressRegion || ''
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

async function fetchJobPage(url, getProxyUrl) {
    try {
        const res = await gotScraping({
            url,
            headers: getStealthHeaders(),
            throwHttpErrors: false,
            proxyUrl: await getProxyUrl(),
        });

        if (res.statusCode >= 400) {
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
            url,
            title,
            company,
            location,
            description_html: descHtml,
            description_text: descText,
        };
    } catch {
        return null;
    }
}

async function collectFromApi({
    routes,
    csrfToken,
    searchParams,
    maxPages,
    resultsWanted,
    seen,
    dataset,
    getProxyUrl,
}) {
    let saved = 0;
    let page = 1;
    const indexFn = typeof routes.index === 'function' ? routes.index : () => `${BASE}/api/v1/jobs`;
    let endpoint = indexFn();

    async function fetchDetails(jobId) {
        const results = { detail: {}, additional: {} };
        const headers = {
            ...getStealthHeaders(),
            'x-csrf-token': csrfToken || '',
        };

        try {
            const res = await gotScraping({
                url: routes.show({ job: jobId }),
                headers,
                throwHttpErrors: false,
                proxyUrl: await getProxyUrl(),
            });
            if (res.statusCode < 400) {
                const json = safeJsonParse(res.body, {});
                results.detail = json?.data || json || {};
            }
        } catch { /* ignore */ }

        try {
            const res = await gotScraping({
                url: routes.additional({ job: jobId }),
                headers,
                throwHttpErrors: false,
                proxyUrl: await getProxyUrl(),
            });
            if (res.statusCode < 400) {
                const json = safeJsonParse(res.body, {});
                results.additional = json?.data || json || {};
            }
        } catch { /* ignore */ }

        return results;
    }

    while (saved < resultsWanted && page <= maxPages) {
        const params = { ...searchParams, page };
        const headers = {
            ...getStealthHeaders(),
            'x-csrf-token': csrfToken || '',
        };

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
                    proxyUrl: await getProxyUrl(),
                });

                if (res.statusCode >= 500) {
                    await Actor.sleep(800 * attempt + randomDelay(100, 300));
                    continue;
                }
                json = safeJsonParse(res.body);

                if (!json || typeof json !== 'object') {
                    break;
                }
            } catch {
                if (attempt < 3) {
                    await Actor.sleep(500 * attempt + randomDelay(100, 300));
                }
            }
        }

        if (!json || typeof json !== 'object') break;

        const data = Array.isArray(json?.data)
            ? json.data
            : Array.isArray(json?.jobs)
                ? json.jobs
                : [];
        if (!data.length) break;

        // Process jobs with reduced concurrency for stealth
        const CONCURRENCY = 5;
        const batch = [...data];
        while (batch.length && saved < resultsWanted) {
            const chunk = batch.splice(0, CONCURRENCY);
            const results = await Promise.all(
                chunk.map(async (job) => {
                    const { detail, additional } = await fetchDetails(job.id);
                    const item = mapApiJob(job, detail, additional);

                    // Enrich with HTML if missing critical data
                    if (
                        item.url &&
                        !seen.has(item.url) &&
                        (
                            (!item.description_html || (item.description_text || '').length < 500) ||
                            !item.job_type ||
                            !item.security_clearance
                        )
                    ) {
                        const htmlItem = await fetchJobPage(item.url, getProxyUrl);
                        if (htmlItem) {
                            const existingTextLen = (item.description_text || '').length;
                            const htmlTextLen = (htmlItem.description_text || '').length;
                            if (!item.description_html || htmlTextLen > existingTextLen) {
                                item.description_html = htmlItem.description_html || item.description_html;
                                item.description_text = htmlItem.description_text || item.description_text;
                            }
                            item.job_type = item.job_type || htmlItem.job_type || null;
                            item.location = item.location || htmlItem.location || null;
                            item.security_clearance = item.security_clearance || htmlItem.security_clearance || null;
                            item.salary = item.salary || htmlItem.salary || null;
                        }
                    }
                    return item;
                })
            );

            for (const item of results) {
                if (saved >= resultsWanted) break;
                const key = item.url || item.id || JSON.stringify(item);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                await dataset.pushData(item);
                saved += 1;
            }

            // Human-like delay between batches
            await Actor.sleep(randomDelay(300, 800));
        }

        const nextLink = json?.links?.next || null;
        if (!nextLink) break;
        page += 1;
        endpoint = nextLink.startsWith('http') ? nextLink : endpoint;

        // Human-like delay between pages
        if (page <= maxPages) await Actor.sleep(randomDelay(500, 1200));
    }

    return saved;
}

async function collectFromSitemaps({ resultsWanted, seen, dataset, getProxyUrl }) {
    let saved = 0;
    const indexUrl = `${BASE}/sitemap.xml`;
    let sitemapList = [];

    try {
        const res = await gotScraping({
            url: indexUrl,
            headers: getStealthHeaders(),
            proxyUrl: await getProxyUrl(),
        });
        sitemapList = [...res.body.matchAll(/<loc>([^<]+sitemap_[^<]+\.xml)<\/loc>/g)].map(
            (m) => m[1]
        );
    } catch {
        return saved;
    }

    const jobSitemaps = sitemapList.filter((u) => u.includes('sitemap_active_jobs'));
    if (!jobSitemaps.length) return saved;

    const urls = [];
    for (const sm of jobSitemaps) {
        if (urls.length >= resultsWanted * 2) break;
        try {
            const res = await gotScraping({
                url: sm,
                headers: getStealthHeaders(),
                throwHttpErrors: false,
                proxyUrl: await getProxyUrl(),
            });
            if (res.statusCode >= 400) continue;
            urls.push(
                ...[...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).slice(0, resultsWanted)
            );
        } catch { /* ignore */ }
    }

    for (const url of urls) {
        if (saved >= resultsWanted) break;
        if (seen.has(url)) continue;
        try {
            const item = await fetchJobPage(url, getProxyUrl);
            if (!item) continue;
            await dataset.pushData(item);
            seen.add(url);
            saved += 1;
            await Actor.sleep(randomDelay(300, 600));
        } catch { /* ignore */ }
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
        results_wanted: RESULTS_WANTED_RAW = 20,
        max_pages: MAX_PAGES_RAW = 3,
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
        ? Math.max(1, +RESULTS_WANTED_RAW)
        : 20;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 3;

    log.info(`Starting scraper: target ${RESULTS_WANTED} jobs, max ${MAX_PAGES} pages`);

    const dataset = await Dataset.open();
    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : await Actor.createProxyConfiguration({ useApifyProxy: true });

    // Proxy rotation function - new proxy per request
    const getProxyUrl = async () => proxyConf ? await proxyConf.newUrl() : undefined;

    const seen = new Set();
    let totalSaved = 0;

    // Discover routes + CSRF token
    let searchPageHtml;
    let attempt = 0;
    while (attempt < 3 && !searchPageHtml) {
        attempt += 1;
        try {
            const response = await gotScraping({
                url: startUrl || `${BASE}/jobs`,
                headers: getStealthHeaders(),
                throwHttpErrors: false,
                proxyUrl: await getProxyUrl(),
            });

            if (response.statusCode === 403) {
                await Actor.sleep(1000 * attempt + randomDelay(200, 500));
                continue;
            }

            if (response.statusCode >= 400) {
                throw new Error(`HTTP ${response.statusCode}`);
            }

            searchPageHtml = response.body;
        } catch (err) {
            if (attempt < 3) {
                await Actor.sleep(1000 * attempt + randomDelay(200, 500));
            } else {
                throw new Error(`Failed to load search page: ${err.message}`);
            }
        }
    }

    if (!searchPageHtml) {
        throw new Error('Failed to fetch initial search page');
    }

    const csrfToken = extractCsrf(searchPageHtml);
    const routes = buildRouteResolver(searchPageHtml);

    // Build search params
    const searchParams = {
        locale: 'en',
        sort,
        keywords,
        city_state_zip: location,
    };
    if (remote === 'remote') searchParams.location_remote_option_filter = 'remote';
    if (remote === 'hybrid') searchParams.location_remote_option_filter = 'hybrid';

    // Collect from API (primary method - fast)
    try {
        totalSaved += await collectFromApi({
            routes,
            csrfToken,
            searchParams,
            maxPages: MAX_PAGES,
            resultsWanted: RESULTS_WANTED,
            seen,
            dataset,
            getProxyUrl,
        });
    } catch (err) {
        log.warning(`API collection issue: ${err.message}`);
    }

    // Fallback to sitemap/HTML if needed
    if (totalSaved < RESULTS_WANTED) {
        try {
            totalSaved += await collectFromSitemaps({
                resultsWanted: RESULTS_WANTED - totalSaved,
                seen,
                dataset,
                getProxyUrl,
            });
        } catch (err) {
            log.warning(`Sitemap fallback issue: ${err.message}`);
        }
    }

    log.info(`Completed: scraped ${totalSaved} jobs`);
});
