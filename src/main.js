// ClearedJobs.net scraper - resilient JSON / HTML hybrid
// Strategy (in priority order):
//  1) Try JSON-style API endpoints (if the site exposes any; fail-soft if not)
//  2) HTML discovery via Employer Directory -> Company pages -> Job detail pages
//  3) Robust text parsing of job detail (with optional JSON-LD extraction)
//
// This version FIXES:
//  - JS code and JSON-LD blobs leaking into description_text
//  - Title being inferred from noisy full-page text
//  - Now the title is taken from JSON-LD or <h1> ONLY.

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

const BASE_URL = 'https://clearedjobs.net';

// ---------- Small helpers ----------

function normalizeSpace(text = '') {
    return text.replace(/\s+/g, ' ').trim();
}

function safeJsonParse(raw) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

// Get BODY text without scripts/styles/noscript so we don't see navbar JS etc.
function getCleanBodyText($) {
    const $clone = $('body').clone();
    $clone.find('script, style, noscript').remove();
    const txt = $clone.text() || '';
    return normalizeSpace(txt);
}

// Extract JobPosting objects from generic JSON-LD blocks
function extractJobFromJsonLd(jsonLd) {
    if (!jsonLd) return null;

    const items = Array.isArray(jsonLd['@graph'])
        ? jsonLd['@graph']
        : Array.isArray(jsonLd)
            ? jsonLd
            : [jsonLd];

    let posting = items.find((it) => {
        const type = it['@type'];
        if (!type) return false;
        if (Array.isArray(type)) return type.includes('JobPosting');
        return type === 'JobPosting';
    });

    if (!posting) return null;

    const out = {
        title: posting.title || posting.name || null,
        description_html: posting.description || null,
        description_text: posting.description
            ? normalizeSpace(
                  String(posting.description).replace(/<\/?[^>]+(>|$)/g, ' ')
              )
            : null,
        company: posting.hiringOrganization?.name || null,
        url: posting.url || posting.directApplyUrl || null,
        location: posting.jobLocation?.address?.addressLocality
            ? normalizeSpace(
                  [
                      posting.jobLocation.address.addressLocality,
                      posting.jobLocation.address.addressRegion,
                      posting.jobLocation.address.addressCountry,
                  ]
                      .filter(Boolean)
                      .join(', ')
              )
            : null,
        datePosted: posting.datePosted || null,
        validThrough: posting.validThrough || null,
        employmentType: posting.employmentType || null,
        baseSalary: posting.baseSalary || null,
    };

    return out;
}

// Parse key fields from cleaned page text (pure text fallback)
function extractFieldsFromText(pageTextRaw) {
    const text = pageTextRaw || '';

    const clearanceMatch = text.match(/Security Clearance:\s*([\s\S]*?)(?:\r?\n|\s{2,}|Location:|Posted:)/i);
    const securityClearance = clearanceMatch
        ? normalizeSpace(clearanceMatch[1])
        : null;

    const locationMatch = text.match(/Location:\s*([\s\S]*?)(?:\r?\n|\s{2,}|Relocation Assistance:|Remote\/Telework:|Description of Duties:|Posted:)/i);
    const location = locationMatch ? normalizeSpace(locationMatch[1]) : null;

    const postedMatch = text.match(/Posted:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    const posted = postedMatch ? normalizeSpace(postedMatch[1]) : null;

    const referenceMatch = text.match(/Job Reference ID:\s*([A-Za-z0-9\-]+)/i);
    const referenceId = referenceMatch ? normalizeSpace(referenceMatch[1]) : null;

    const descMatch = text.match(
        /Description of Duties:\s*([\s\S]*?)(?:#####?\s*Job Information|Job Information\s*:|######\s*Job Information|Trending Job Titles|####\s*Job Information|##\s*Related jobs|####\s*Trending)/i,
    );
    const descriptionText = descMatch
        ? normalizeSpace(descMatch[1])
        : null;

    return {
        location,
        securityClearance,
        posted,
        referenceId,
        descriptionText,
    };
}

// ---------- JSON "API" probe (fail-soft) ----------

// This is intentionally defensive: if the site doesn’t expose JSON,
// we log and silently fall back to HTML.
async function tryJsonApiStrategy({ keywords, location, clearance, limit }) {
    const results = [];
    let page = 1;
    let saved = 0;

    // This endpoint is *best-effort guesswork*.
    // If it fails or returns nothing, we simply fall back to HTML.
    const API_URL = `${BASE_URL}/index.php/jobs`;

    while (saved < limit && page <= 3) {
        const resp = await gotScraping({
            url: API_URL,
            searchParams: {
                page,
                q: keywords || undefined,
                l: location || undefined,
            },
            headers: {
                Accept: 'application/json, text/plain, */*',
                'X-Requested-With': 'XMLHttpRequest',
            },
            throwHttpErrors: false,
            timeout: { request: 15000 },
        });

        if (resp.statusCode !== 200) {
            log.info(`JSON probe: status ${resp.statusCode}, giving up JSON strategy.`);
            break;
        }

        const body = safeJsonParse(resp.body);
        if (!body) {
            log.info('JSON probe: response was not valid JSON, giving up JSON strategy.');
            break;
        }

        // VERY defensive: we don’t know exact shape of the data.
        const jobs =
            body.jobs ||
            body.data?.jobs ||
            body.results ||
            (Array.isArray(body) ? body : null);

        if (!Array.isArray(jobs) || jobs.length === 0) {
            log.info('JSON probe: no jobs array in JSON, giving up JSON strategy.');
            break;
        }

        for (const item of jobs) {
            if (saved >= limit) break;

            const job = {
                source: 'json-api',
                raw: item,
            };
            results.push(job);
            saved += 1;
        }

        // Pagination heuristics
        const hasNext =
            body.links?.next ||
            body.next_page ||
            (Array.isArray(jobs) && jobs.length >= 20); // heuristics

        if (!hasNext) break;
        page += 1;
    }

    if (results.length === 0) {
        log.info('JSON strategy did not yield any jobs – falling back to HTML.');
    } else {
        log.info(`JSON strategy yielded ${results.length} raw items (not fully normalized).`);
    }

    return results;
}

// ---------- HTML crawling strategy ----------

async function runHtmlCrawler({ keywords, location, clearance, limit, maxConcurrency, maxRequestsPerCrawl, proxyConfig }) {
    const dataset = await Dataset.open();
    const requestQueue = await Actor.openRequestQueue();

    let saved = 0;

    await requestQueue.addRequest({
        url: `${BASE_URL}/employer-directory`,
        uniqueKey: 'employer-directory-root',
        userData: { label: 'EMPLOYER_DIRECTORY' },
    });

    const proxyConfiguration = proxyConfig
        ? await Actor.createProxyConfiguration(proxyConfig)
        : null;

    const crawler = new CheerioCrawler({
        requestQueue,
        proxyConfiguration,
        maxConcurrency: maxConcurrency || 5,
        maxRequestsPerCrawl: maxRequestsPerCrawl || 5000,
        requestHandlerTimeoutSecs: 60,
        async requestHandler(context) {
            const { request, body } = context;
            const label = request.userData.label;
            const url = request.loadedUrl || request.url;

            if (!body || !url) return;

            const $ = cheerioLoad(body);

            if (saved >= limit) {
                log.info(`Reached desired limit (${limit}) – aborting crawl.`);
                await crawler.autoscaledPool?.abort();
                return;
            }

            if (label === 'EMPLOYER_DIRECTORY') {
                log.info(`EMPLOYER_DIRECTORY: ${url}`);

                // Enqueue company pages
                $('a[href*="/company/"]').each((_, el) => {
                    const href = $(el).attr('href');
                    if (!href) return;
                    const absolute = new URL(href, url).href;

                    // Only real company pages (avoid random non-company URLs)
                    if (!/\/company\/[a-z0-9\-]+-\d+/i.test(absolute)) return;

                    requestQueue.addRequest({
                        url: absolute,
                        userData: { label: 'COMPANY' },
                    }).catch(() => {});
                });

                // Enqueue pagination of the directory (?page=2 etc.)
                $('a[href*="employer-directory"]').each((_, el) => {
                    const href = $(el).attr('href');
                    if (!href) return;
                    if (!/employer-directory.*page=/i.test(href)) return;
                    const absolute = new URL(href, url).href;
                    requestQueue.addRequest({
                        url: absolute,
                        userData: { label: 'EMPLOYER_DIRECTORY' },
                    }).catch(() => {});
                });

                return;
            }

            if (label === 'COMPANY') {
                log.info(`COMPANY: ${url}`);

                // Enqueue job detail pages from this company
                $('a[href*="/job/"]').each((_, el) => {
                    if (saved >= limit) return;

                    const href = $(el).attr('href');
                    if (!href) return;
                    const absolute = new URL(href, url).href;

                    // Basic sanity check: looks like a job detail URL
                    if (!/\/job\//i.test(absolute)) return;

                    requestQueue.addRequest({
                        url: absolute,
                        uniqueKey: absolute.replace(/[#?].*$/, ''),
                        userData: { label: 'JOB' },
                    }).catch(() => {});
                });

                // Try “View All Jobs” style links as additional company pages
                $('a:contains("View All Jobs"), a:contains("View all jobs")').each((_, el) => {
                    const href = $(el).attr('href');
                    if (!href) return;
                    const absolute = new URL(href, url).href;
                    requestQueue.addRequest({
                        url: absolute,
                        userData: { label: 'COMPANY' },
                    }).catch(() => {});
                });

                return;
            }

            if (label === 'JOB') {
                if (saved >= limit) return;

                log.info(`JOB: ${url}`);

                const $body = cheerioLoad(body);

                // 1) Try JSON-LD (for clean title, description, company, etc.)
                let jobFromLd = null;
                $body('script[type="application/ld+json"]').each((_, el) => {
                    if (jobFromLd) return;
                    const raw = $body(el).contents().text();
                    const parsed = safeJsonParse(raw);
                    const j = extractJobFromJsonLd(parsed);
                    if (j) jobFromLd = j;
                });

                // 2) Clean text (without script/style/noscript) for field extraction
                const textAll = getCleanBodyText($body);
                const fields = extractFieldsFromText(textAll);

                // 3) Header extraction for title/company/location
                const h1Text = normalizeSpace($body('h1').first().text() || '');
                const headerContainer = $body('h1').first().parent();
                const headerLinks = headerContainer.find('a');

                const companyFromHeader = normalizeSpace(headerLinks.eq(0).text() || '');
                const locFromHeader = normalizeSpace(headerLinks.eq(1).text() || '');

                // FINAL TITLE: JSON-LD title first, then <h1>, but NEVER from full body text
                const titleFinal =
                    jobFromLd?.title ||
                    h1Text ||
                    null;

                const companyFinal =
                    jobFromLd?.company ||
                    companyFromHeader ||
                    null;

                const locationFinal =
                    jobFromLd?.location ||
                    fields.location ||
                    (locFromHeader || null);

                const descriptionTextFinal =
                    jobFromLd?.description_text ||
                    fields.descriptionText ||
                    textAll || // clean full body text as last resort
                    null;

                const job = {
                    source: 'html',
                    url,
                    title: titleFinal,
                    company: companyFinal,
                    location: locationFinal,
                    description_text: descriptionTextFinal,
                    description_html: jobFromLd?.description_html || null,
                    security_clearance:
                        jobFromLd?.securityClearance ||
                        fields.securityClearance ||
                        null,
                    posted_at: fields.posted || jobFromLd?.datePosted || null,
                    job_reference_id: fields.referenceId || null,
                };

                // Simple client-side keyword/location/clearance filters if user provided them
                if (keywords && !String(job.title || '').toLowerCase().includes(String(keywords).toLowerCase())) {
                    return;
                }
                if (
                    location &&
                    !String(job.location || '').toLowerCase().includes(String(location).toLowerCase())
                ) {
                    return;
                }
                if (
                    clearance &&
                    !String(job.security_clearance || '').toLowerCase().includes(String(clearance).toLowerCase())
                ) {
                    return;
                }

                await dataset.pushData(job);
                saved += 1;
                log.info(`Saved job #${saved}: ${job.title || '(no title)'}`);

                if (saved >= limit) {
                    log.info(`Reached desired limit (${limit}) – aborting crawl.`);
                    await crawler.autoscaledPool?.abort();
                }

                return;
            }
        },
        failedRequestHandler({ request, error }) {
            log.error(`Request ${request.url} failed too many times: ${error?.message || error}`);
        },
    });

    await crawler.run();

    log.info(`HTML crawl finished. Saved ${saved} jobs to dataset.`);
}

// ---------- MAIN ----------

await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keywords = '',
            location = '',
            clearance_level: clearance = '',
            results_wanted: RESULTS_WANTED_RAW = 50,
            maxConcurrency = 5,
            maxRequestsPerCrawl = 5000,
            proxyConfiguration: proxyConfig,
            preferHtmlOnly = false,
        } = input;

        const RESULTS_WANTED = Number(RESULTS_WANTED_RAW) || 50;

        log.info('Actor input', {
            keywords,
            location,
            clearance,
            RESULTS_WANTED,
            maxConcurrency,
            maxRequestsPerCrawl,
            preferHtmlOnly,
        });

        // 1) Optional JSON API first (if not explicitly disabled)
        let jsonItems = [];
        if (!preferHtmlOnly) {
            try {
                jsonItems = await tryJsonApiStrategy({
                    keywords,
                    location,
                    clearance,
                    limit: RESULTS_WANTED,
                });
            } catch (e) {
                log.warning(`JSON strategy threw an error, continuing with HTML only: ${e.message || e}`);
            }
        }

        // If JSON actually returned usable jobs, normalize & store them,
        // but *still* continue with HTML so we’re robust to partial coverage.
        const dataset = await Dataset.open();
        let normalizedFromJson = 0;
        for (const item of jsonItems) {
            if (normalizedFromJson >= RESULTS_WANTED) break;

            const raw = item.raw || item;
            const job = {
                source: 'json-api',
                raw: raw,
            };

            await dataset.pushData(job);
            normalizedFromJson += 1;
        }

        if (normalizedFromJson > 0) {
            log.info(`Saved ${normalizedFromJson} raw JSON jobs (not fully normalized).`);
        }

        // 2) Always run HTML crawler to guarantee results
        await runHtmlCrawler({
            keywords,
            location,
            clearance,
            limit: RESULTS_WANTED,
            maxConcurrency,
            maxRequestsPerCrawl,
            proxyConfig,
        });

        log.info('Actor run completed.');
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
