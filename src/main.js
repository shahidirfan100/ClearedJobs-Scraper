// main.js
// Playwright-based ClearedJobs.net scraper
//
// - Works with search URLs like:
//   https://clearedjobs.net/jobs?locale=en&page=1&sort=date&keywords=admin
//
// - Strategy:
//   1) Open the search URL with Playwright.
//   2) Listen to XHR/fetch responses and collect JSON that "looks like jobs".
//   3) Map each job object to a normalized record (title, company, location, url, etc.).
//   4) If no JSON is detected, fall back to DOM parsing of rendered job cards.
//   5) Optionally, you can also pass direct job URLs to scrape their details.
//
// IMPORTANT: This script does **not** wander across directory/company pages.
// It only touches the specific URLs you give it in `searchUrls` and `jobUrls`.

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

const BASE = 'https://clearedjobs.net';

// ---------- helpers ----------

function normalizeSpace(text = '') {
    return text.replace(/\s+/g, ' ').trim();
}

function isJobApiUrl(url) {
    // Heuristic: tweak this once you know the real API URL(s) from DevTools.
    // We only consider XHR URLs that *look* like job APIs.
    return /jobs/i.test(url) && /api/i.test(url);
}

function isJobUrl(url) {
    return /\/job\//i.test(url);
}

function isSearchUrl(url) {
    return /\/jobs(\?|$)/i.test(url);
}

function getJobIdKey(job) {
    return (
        job.id ||
        job.jobId ||
        job.job_id ||
        job.slug ||
        job.uuid ||
        null
    );
}

function mapJobJsonToItem(job) {
    // This is intentionally defensive & generic – adjust to match your real JSON structure.
    const title =
        job.title ||
        job.jobTitle ||
        job.position ||
        job.name ||
        null;

    const company =
        job.company?.name ||
        job.company_name ||
        job.employer ||
        job.organization ||
        null;

    const location =
        job.location ||
        job.city_state ||
        job.city ||
        job.city_state_country ||
        null;

    const url =
        job.url ||
        job.link ||
        (job.slug ? `${BASE}/job/${job.slug}` : null);

    const descriptionHtml =
        job.description ||
        job.shortDescription ||
        job.summary ||
        null;

    const descriptionText = descriptionHtml
        ? normalizeSpace(
              String(descriptionHtml).replace(/<\/?[^>]+(>|$)/g, ' ')
          )
        : null;

    const datePosted =
        job.datePosted ||
        job.posted_at ||
        job.postedDate ||
        job.posted ||
        null;

    const clearance =
        job.security_clearance ||
        job.clearance ||
        job.requiredClearance ||
        null;

    return {
        source: 'xhr',
        title,
        company,
        location,
        url,
        description_html: descriptionHtml,
        description_text: descriptionText,
        date_posted: datePosted,
        security_clearance: clearance,
        raw: job,
    };
}

function mapJobDomToItem(card, searchPageUrl) {
    // `card` is a plain JS object we build from $$eval
    const url = card.href
        ? new URL(card.href, searchPageUrl).href
        : null;

    return {
        source: 'html',
        title: normalizeSpace(card.title || ''),
        company: normalizeSpace(card.company || ''),
        location: normalizeSpace(card.location || ''),
        url,
        summary: normalizeSpace(card.summary || ''),
    };
}

// ---------- MAIN ----------

await Actor.init();

async function main() {
    const input = (await Actor.getInput()) || {};

    const {
        // Search URLs that load jobs via AJAX
        searchUrls = [
            // Example:
            // "https://clearedjobs.net/jobs?locale=en&page=1&sort=date&keywords=admin"
        ],

        // Optional: direct job URLs to scrape individually (from previous runs, etc.)
        jobUrls = [],

        // Hard cap on number of jobs to save
        results_wanted: RESULTS_WANTED_RAW = 50,

        // Wait (ms) after "networkidle" to let XHRs finish
        xhrWaitMillis = 3000,

        // Standard Apify proxyConfiguration input
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
        ? Math.max(1, +RESULTS_WANTED_RAW)
        : 50;

    log.info('Actor input', {
        results_wanted: RESULTS_WANTED,
        searchUrlsCount: searchUrls.length,
        jobUrlsCount: jobUrls.length,
    });

    const dataset = await Dataset.open();
    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : null;

    let saved = 0;
    const seenJobKeys = new Set();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: 2, // one or two pages at a time is enough
        launchContext: {
            launchOptions: {
                headless: true,
            },
        },

        async requestHandler({ page, request, log }) {
            if (saved >= RESULTS_WANTED) {
                log.info(
                    `Already have ${saved} jobs (>= results_wanted). Skipping ${request.url}.`
                );
                return;
            }

            const url = request.url();
            log.info(`Opening: ${url}`);

            // -----------------------
            // Case 1: Search URL
            // -----------------------
            if (isSearchUrl(url)) {
                const jobsFromXhr = [];
                const jobKeysFromXhr = new Set();

                // Attach response listener BEFORE navigation
                page.on('response', async (response) => {
                    try {
                        const resUrl = response.url();
                        const type = response.request().resourceType();

                        if (!['xhr', 'fetch'].includes(type)) return;
                        if (!isJobApiUrl(resUrl)) return;

                        // Try JSON
                        let json;
                        try {
                            json = await response.json();
                        } catch {
                            return;
                        }
                        if (!json) return;

                        let candidates = [];
                        if (Array.isArray(json.data)) candidates = json.data;
                        else if (Array.isArray(json.jobs)) candidates = json.jobs;
                        else if (Array.isArray(json.results)) candidates = json.results;
                        else if (Array.isArray(json)) candidates = json;
                        else if (json.items && Array.isArray(json.items))
                            candidates = json.items;

                        for (const job of candidates) {
                            const key = getJobIdKey(job) || job.url || job.slug;
                            if (!key || jobKeysFromXhr.has(key)) continue;
                            jobKeysFromXhr.add(key);
                            jobsFromXhr.push(job);
                        }
                    } catch {
                        // Ignore parsing failures
                    }
                });

                await page.goto(url, {
                    waitUntil: 'networkidle',
                });

                // Give XHR a bit more time
                await page.waitForTimeout(xhrWaitMillis);

                // If XHR gave us jobs, use them
                if (jobsFromXhr.length) {
                    log.info(
                        `Captured ${jobsFromXhr.length} job objects from XHR on ${url}`
                    );

                    for (const job of jobsFromXhr) {
                        if (saved >= RESULTS_WANTED) break;

                        const key = getJobIdKey(job) || job.url || job.slug;
                        if (key && seenJobKeys.has(key)) continue;
                        if (key) seenJobKeys.add(key);

                        const item = mapJobJsonToItem(job);
                        await dataset.pushData(item);
                        saved += 1;
                        log.info(
                            `Saved job #${saved} from XHR: ${item.title || '(no title)'}`
                        );
                    }

                    return;
                }

                // -----------------------
                // DOM fallback: job cards
                // -----------------------
                log.info(
                    `No recognizable XHR jobs found on ${url}, falling back to DOM parsing.`
                );

                try {
                    // Wait for job list to appear (tweak selector as needed)
                    // This is a generic guess; adjust selector once you inspect the page.
                    await page.waitForSelector('a[href*="/job/"]', {
                        timeout: 10000,
                    });
                } catch {
                    log.warning(`No job links visible on ${url} within timeout.`);
                }

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

                log.info(`Found ${cards.length} job link cards from DOM on ${url}.`);

                for (const card of cards) {
                    if (saved >= RESULTS_WANTED) break;

                    const item = mapJobDomToItem(card, url);
                    const key = item.url || item.title + '|' + item.company;
                    if (key && seenJobKeys.has(key)) continue;
                    if (key) seenJobKeys.add(key);

                    await dataset.pushData(item);
                    saved += 1;
                    log.info(
                        `Saved job #${saved} from DOM: ${item.title || '(no title)'}`
                    );
                }

                return;
            }

            // -----------------------
            // Case 2: Direct job URL (optional)
            // If you pass jobUrls, you can implement detail scraping here.
            // -----------------------
            if (isJobUrl(url)) {
                // Here we just grab title/company/location, no fancy XHR.
                await page.goto(url, { waitUntil: 'domcontentloaded' });

                const title = normalizeSpace(
                    (await page.textContent('h1').catch(() => '')) || ''
                );

                const company = normalizeSpace(
                    (await page.textContent('.company, .employer').catch(() => '')) ||
                        ''
                );

                const location = normalizeSpace(
                    (await page.textContent('.location').catch(() => '')) || ''
                );

                const descriptionText = normalizeSpace(
                    (await page.textContent('main, .job-description').catch(() => '')) ||
                        ''
                );

                const item = {
                    source: 'html-job',
                    url,
                    title,
                    company,
                    location,
                    description_text: descriptionText || null,
                };

                const key = url;
                if (!seenJobKeys.has(key) && saved < RESULTS_WANTED) {
                    seenJobKeys.add(key);
                    await dataset.pushData(item);
                    saved += 1;
                    log.info(
                        `Saved job #${saved} from direct job URL: ${
                            item.title || '(no title)'
                        }`
                    );
                }

                return;
            }

            log.info(`URL ${url} is neither search nor job URL; skipping.`);
        },
    });

    const startRequests = [];

    for (const u of searchUrls) {
        if (!u) continue;
        const url = typeof u === 'string' ? u : u.url || '';
        if (!url) continue;
        startRequests.push({ url });
    }

    for (const u of jobUrls) {
        if (!u) continue;
        const url = typeof u === 'string' ? u : u.url || '';
        if (!url) continue;
        startRequests.push({ url });
    }

    if (!startRequests.length) {
        log.warning(
            'No searchUrls or jobUrls provided. Provide at least one search URL for this actor to be useful.'
        );
    } else {
        await crawler.run(startRequests);
    }

    log.info(`Done. Saved ${saved} jobs (results_wanted=${RESULTS_WANTED}).`);

    await Actor.exit();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
