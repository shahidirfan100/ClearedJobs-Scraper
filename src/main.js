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

function mapApiJob(job, source = 'api') {
    const url = job.url ? new URL(job.url, BASE).href : `${BASE}/job/${job.id}`;
    return {
        source,
        id: job.id ?? null,
        url,
        title: normalizeSpace(job.title || job.job_title || ''),
        company: normalizeSpace(job.company?.name || job.company || ''),
        location: normalizeSpace(job.location || ''),
        security_clearance: job.job_type || job.security_clearance || null,
        salary: job.salary || job.salary_min || null,
        job_type: job.position_type || job.positionType || null,
        date_posted: job.posted_date || job.modified_time || job.created_at || null,
        description_html: job.description || job.body || null,
        description_text: job.shortDescription
            ? normalizeSpace(job.shortDescription)
            : job.description
              ? normalizeSpace(cheerio.load(job.description).text())
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
        ...clientOpts,
    });
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
    let endpoint = routes.index();
    const headers = {
        ...DEFAULT_HEADERS,
        'x-csrf-token': csrfToken || '',
    };

    while (saved < resultsWanted && page <= maxPages) {
        const params = { ...searchParams, page };
        let json;
        try {
            const res = await gotScraping({
                url: endpoint,
                headers,
                searchParams: params,
                ...clientOpts,
            });
            json = safeJsonParse(res.body);
        } catch (err) {
            log.warning(`API request failed page=${page}: ${err.message}`);
            break;
        }

        const data = Array.isArray(json?.data)
            ? json.data
            : Array.isArray(json?.jobs)
              ? json.jobs
              : [];
        if (!data.length) {
            log.warning(`API returned no jobs on page ${page}`);
            break;
        }

        log.info(`API page ${page}: received ${data.length} jobs`);
        for (const job of data) {
            if (saved >= resultsWanted) break;
            const item = mapApiJob(job, 'api');
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
    const indexUrl = `${BASE}/sitemap_active_jobs.xml`;
    let body;
    try {
        const res = await gotScraping({ url: indexUrl, headers: DEFAULT_HEADERS, ...clientOpts });
        body = res.body;
    } catch (err) {
        log.warning(`Failed to fetch sitemap: ${err.message}`);
        return saved;
    }

    const urls = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1])
        .slice(0, resultsWanted * 2);
    log.info(`Sitemap seed URLs: ${urls.length}`);

    for (const url of urls) {
        if (saved >= resultsWanted) break;
        if (seen.has(url)) continue;
        try {
            const item = await fetchJobPage(url, clientOpts);
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
const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : null;
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
