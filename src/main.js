// ClearedJobs.net HTML-only scraper
// Strategy:
//  1) Start from Employer Directory (server-rendered) → /employer-directory
//  2) For each company page, extract links to job detail pages
//  3) On each job detail page, parse JSON-LD + clean HTML text
//  4) Stop enqueuing once we reach results_wanted jobs
//
// This avoids crawling random taxonomy / search pages and only visits:
//  - employer-directory pages (bounded by maxDirectoryPages)
//  - company pages
//  - job detail pages (each yields exactly one job item)

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

const BASE_URL = 'https://clearedjobs.net';
const EMPLOYER_DIRECTORY_URL = `${BASE_URL}/employer-directory`;

// ---------- helpers ----------

function normalizeSpace(text = '') {
    return text.replace(/\s+/g, ' ').trim();
}

function safeJsonParse(raw) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// Grab body text without scripts/styles/noscript
function getCleanBodyText($) {
    const $clone = $('body').clone();
    $clone.find('script, style, noscript, iframe').remove();
    return normalizeSpace($clone.text() || '');
}

// Extract JobPosting from JSON-LD
function extractJobFromJsonLd(jsonLd) {
    if (!jsonLd) return null;

    const items = Array.isArray(jsonLd['@graph'])
        ? jsonLd['@graph']
        : Array.isArray(jsonLd)
        ? jsonLd
        : [jsonLd];

    const posting = items.find((it) => {
        const type = it?.['@type'];
        if (!type) return false;
        if (Array.isArray(type)) return type.includes('JobPosting');
        return type === 'JobPosting';
    });

    if (!posting) return null;

    return {
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
}

// Parse fields (clearance, location, posted date, reference ID, description) from clean text
function extractFieldsFromText(pageTextRaw) {
    const text = pageTextRaw || '';

    const clearanceMatch = text.match(
        /Security Clearance:\s*([\s\S]*?)(?:\r?\n|\s{2,}|Location:|Posted:)/i
    );
    const securityClearance = clearanceMatch
        ? normalizeSpace(clearanceMatch[1])
        : null;

    const locationMatch = text.match(
        /Location:\s*([\s\S]*?)(?:\r?\n|\s{2,}|Relocation Assistance:|Remote\/Telework:|Description of Duties:|Posted:)/i
    );
    const location = locationMatch ? normalizeSpace(locationMatch[1]) : null;

    const postedMatch = text.match(
        /Posted:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i
    );
    const posted = postedMatch ? normalizeSpace(postedMatch[1]) : null;

    const referenceMatch = text.match(
        /Job Reference ID:\s*([A-Za-z0-9\-]+)/i
    );
    const referenceId = referenceMatch ? normalizeSpace(referenceMatch[1]) : null;

    const descMatch = text.match(
        /Description of Duties:\s*([\s\S]*?)(?:#####?\s*Job Information|Job Information\s*:|######\s*Job Information|Trending Job Titles|####\s*Job Information|##\s*Related jobs|####\s*Trending)/i
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

// ---------- MAIN ----------

await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};

        const {
            keywords = '',
            location = '',
            clearance_level = '',
            results_wanted: RESULTS_WANTED_RAW = 50,
            maxDirectoryPages: MAX_DIRECTORY_PAGES_RAW = 3,
            maxConcurrency = 5,
            maxRequestsPerCrawl = 5000,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
            ? Math.max(1, +RESULTS_WANTED_RAW)
            : 50;

        const MAX_DIRECTORY_PAGES = Number.isFinite(+MAX_DIRECTORY_PAGES_RAW)
            ? Math.max(1, +MAX_DIRECTORY_PAGES_RAW)
            : 3;

        log.info('Actor input', {
            keywords,
            location,
            clearance_level,
            RESULTS_WANTED,
            MAX_DIRECTORY_PAGES,
            maxConcurrency,
            maxRequestsPerCrawl,
        });

        const requestQueue = await Actor.openRequestQueue();
        const dataset = await Dataset.open();
        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration(proxyConfiguration)
            : null;

        // Seed: employer directory (page 1)
        await requestQueue.addRequest({
            url: EMPLOYER_DIRECTORY_URL,
            uniqueKey: 'employer-directory-1',
            userData: {
                label: 'EMPLOYER_DIRECTORY',
                pageNum: 1,
            },
        });

        let saved = 0;
        const seenJobUrls = new Set();

        const crawler = new CheerioCrawler({
            requestQueue,
            proxyConfiguration: proxyConf,
            maxConcurrency: maxConcurrency || 5,
            maxRequestsPerCrawl: maxRequestsPerCrawl || 5000,
            requestHandlerTimeoutSecs: 60,

            async requestHandler(context) {
                const { request, body } = context;
                const label = request.userData.label;
                const url = request.loadedUrl || request.url;

                if (!body || !url) return;

                // If we already have enough jobs, stop accepting new data
                if (saved >= RESULTS_WANTED) {
                    log.info(
                        `Already saved ${saved} jobs (>= results_wanted). No further processing needed.`
                    );
                    return;
                }

                const $ = cheerioLoad(body);

                if (label === 'EMPLOYER_DIRECTORY') {
                    const pageNum =
                        request.userData.pageNum ??
                        (() => {
                            const u = new URL(url);
                            const p = u.searchParams.get('page');
                            return p ? Number(p) || 1 : 1;
                        })();

                    if (pageNum > MAX_DIRECTORY_PAGES) {
                        log.info(
                            `Skipping employer directory page ${pageNum} (beyond maxDirectoryPages=${MAX_DIRECTORY_PAGES}).`
                        );
                        return;
                    }

                    log.info(`EMPLOYER_DIRECTORY page ${pageNum}: ${url}`);

                    // 1) Enqueue company pages
                    $('a[href*="/company/"]').each((_, el) => {
                        if (saved >= RESULTS_WANTED) return;

                        const href = $(el).attr('href');
                        if (!href) return;

                        const absolute = new URL(href, url).href;

                        // Only real company pages, e.g. /company/axiologic-solutions-325979
                        if (!/\/company\/[a-z0-9\-]+-\d+/i.test(absolute)) return;

                        requestQueue
                            .addRequest({
                                url: absolute,
                                userData: { label: 'COMPANY' },
                                uniqueKey: absolute.replace(/[#?].*$/, ''),
                            })
                            .catch(() => {});
                    });

                    // 2) Enqueue next directory pages (limited by MAX_DIRECTORY_PAGES)
                    $('a[href*="employer-directory"]').each((_, el) => {
                        const href = $(el).attr('href');
                        if (!href) return;
                        if (!/employer-directory.*page=/i.test(href)) return;

                        const absolute = new URL(href, url).href;
                        const u = new URL(absolute);
                        const pStr = u.searchParams.get('page');
                        const p = pStr ? Number(pStr) || 1 : 1;

                        if (p <= MAX_DIRECTORY_PAGES) {
                            requestQueue
                                .addRequest({
                                    url: absolute,
                                    userData: { label: 'EMPLOYER_DIRECTORY', pageNum: p },
                                    uniqueKey: `employer-directory-${p}`,
                                })
                                .catch(() => {});
                        }
                    });

                    return;
                }

                if (label === 'COMPANY') {
                    log.info(`COMPANY: ${url}`);

                    // On company pages, job links look like <a href="/job/...">Job Title</a>
                    $('a[href*="/job/"]').each((_, el) => {
                        if (saved >= RESULTS_WANTED) return;

                        const href = $(el).attr('href');
                        if (!href) return;
                        const absolute = new URL(href, url).href;

                        if (!/\/job\//i.test(absolute)) return;

                        if (seenJobUrls.has(absolute)) return;
                        seenJobUrls.add(absolute);

                        requestQueue
                            .addRequest({
                                url: absolute,
                                userData: { label: 'JOB' },
                                uniqueKey: absolute.replace(/[#?].*$/, ''),
                            })
                            .catch(() => {});
                    });

                    // IMPORTANT: we do NOT follow "View All Jobs" or any other search/taxonomy links
                    // here to keep the crawl tight and focused on actual job detail pages.
                    return;
                }

                if (label === 'JOB') {
                    if (saved >= RESULTS_WANTED) return;

                    log.info(`JOB: ${url}`);

                    const $body = cheerioLoad(body);

                    // 1) JSON-LD (preferred for title, description, company, etc.)
                    let jobFromLd = null;
                    $body('script[type="application/ld+json"]').each((_, el) => {
                        if (jobFromLd) return;
                        const raw = $body(el).contents().text();
                        const parsed = safeJsonParse(raw);
                        const j = extractJobFromJsonLd(parsed);
                        if (j) jobFromLd = j;
                    });

                    // 2) Clean text for field extraction, without JS/CSS
                    const textAll = getCleanBodyText($body);
                    const fields = extractFieldsFromText(textAll);

                    // 3) Header extraction (<h1>, nearby company/location)
                    const h1Text = normalizeSpace($body('h1').first().text() || '');
                    const headerContainer = $body('h1').first().parent();
                    const headerLinks = headerContainer.find('a');

                    const companyFromHeader = normalizeSpace(
                        headerLinks.eq(0).text() || ''
                    );
                    const locFromHeader = normalizeSpace(
                        headerLinks.eq(1).text() || ''
                    );

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
                        textAll ||
                        null;

                    const item = {
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

                    // Simple client-side filters (only if user actually provided them)
                    if (
                        keywords &&
                        !String(item.title || '')
                            .toLowerCase()
                            .includes(String(keywords).toLowerCase())
                    ) {
                        return;
                    }

                    if (
                        location &&
                        !String(item.location || '')
                            .toLowerCase()
                            .includes(String(location).toLowerCase())
                    ) {
                        return;
                    }

                    if (
                        clearance_level &&
                        !String(item.security_clearance || '')
                            .toLowerCase()
                            .includes(String(clearance_level).toLowerCase())
                    ) {
                        return;
                    }

                    await dataset.pushData(item);
                    saved += 1;
                    log.info(`Saved job #${saved}: ${item.title || '(no title)'}`);

                    return;
                }
            },

            failedRequestHandler({ request, error }) {
                log.error(
                    `Request ${request.url} failed too many times: ${
                        error?.message || error
                    }`
                );
            },
        });

        await crawler.run();

        log.info(
            `HTML crawl finished. Saved ${saved} jobs (requested up to ${RESULTS_WANTED}).`
        );
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
