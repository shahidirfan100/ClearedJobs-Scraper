import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

const BASE = 'https://clearedjobs.net';

function normalizeSpace(text = '') {
    return text.replace(/\s+/g, ' ').trim();
}

function isJobUrl(url) {
    return /\/job\//i.test(url);
}

function isSearchUrl(url) {
    return /\/jobs(\?|$)/i.test(url);
}

// Build a ClearedJobs search URL from keywords etc.
function buildSearchUrlFromParams({ keywords = '', page = 1, sort = 'date', locale = 'en' }) {
    const u = new URL('/jobs', BASE);
    u.searchParams.set('locale', locale);
    u.searchParams.set('page', String(page));
    u.searchParams.set('sort', sort);
    if (keywords) u.searchParams.set('keywords', String(keywords));
    // You can add more params here if needed (country, state, etc.)
    return u.toString();
}

await Actor.init();

const input = (await Actor.getInput()) || {};

/**
 * Supported input fields:
 * - keywords: "admin"  (optional, actor will build a search URL)
 * - searchUrl: "https://clearedjobs.net/jobs?..." (optional)
 * - startUrls: [ { "url": "..." }, ... ]  (optional, Apify standard)
 * - results_wanted: number of jobs to save (default 50)
 */
const {
    keywords = '',
    searchUrl = '',
    startUrls = [],
    results_wanted: RESULTS_WANTED_RAW = 50,
    proxyConfiguration,
} = input;

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
    ? Math.max(1, +RESULTS_WANTED_RAW)
    : 50;

log.info('Actor input', {
    keywords,
    searchUrl,
    startUrlsCount: Array.isArray(startUrls) ? startUrls.length : 0,
    results_wanted: RESULTS_WANTED,
});

const dataset = await Dataset.open();
const proxyConf = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : null;

let saved = 0;
const seenUrls = new Set();

// Build the list of start requests

const startRequests = [];

// 1) startUrls (Apify standard)
if (Array.isArray(startUrls)) {
    for (const item of startUrls) {
        if (!item) continue;
        const url = typeof item === 'string' ? item : item.url || '';
        if (!url) continue;
        startRequests.push({ url });
    }
}

// 2) explicit searchUrl
if (searchUrl) {
    startRequests.push({ url: searchUrl });
}

// 3) keywords → build a search URL if nothing else provided
if (!startRequests.length && keywords) {
    const built = buildSearchUrlFromParams({ keywords, page: 1, sort: 'date' });
    log.info(`No URLs provided, using built search URL from keywords: ${built}`);
    startRequests.push({ url: built });
}

if (!startRequests.length) {
    log.warning(
        'No URLs to process. Provide at least one of: "startUrls", "searchUrl", or "keywords".'
    );
    await Actor.exit();
}

// --------- PlaywrightCrawler setup ---------

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConf,
    maxConcurrency: 2,
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },

    async requestHandler({ page, request, log }) {
        if (saved >= RESULTS_WANTED) {
            log.info(
                `Already saved ${saved} jobs (>= results_wanted). Skipping ${request.url}.`
            );
            return;
        }

        const url = request.url();
        log.info(`Opening: ${url}`);

        // SEARCH PAGE: /jobs?...
        if (isSearchUrl(url)) {
            await page.goto(url, { waitUntil: 'networkidle' });

            // Wait for job links to appear
            try {
                await page.waitForSelector('a[href*="/job/"]', { timeout: 15000 });
            } catch {
                log.warning(`No job links found on search page: ${url}`);
                return;
            }

            // Extract job cards
            const cards = await page.$$eval('a[href*="/job/"]', (links) =>
                links.map((a) => {
                    const card = a.closest('article, li, div') || a;
                    return {
                        href: a.getAttribute('href') || '',
                        title: (card.querySelector('h2,h3') || a).textContent || '',
                        company:
                            (card.querySelector('.company, .employer') || {}).textContent ||
                            '',
                        location:
                            (card.querySelector('.location') || {}).textContent || '',
                        summary:
                            (card.querySelector('.description, .summary') || {})
                                .textContent || '',
                    };
                })
            );

            log.info(`Found ${cards.length} job link cards on search page.`);

            for (const card of cards) {
                if (saved >= RESULTS_WANTED) break;

                const absolute = new URL(card.href, url).href;
                if (seenUrls.has(absolute)) continue;
                seenUrls.add(absolute);

                const item = {
                    source: 'search-html',
                    url: absolute,
                    title: normalizeSpace(card.title || ''),
                    company: normalizeSpace(card.company || ''),
                    location: normalizeSpace(card.location || ''),
                    summary: normalizeSpace(card.summary || ''),
                };

                await dataset.pushData(item);
                saved += 1;
                log.info(
                    `Saved job #${saved} from search page: ${item.title || '(no title)'}`
                );
            }

            return;
        }

        // DIRECT JOB PAGE: /job/...
        if (isJobUrl(url)) {
            await page.goto(url, { waitUntil: 'domcontentloaded' });

            const title = normalizeSpace(
                (await page.textContent('h1').catch(() => '')) || ''
            );

            const company = normalizeSpace(
                (await page.textContent('.company, .employer').catch(() => '')) || ''
            );

            const location = normalizeSpace(
                (await page.textContent('.location').catch(() => '')) || ''
            );

            const descriptionText = normalizeSpace(
                (await page.textContent('main, .job-description').catch(() => '')) ||
                    ''
            );

            const item = {
                source: 'job-html',
                url,
                title,
                company,
                location,
                description_text: descriptionText || null,
            };

            if (!seenUrls.has(url) && saved < RESULTS_WANTED) {
                seenUrls.add(url);
                await dataset.pushData(item);
                saved += 1;
                log.info(
                    `Saved job #${saved} from job page: ${item.title || '(no title)'}`
                );
            }

            return;
        }

        log.info(`URL ${url} is neither /jobs nor /job/, skipping.`);
    },
});

// Run the crawler with the prepared URLs
await crawler.run(startRequests);

log.info(`Done. Saved ${saved} jobs (results_wanted=${RESULTS_WANTED}).`);

await Actor.exit();
