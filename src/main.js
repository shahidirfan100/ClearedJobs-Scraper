import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

const BASE = 'https://clearedjobs.net';
const DEFAULT_HEADERS = {
    'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'max-age=0',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
};

// Stealth delay helper
function randomDelay(min = 100, max = 500) {
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

function mapApiJob(job, detail = {}, additional = {}, source = 'api') {
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
        source,
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
    try {
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
    } catch (err) {
        log.warning(`Failed to fetch job page ${url}: ${err.message}`);
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
            } else if (res.statusCode >= 500) {
                log.debug(`Job detail HTTP ${res.statusCode} for ${jobId}`);
            }
        } catch (err) {
            // Handle proxy/network errors gracefully
            const errorMsg = err.message || String(err);
            if (errorMsg.includes('ECONNRESET') || errorMsg.includes('proxy') || errorMsg.includes('595')) {
                log.debug(`Network/proxy error fetching job detail ${jobId}`);
            } else {
                log.debug(`Job detail fetch failed for ${jobId}: ${errorMsg}`);
            }
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
            } else if (res.statusCode >= 500) {
                log.debug(`Job additional HTTP ${res.statusCode} for ${jobId}`);
            }
        } catch (err) {
            // Handle proxy/network errors gracefully
            const errorMsg = err.message || String(err);
            if (errorMsg.includes('ECONNRESET') || errorMsg.includes('proxy') || errorMsg.includes('595')) {
                log.debug(`Network/proxy error fetching job additional ${jobId}`);
            } else {
                log.debug(`Job additional fetch failed for ${jobId}: ${errorMsg}`);
            }
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
                    log.warning(`API HTTP ${res.statusCode} on page ${page}, retry ${attempt}`);
                    await Actor.sleep(800 * attempt + randomDelay(100, 300));
                    continue;
                }
                json = safeJsonParse(res.body);

                if (!json || typeof json !== 'object') {
                    log.warning(`API non-JSON response on page ${page}`);
                    log.debug(`Content-Type: ${contentType}, Body snippet: ${res.body?.slice?.(0, 200) || ''}`);
                    break;
                }
            } catch (err) {
                const errorMsg = err.message || String(err);
                // Handle proxy/network errors gracefully
                if (errorMsg.includes('ECONNRESET') || errorMsg.includes('proxy') || errorMsg.includes('595')) {
                    log.warning(`Network/proxy error on page ${page} (attempt ${attempt}), retrying...`);
                } else {
                    log.warning(`API request failed page=${page} (attempt ${attempt}): ${errorMsg}`);
                }
                
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
        if (!data.length) {
            log.warning(`Page ${page}: no jobs found`);
            break;
        }

        const batch = [...data];
        const CONCURRENCY = 12;
        while (batch.length && saved < resultsWanted) {
            const chunk = batch.splice(0, CONCURRENCY);
            const results = await Promise.all(
                chunk.map(async (job) => {
                    const { detail, additional } = await fetchDetails(job.id);
                    const item = mapApiJob(job, detail, additional, 'api');
                    if (
                        item.url &&
                        !seen.has(item.url) &&
                        (
                            (!item.description_html || (item.description_text || '').length < 500) ||
                            !item.job_type ||
                            !item.security_clearance ||
                            !item.location ||
                            !item.salary
                        )
                    ) {
                        const htmlItem = await fetchJobPage(item.url, clientOpts);
                        if (htmlItem) {
                            const existingTextLen = (item.description_text || '').length;
                            const htmlTextLen = (htmlItem.description_text || '').length;
                            if (!item.description_html || htmlTextLen > existingTextLen) {
                                item.description_html =
                                    htmlItem.description_html || item.description_html;
                                item.description_text =
                                    htmlItem.description_text || item.description_text;
                            }
                            item.job_type = item.job_type || htmlItem.job_type || null;
                            item.location = item.location || htmlItem.location || null;
                            item.security_clearance =
                                item.security_clearance || htmlItem.security_clearance || null;
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
                // Small random delay for stealth
                await Actor.sleep(randomDelay(50, 150));
            }
        }

        const nextLink = json?.links?.next || null;
        if (!nextLink) break;
        page += 1;
        endpoint = nextLink.startsWith('http') ? nextLink : endpoint;
        // Small delay between pages for stealth
        if (page <= maxPages) await Actor.sleep(randomDelay(200, 500));
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
    log.info(`Found ${urls.length} URLs from sitemap`);

    for (const url of urls) {
        if (saved >= resultsWanted) break;
        if (seen.has(url)) continue;
        try {
            const item = await fetchJobPage(url, clientOpts);
            if (!item) continue;
            await dataset.pushData(item);
            seen.add(url);
            saved += 1;
        } catch (err) {
            log.warning(`Failed to parse job ${url}: ${err.message}`);
        }
    }

    return saved;
}

await Actor.main(async () => {
    const input = await Actor.getInput() || {};
    
    const {
        startUrl = '',
        keywords = '',
        location = '',
        city = '',
        state = '',
        zip = '',
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
    
    const clientOpts = proxyConf ? { proxyUrl: await proxyConf.newUrl() } : {};

    const seen = new Set();
    let totalSaved = 0;

    // 1) Discover routes + CSRF token
    let searchPageHtml;
    let attempt = 0;
    while (attempt < 3 && !searchPageHtml) {
        attempt += 1;
        try {
            const response = await gotScraping({
                url: startUrl || `${BASE}/jobs`,
                headers: DEFAULT_HEADERS,
                throwHttpErrors: false,
                ...clientOpts,
            });
            
            if (response.statusCode === 403) {
                log.warning(`HTTP 403 - retrying search page (attempt ${attempt}/3)...`);
                await Actor.sleep(1000 * attempt + randomDelay(100, 400));
                continue;
            }
            
            if (response.statusCode >= 400) {
                throw new Error(`HTTP ${response.statusCode}`);
            }
            
            searchPageHtml = response.body;
        } catch (err) {
            if (attempt < 3) {
                log.warning(`Failed to fetch search page (attempt ${attempt}/3): ${err.message}`);
                await Actor.sleep(1000 * attempt + randomDelay(100, 400));
            } else {
                throw new Error(`Unable to fetch search page after ${attempt} attempts: ${err.message}`);
            }
        }
    }
    
    if (!searchPageHtml) {
        throw new Error('Failed to fetch initial search page');
    }
    
    const csrfToken = extractCsrf(searchPageHtml);
    const routes = buildRouteResolver(searchPageHtml);

    // 2) Build search params
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
    try {
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
    } catch (err) {
        log.error(`API collection failed: ${err.message}`);
        // Continue to fallback methods
    }

    // 3) Fallback to sitemap/HTML if needed
    if (totalSaved < RESULTS_WANTED) {
        try {
            totalSaved += await collectFromSitemaps({
                resultsWanted: RESULTS_WANTED - totalSaved,
                seen,
                dataset,
                clientOpts,
            });
        } catch (err) {
            log.error(`Sitemap collection failed: ${err.message}`);
        }
    }

    log.info(`Done - scraped ${totalSaved} jobs`);
});
