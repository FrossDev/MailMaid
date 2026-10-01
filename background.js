/* ==========================================================================
 * MailMaid - background service worker
 *
 * PERFORMANCE DESIGN
 * ------------------
 * The scan runs in two phases.
 *
 * Phase 1 - fetch + classify
 *   CONFIG.CONCURRENCY message fetches are in flight at the same time. With
 *   CONCURRENCY = 25 one dispatch is exactly one "25 message" window, so a
 *   window of CONFIG.BATCH_WINDOW_MS (2000 ms) still meets the target even
 *   if a round trip takes up to ~2 seconds.
 *
 * Phase 2 - apply
 *   Every identical {add, remove} label change is grouped and sent as ONE
 *   users.messages.batchModify (up to 1000 ids) which costs 50 quota units
 *   for up to 1000 messages instead of 5 units each. Groups smaller than
 *   CONFIG.BATCH_MODIFY_MIN are applied with plain modify calls, because
 *   for a handful of messages a 50 unit batch call is the expensive option.
 *
 * Every request passes through a token bucket (QUOTA_UNITS_PER_SECOND) so the
 * extension stays below the Gmail per-user ceiling of 6,000 units / minute
 * (100 units / sec average), and every retryable failure (429, 5xx, network)
 * is retried with exponential backoff plus jitter. A 403 rateLimitExceeded
 * response is treated as a quota signal: the bucket is drained and both the
 * bucket and the request back off before retrying.
 *
 * DURABILITY
 * ----------
 * Progress is flushed to chrome.storage.local every CONFIG.FLUSH_EVERY_MESSAGES
 * messages (and at least every CONFIG.FLUSH_EVERY_MS), so an MV3 worker that
 * is terminated mid scan resumes instead of starting over.
 * ========================================================================== */

var CONFIG = {
    /* Parallelism and throughput target. */
    CONCURRENCY: 25,
    BATCH_TARGET: 25,
    BATCH_WINDOW_MS: 2000,

    /* Work limits. */
    MAX_PER_RUN: 5000,
    LIST_PAGE_SIZE: 500,
    MAX_SCANNED_IDS: 50000,

    /* Progress / persistence cadence. */
    PROGRESS_THROTTLE_MS: 200,
    FLUSH_EVERY_MESSAGES: 50,
    FLUSH_EVERY_MS: 2000,

    /* Gmail quota budget:
     * Google enforces 6,000 quota units / minute / user (average 100 units / sec).
     * Set rate to 90 units / sec with burst capacity up to 120 units to maintain
     * safe throughput without violating the per-minute quota window.
     */
    QUOTA_UNITS_PER_SECOND: 90,
    QUOTA_BUCKET_CAPACITY: 120,

    /* Retry policy. */
    RETRY_MAX: 6,
    RETRY_BASE_MS: 1000,
    RETRY_MAX_MS: 65000,

    /* Forwarding: "send" costs 100 quota units, so it gets its own queue. */
    FORWARD_CONCURRENCY: 1,

    /* Groups of this size or larger are applied with batchModify. */
    BATCH_MODIFY_MIN: 10,
    BATCH_MODIFY_MAX_IDS: 1000
};

/* Quota unit cost per Gmail method (official Gmail API table). */
var QUOTA_COST = {
    list: 5,
    get: 5,
    modify: 5,
    batchModify: 50,
    send: 100,
    labelsList: 1,
    threadsModify: 10
};

var API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/* Label ids used by the rule actions. */
var INBOX_ID = "INBOX";
var UNREAD_ID = "UNREAD";
var STARRED_ID = "STARRED";
var SPAM_ID = "SPAM";
var TRASH_ID = "TRASH";
var IMPORTANT_ID = "IMPORTANT";

/* Gmail allows exactly one category per message. The settings UI only offers
 * the inbox categories, so those are the five ids we manage. */
var CATEGORY_MAP = {
    primary: "CATEGORY_PERSONAL",
    social: "CATEGORY_SOCIAL",
    promotions: "CATEGORY_PROMOTIONS",
    updates: "CATEGORY_UPDATES",
    forums: "CATEGORY_FORUMS"
};

var CATEGORY_IDS = [
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS"
];

/* --------------------------------------------------------------------------
 * Shared state
 * ------------------------------------------------------------------------ */

var scanStatus = {
    running: false,
    processed: 0,
    matched: 0,
    total: 0,
    startedAt: 0,
    rate: 0,
    goalRate: CONFIG.BATCH_TARGET / (CONFIG.BATCH_WINDOW_MS / 1000),
    phase: "idle",
    forwarding: 0
};

var auth = {
    token: null
};

/* name(lowercased) -> label id, filled from users.labels.list. */
var labelIdByName = null;

/* --------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

function sleep(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

function getAction(rule) {
    return (rule && rule.actions) || rule || {};
}

function getRuleText(rule, field) {
    return String((rule && rule[field]) || "");
}

/* --------------------------------------------------------------------------
 * Quota token bucket
 *
 * acquire(units) resolves once that many units may be spent. One bucket is
 * shared by every request, forwarding included, because the Gmail quota is
 * shared by the whole extension.
 * ------------------------------------------------------------------------ */

function createTokenBucket(unitsPerSecond, customCapacity) {
    var capacity = Math.max(customCapacity || unitsPerSecond, 1);
    var tokens = capacity;
    var lastRefill = Date.now();
    var waiters = [];
    var timer = null;

    function refill() {
        var now = Date.now();
        var elapsed = (now - lastRefill) / 1000;

        if (elapsed > 0) {
            tokens = Math.min(capacity, tokens + (elapsed * unitsPerSecond));
            lastRefill = now;
        }
    }

    function schedule() {
        if (timer || waiters.length === 0) {
            return;
        }

        refill();

        var missing = Math.max(waiters[0].units - tokens, 0);
        var waitMs = Math.ceil((missing / unitsPerSecond) * 1000);

        timer = setTimeout(function () {
            timer = null;
            pump();
        }, Math.max(waitMs, 20));
    }

    function pump() {
        refill();

        while (waiters.length > 0 && tokens >= waiters[0].units) {
            tokens -= waiters[0].units;
            waiters.shift().resolve();
        }

        if (waiters.length > 0) {
            schedule();
        }
    }

    return {
        acquire: function (units) {
            var cost = Math.max(Number(units) || 1, 1);

            return new Promise(function (resolve) {
                waiters.push({ units: cost, resolve: resolve });
                pump();
            });
        },
        throttle: function (pauseMs) {
            /* Deplete bucket and delay next replenishment when rate limits occur */
            tokens = 0;
            lastRefill = Date.now() + Math.max(pauseMs || 0, 0);
        }
    };
}

var quotaBucket = createTokenBucket(
    CONFIG.QUOTA_UNITS_PER_SECOND,
    CONFIG.QUOTA_BUCKET_CAPACITY
);

/* --------------------------------------------------------------------------
 * Generic concurrency pool
 *
 * runPool(items, limit, worker) keeps "limit" workers busy until every item
 * has been handed to "worker". This is what replaces the old one-at-a-time
 * for() loop.
 * ------------------------------------------------------------------------ */

async function runPool(items, limit, worker) {
    var next = 0;
    var runners = [];
    var width = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));

    for (var w = 0; w < width; w++) {
        runners.push((async function () {
            while (true) {
                var index = next++;

                if (index >= items.length) {
                    return;
                }

                await worker(items[index], index);
            }
        })());
    }

    await Promise.all(runners);
}

/* --------------------------------------------------------------------------
 * Authentication
 * ------------------------------------------------------------------------ */

function getToken(interactive) {
    return new Promise(function (resolve, reject) {
        chrome.identity.getAuthToken(
            { interactive: !!interactive },
            function (token) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                if (!token) {
                    reject(new Error("No Google authentication token"));
                    return;
                }

                resolve(token);
            }
        );
    });
}

function removeCachedToken(token) {
    return new Promise(function (resolve) {
        if (!token) {
            resolve();
            return;
        }

        try {
            chrome.identity.removeCachedAuthToken({ token: token }, function () {
                resolve();
            });
        } catch (error) {
            resolve();
        }
    });
}

/* Silent first so a scan never pops a consent dialog part way through. */
async function acquireToken() {
    try {
        return await getToken(false);
    } catch (silentError) {
        return await getToken(true);
    }
}

/* --------------------------------------------------------------------------
 * HTTP layer
 * ------------------------------------------------------------------------ */

function isRetryableStatus(status) {
    return status === 429 || status === 500 || status === 502 ||
        status === 503 || status === 504;
}

function backoffDelay(attempt, response) {
    if (response && response.headers && response.headers.get) {
        var retryAfter = response.headers.get("Retry-After");

        if (retryAfter) {
            var seconds = Number(retryAfter);

            if (!isNaN(seconds) && seconds > 0) {
                return Math.min(seconds * 1000, CONFIG.RETRY_MAX_MS);
            }
        }
    }

    var base = CONFIG.RETRY_BASE_MS * Math.pow(2, attempt - 1);
    var jitter = Math.random() * base * 0.3;

    return Math.min(base + jitter, CONFIG.RETRY_MAX_MS);
}

function parseJsonSafe(text) {
    if (!text) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        return {};
    }
}

function isQuotaExceededResponse(status, text) {
    if (status !== 403 && status !== 429) {
        return false;
    }

    var str = String(text || "").toLowerCase();
    return str.includes("ratelimitexceeded") ||
        str.includes("userratelimitexceeded") ||
        str.includes("quota exceeded") ||
        str.includes("total query cost") ||
        str.includes("units per minute");
}

/*
 * apiRequest(url, options, quotaUnits)
 *
 * Adds the bearer token, waits for quota budget, retries transient failures
 * (including a dead token and 403 rateLimitExceeded) and throws on hard failures.
 */
async function apiRequest(url, options, quotaUnits) {
    var opts = options || {};
    var attempt = 0;

    while (true) {
        await quotaBucket.acquire(quotaUnits);

        var headers = Object.assign({}, opts.headers || {});

        if (auth.token) {
            headers.Authorization = "Bearer " + auth.token;
        }

        var response;

        try {
            response = await fetch(url, {
                method: opts.method || "GET",
                headers: headers,
                body: opts.body
            });
        } catch (networkError) {
            if (attempt >= CONFIG.RETRY_MAX) {
                throw networkError;
            }

            attempt++;
            await sleep(backoffDelay(attempt));
            continue;
        }

        /* Expired token: drop the cached copy and retry with a fresh one. */
        if (response.status === 401 && attempt < CONFIG.RETRY_MAX) {
            await removeCachedToken(auth.token);
            auth.token = null;

            try {
                auth.token = await acquireToken();
            } catch (tokenError) {
                /* fall through and retry; the next call will surface it */
            }

            attempt++;
            continue;
        }

        if (isRetryableStatus(response.status) && attempt < CONFIG.RETRY_MAX) {
            attempt++;
            await sleep(backoffDelay(attempt, response));
            continue;
        }

        if (!response.ok) {
            var errorText = await response.text();

            /* Handle 403 rateLimitExceeded / quota exceeded gracefully with backoff */
            if (isQuotaExceededResponse(response.status, errorText) && attempt < CONFIG.RETRY_MAX) {
                attempt++;
                var delay = Math.max(backoffDelay(attempt, response), 2000 * Math.pow(2, attempt - 1));
                quotaBucket.throttle(delay);
                await sleep(delay);
                continue;
            }

            throw new Error(
                "Gmail API error " + response.status + ": " + errorText
            );
        }

        if (response.status === 204) {
            return {};
        }

        return parseJsonSafe(await response.text());
    }
}

/* --------------------------------------------------------------------------
 * Encoding helpers
 * ------------------------------------------------------------------------ */

function bytesToBase64(bytes) {
    var chunkSize = 0x8000;
    var parts = [];

    for (var i = 0; i < bytes.length; i += chunkSize) {
        parts.push(
            String.fromCharCode.apply(
                null,
                bytes.subarray(i, i + chunkSize)
            )
        );
    }

    return btoa(parts.join(""));
}

function utf8ToBase64(text) {
    return bytesToBase64(new TextEncoder().encode(String(text || "")));
}

/* Charset-agnostic byte view: every char code truncated to one byte. */
function textToBytes(text) {
    var source = String(text || "");
    var bytes = new Uint8Array(source.length);

    for (var i = 0; i < source.length; i++) {
        bytes[i] = source.charCodeAt(i) & 0xff;
    }

    return bytes;
}

/* Gmail expects base64url without padding for the raw field. */
function base64ToBase64Url(base64) {
    return String(base64 || "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function base64UrlToBase64(data) {
    var base64 = String(data || "")
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    while (base64.length % 4) {
        base64 += "=";
    }

    return base64;
}

function wrapBase64(base64, width) {
    var size = width || 76;
    var lines = [];

    for (var i = 0; i < base64.length; i += size) {
        lines.push(base64.substr(i, size));
    }

    return lines.join("\r\n");
}

function base64ToBytes(base64) {
    var binary = atob(String(base64 || "").replace(/\s+/g, ""));
    var bytes = new Uint8Array(binary.length);

    for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

function decodeBytes(bytes, charset) {
    var label = String(charset || "utf-8")
        .replace(/["']/g, "")
        .trim()
        .toLowerCase();

    if (label === "utf8" || label === "utf-8" || !label) {
        label = "utf-8";
    } else if (label === "latin1" || label === "iso8859-1") {
        label = "iso-8859-1";
    }

    try {
        return new TextDecoder(label).decode(new Uint8Array(bytes));
    } catch (error) {
        return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    }
}

function decodeBase64Url(data) {
    if (!data) {
        return "";
    }

    try {
        return decodeBytes(base64ToBytes(base64UrlToBase64(data)), "utf-8");
    } catch (error) {
        return "";
    }
}

/* "=3D" / soft line breaks -> raw bytes (charset is decoded afterwards). */
function decodeQuotedPrintableToBytes(text) {
    var source = String(text || "");
    var bytes = [];

    for (var i = 0; i < source.length; i++) {
        var ch = source.charAt(i);

        if (ch === "=") {
            var next = source.charAt(i + 1);

            if (next === "\r" && source.charAt(i + 2) === "\n") {
                i += 2;
                continue;
            }

            if (next === "\n") {
                i += 1;
                continue;
            }

            var hex = source.substr(i + 1, 2);

            if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                bytes.push(parseInt(hex, 16));
                i += 2;
                continue;
            }
        }

        bytes.push(ch.charCodeAt(0) & 0xff);
    }

    return bytes;
}

/* RFC 2047 encoded words: =?UTF-8?B?...?= and =?UTF-8?Q?...?= */
function decodeHeaderValue(value) {
    var text = String(value || "");

    if (text.indexOf("=?") === -1) {
        return text;
    }

    return text.replace(
        /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
        function (match, charset, encoding, payload) {
            try {
                if (encoding.toUpperCase() === "B") {
                    return decodeBytes(
                        base64ToBytes(payload),
                        charset
                    );
                }

                return decodeBytes(
                    decodeQuotedPrintableToBytes(payload.replace(/_/g, " ")),
                    charset
                );
            } catch (error) {
                return match;
            }
        }
    );
}

/* --------------------------------------------------------------------------
 * MIME parsing (used by format=raw, where payload is not populated)
 * ------------------------------------------------------------------------ */

function parseHeaderBlock(headerText) {
    var headers = {};
    var lines = String(headerText || "").split(/\r?\n/);
    var current = null;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        if (!line) {
            continue;
        }

        /* Folded header: continuation lines start with whitespace. */
        if (/^[ \t]/.test(line)) {
            if (current) {
                headers[current] += " " + line.trim();
            }

            continue;
        }

        var separator = line.indexOf(":");

        if (separator === -1) {
            current = null;
            continue;
        }

        current = line.slice(0, separator).trim().toLowerCase();
        headers[current] = line.slice(separator + 1).trim();
    }

    return headers;
}

function parseMimeEntity(text) {
    var source = String(text || "");
    var crlfIndex = source.indexOf("\r\n\r\n");
    var lfIndex = source.indexOf("\n\n");
    var splitIndex = -1;

    if (crlfIndex !== -1 && (lfIndex === -1 || crlfIndex <= lfIndex)) {
        splitIndex = crlfIndex + 4;
    } else if (lfIndex !== -1) {
        splitIndex = lfIndex + 2;
    }

    if (splitIndex === -1) {
        return { headers: parseHeaderBlock(source), body: "" };
    }

    return {
        headers: parseHeaderBlock(source.slice(0, splitIndex)),
        body: source.slice(splitIndex)
    };
}

function getContentTypeParam(contentType, name) {
    var pattern = new RegExp(
        name + '\\s*=\\s*("?)([^";\\r\\n]+)\\1',
        "i"
    );
    var match = pattern.exec(String(contentType || ""));

    return match ? match[2].trim() : "";
}

function splitByBoundary(body, boundary) {
    var marker = "--" + boundary;
    var lines = String(body || "").split(/\r?\n/);
    var parts = [];
    var current = null;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\s+$/, "");

        if (line.indexOf(marker) === 0) {
            if (current !== null) {
                parts.push(current.join("\r\n"));
            }

            if (line.indexOf(marker + "--") === 0) {
                return parts;
            }

            current = [];
            continue;
        }

        if (current !== null) {
            current.push(lines[i]);
        }
    }

    if (current !== null) {
        parts.push(current.join("\r\n"));
    }

    return parts;
}

function decodeEntityBody(body, encoding, charset) {
    var transfer = String(encoding || "").toLowerCase().trim();

    if (transfer === "base64") {
        try {
            return decodeBytes(base64ToBytes(body), charset);
        } catch (error) {
            return "";
        }
    }

    if (transfer === "quoted-printable") {
        return decodeBytes(decodeQuotedPrintableToBytes(body), charset);
    }

    return decodeBytes(textToBytes(body), charset);
}

function extractTextFromRawEntity(entity, depth) {
    if (!entity || depth > 12) {
        return "";
    }

    var headers = entity.headers || {};
    var contentType = String(headers["content-type"] || "text/plain");
    var lowerType = contentType.toLowerCase();
    var body = entity.body || "";

    if (lowerType.indexOf("multipart/") === 0) {
        var boundary = getContentTypeParam(contentType, "boundary");

        if (!boundary) {
            return "";
        }

        var parts = splitByBoundary(body, boundary);
        var collected = "";

        for (var i = 0; i < parts.length; i++) {
            collected += "\n" + extractTextFromRawEntity(
                parseMimeEntity(parts[i]),
                (depth || 0) + 1
            );
        }

        return collected;
    }

    if (lowerType.indexOf("text/plain") !== 0) {
        return "";
    }

    return decodeEntityBody(
        body,
        headers["content-transfer-encoding"],
        getContentTypeParam(contentType, "charset")
    );
}

/* --------------------------------------------------------------------------
 * Message data
 * ------------------------------------------------------------------------ */

function getHeader(headers, name) {
    if (!headers) {
        return "";
    }

    var wanted = String(name).toLowerCase();

    for (var i = 0; i < headers.length; i++) {
        if (
            headers[i].name &&
            String(headers[i].name).toLowerCase() === wanted
        ) {
            return headers[i].value || "";
        }
    }

    return "";
}

function extractTextFromPart(part) {
    if (!part) {
        return "";
    }

    var result = "";

    if (
        part.mimeType === "text/plain" &&
        part.body &&
        part.body.data
    ) {
        result += decodeBase64Url(part.body.data);
    }

    if (part.parts) {
        for (var i = 0; i < part.parts.length; i++) {
            result += "\n" + extractTextFromPart(part.parts[i]);
        }
    }

    return result;
}

/*
 * Which fetch format does this rule set actually need?
 *
 *   raw      - a rule forwards, so we need the original RFC 822 source
 *   full     - a rule matches on the message body
 *   metadata - headers only, which is a fraction of the payload size
 */
function resolveFetchFormat(rules) {
    var needsRaw = false;
    var needsFull = false;

    for (var i = 0; i < rules.length; i++) {
        var actions = getAction(rules[i]);

        if (actions.forward) {
            needsRaw = true;
        }

        if (
            getRuleText(rules[i], "messageContains") ||
            getRuleText(rules[i], "messageNotContains")
        ) {
            needsFull = true;
        }
    }

    if (needsRaw) {
        return "raw";
    }

    if (needsFull) {
        return "full";
    }

    return "metadata";
}

function extractMessageData(message, format) {
    if (format === "raw") {
        var entity = parseMimeEntity(decodeBase64Url(message.raw || ""));
        var headers = entity.headers || {};

        return {
            from: decodeHeaderValue(headers.from || ""),
            to: decodeHeaderValue(headers.to || ""),
            subject: decodeHeaderValue(headers.subject || ""),
            body: extractTextFromRawEntity(entity, 0)
        };
    }

    var headerList = (message.payload && message.payload.headers) || [];

    return {
        from: getHeader(headerList, "From"),
        to: getHeader(headerList, "To"),
        subject: getHeader(headerList, "Subject"),
        body: message.payload ? extractTextFromPart(message.payload) : ""
    };
}

/* --------------------------------------------------------------------------
 * Rule matching
 * ------------------------------------------------------------------------ */

function containsText(value, search) {
    if (!search) {
        return false;
    }

    return String(value || "")
        .toLowerCase()
        .indexOf(String(search).toLowerCase()) !== -1;
}

function containsAnyText(value, searches) {
    var haystack = String(value || "").toLowerCase();
    var needles = String(searches || "").split(",");

    for (var i = 0; i < needles.length; i++) {
        var needle = needles[i].trim();

        if (needle && haystack.indexOf(needle.toLowerCase()) !== -1) {
            return true;
        }
    }

    return false;
}

function ruleMatches(rule, data) {
    if (!rule) {
        return false;
    }

    var fromContains = getRuleText(rule, "fromContains");
    var fromNotContains = getRuleText(rule, "fromNotContains");
    var toContains = getRuleText(rule, "toContains");
    var toNotContains = getRuleText(rule, "toNotContains");
    var subjectContains = getRuleText(rule, "subjectContains");
    var subjectNotContains = getRuleText(rule, "subjectNotContains");
    var messageContains = getRuleText(rule, "messageContains");
    var messageNotContains = getRuleText(rule, "messageNotContains");

    if (fromContains && !containsAnyText(data.from, fromContains)) {
        return false;
    }

    if (fromNotContains && containsAnyText(data.from, fromNotContains)) {
        return false;
    }

    if (toContains && !containsAnyText(data.to, toContains)) {
        return false;
    }

    if (toNotContains && containsAnyText(data.to, toNotContains)) {
        return false;
    }

    if (subjectContains && !containsAnyText(data.subject, subjectContains)) {
        return false;
    }

    if (
        subjectNotContains &&
        containsAnyText(data.subject, subjectNotContains)
    ) {
        return false;
    }

    if (messageContains && !containsAnyText(data.body, messageContains)) {
        return false;
    }

    if (
        messageNotContains &&
        containsAnyText(data.body, messageNotContains)
    ) {
        return false;
    }

    return true;
}

/* --------------------------------------------------------------------------
 * Label name -> id resolution
 * ------------------------------------------------------------------------ */

function normalizeLabelName(name) {
    return String(name || "").trim().toLowerCase();
}

async function loadLabelMap(rules) {
    var needed = false;

    for (var i = 0; i < rules.length; i++) {
        if (getAction(rules[i]).label) {
            needed = true;
            break;
        }
    }

    if (!needed) {
        labelIdByName = {};
        return;
    }

    if (labelIdByName && Object.keys(labelIdByName).length > 0) {
        return;
    }

    var data = await apiRequest(
        API_BASE + "/labels?fields=" + encodeURIComponent("labels(id,name)"),
        { method: "GET" },
        QUOTA_COST.labelsList
    );

    var map = {};

    (data.labels || []).forEach(function (label) {
        if (label && label.name && label.id) {
            map[normalizeLabelName(label.name)] = label.id;
        }
    });

    labelIdByName = map;
}

function resolveLabelId(name) {
    if (!labelIdByName) {
        return "";
    }

    return labelIdByName[normalizeLabelName(name)] || "";
}

/* --------------------------------------------------------------------------
 * Action aggregation
 *
 * A message can match several rules, and every old implementation sent one
 * modify request per action. Instead all actions are accumulated here and
 * collapsed into a single {add, remove} pair, which is applied with one
 * request per message (or one batchModify per group of messages).
 * ------------------------------------------------------------------------ */

function isEmailAddress(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function createActionAccumulator() {
    return {
        add: new Set(),
        remove: new Set(),
        forwards: [],
        seenForward: {},
        matched: false,
        wantImportant: false,
        wantNotImportant: false,
        categoryId: ""
    };
}

function accumulateMessageActions(acc, actions) {
    acc.matched = true;

    if (actions.archive) {
        acc.remove.add(INBOX_ID);
    }

    if (actions.markRead) {
        acc.remove.add(UNREAD_ID);
    }

    if (actions.star) {
        acc.add.add(STARRED_ID);
    }

    if (actions.neverSpam) {
        acc.remove.add(SPAM_ID);
    }

    if (actions.delete) {
        acc.add.add(TRASH_ID);
    }

    if (actions.important) {
        acc.wantImportant = true;
    }

    if (actions.notImportant) {
        acc.wantNotImportant = true;
    }

    if (actions.category) {
        var mapped = CATEGORY_MAP[String(actions.category).toLowerCase()];

        if (mapped) {
            acc.categoryId = mapped;
        }
    }

    if (actions.label) {
        var labelId = resolveLabelId(actions.label);

        if (labelId) {
            acc.add.add(labelId);
        }
    }

    if (actions.forward) {
        var address = String(actions.forward).trim();
        var key = address.toLowerCase();

        if (isEmailAddress(address) && !acc.seenForward[key]) {
            acc.seenForward[key] = true;
            acc.forwards.push(address);
        }
    }
}

/* "Also apply to matching conversations" only carries the label actions. */
function accumulateThreadActions(acc, actions) {
    acc.matched = true;

    if (actions.archive) {
        acc.remove.add(INBOX_ID);
    }

    if (actions.markRead) {
        acc.remove.add(UNREAD_ID);
    }

    if (actions.star) {
        acc.add.add(STARRED_ID);
    }

    if (actions.neverSpam) {
        acc.remove.add(SPAM_ID);
    }

    if (actions.delete) {
        acc.add.add(TRASH_ID);
    }

    if (actions.label) {
        var labelId = resolveLabelId(actions.label);

        if (labelId) {
            acc.add.add(labelId);
        }
    }
}

/*
 * Turns the accumulated sets into the two arrays Gmail wants.
 *
 * currentLabels === null means "unknown" (threads), in which case removals are
 * always sent because removing a label that is not set is a harmless no-op.
 */
function finalizeAccumulator(acc, currentLabels) {
    var known = Array.isArray(currentLabels);
    var current = {};
    var i;

    if (known) {
        for (i = 0; i < currentLabels.length; i++) {
            current[currentLabels[i]] = true;
        }
    }

    /* "Never important" beats "important" when rules disagree. */
    if (acc.wantNotImportant) {
        acc.add.delete(IMPORTANT_ID);
        acc.remove.add(IMPORTANT_ID);
    } else if (acc.wantImportant) {
        acc.remove.delete(IMPORTANT_ID);
        acc.add.add(IMPORTANT_ID);
    }

    /* Gmail permits exactly one category, so the others are cleared. */
    if (acc.categoryId) {
        for (i = 0; i < CATEGORY_IDS.length; i++) {
            if (CATEGORY_IDS[i] === acc.categoryId) {
                acc.add.add(CATEGORY_IDS[i]);
            } else {
                acc.remove.add(CATEGORY_IDS[i]);
            }
        }
    }

    var add = [];
    var remove = [];

    acc.add.forEach(function (id) {
        if (acc.remove.has(id)) {
            return;
        }

        if (known && current[id]) {
            return;
        }

        add.push(id);
    });

    acc.remove.forEach(function (id) {
        if (acc.add.has(id)) {
            return;
        }

        if (known && !current[id]) {
            return;
        }

        remove.push(id);
    });

    return { add: add, remove: remove };
}

function buildLabelChanges(rules, data, currentLabels) {
    var messageAcc = createActionAccumulator();
    var threadAcc = createActionAccumulator();
    var hasThreadActions = false;

    for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];

        if (!ruleMatches(rule, data)) {
            continue;
        }

        var actions = getAction(rule);

        accumulateMessageActions(messageAcc, actions);

        if (actions.applyToConversations) {
            hasThreadActions = true;
            accumulateThreadActions(threadAcc, actions);
        }
    }

    var messageChanges = finalizeAccumulator(messageAcc, currentLabels);

    return {
        matched: messageAcc.matched,
        add: messageChanges.add,
        remove: messageChanges.remove,
        forwards: messageAcc.forwards,
        conversation: hasThreadActions
            ? finalizeAccumulator(threadAcc, null)
            : null
    };
}

/* --------------------------------------------------------------------------
 * Gmail API wrappers
 * ------------------------------------------------------------------------ */

function chunkArray(items, size) {
    var chunks = [];

    for (var i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }

    return chunks;
}

async function listMessages(afterTimestamp) {
    var results = [];
    var pageToken = null;
    var query = "";

    if (afterTimestamp) {
        /*
         * "after:" only has second granularity, so step back one second and
         * let the scanned-id set absorb the overlap. It also guarantees that
         * mail arriving while a run is in flight is picked up by the next run.
         */
        query = "after:" + Math.floor(Math.max(afterTimestamp - 1000, 0) / 1000);
    }

    do {
        var url = API_BASE + "/messages?maxResults=" + CONFIG.LIST_PAGE_SIZE +
            "&fields=" + encodeURIComponent("messages(id,threadId),nextPageToken");

        if (query) {
            url += "&q=" + encodeURIComponent(query);
        }

        if (pageToken) {
            url += "&pageToken=" + encodeURIComponent(pageToken);
        }

        var data = await apiRequest(url, { method: "GET" }, QUOTA_COST.list);
        var batch = data.messages || [];

        for (var i = 0; i < batch.length; i++) {
            results.push(batch[i]);
        }

        pageToken = data.nextPageToken || null;
    } while (pageToken);

    return results;
}

function getMessage(id, format) {
    var url = API_BASE + "/messages/" + encodeURIComponent(id);

    if (format === "metadata") {
        url += "?format=metadata" +
            "&metadataHeaders=From" +
            "&metadataHeaders=To" +
            "&metadataHeaders=Subject";
    } else {
        url += "?format=" + encodeURIComponent(format || "full");
    }

    return apiRequest(url, { method: "GET" }, QUOTA_COST.get);
}

function modifyMessage(id, addLabelIds, removeLabelIds) {
    return apiRequest(
        API_BASE + "/messages/" + encodeURIComponent(id) + "/modify",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                addLabelIds: addLabelIds || [],
                removeLabelIds: removeLabelIds || []
            })
        },
        QUOTA_COST.modify
    );
}

function batchModifyMessages(ids, addLabelIds, removeLabelIds) {
    return apiRequest(
        API_BASE + "/messages/batchModify",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ids: ids,
                addLabelIds: addLabelIds || [],
                removeLabelIds: removeLabelIds || []
            })
        },
        QUOTA_COST.batchModify
    );
}

function modifyThread(threadId, addLabelIds, removeLabelIds) {
    return apiRequest(
        API_BASE + "/threads/" + encodeURIComponent(threadId) + "/modify",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                addLabelIds: addLabelIds || [],
                removeLabelIds: removeLabelIds || []
            })
        },
        QUOTA_COST.threadsModify
    );
}

function sendRawMessage(rawBase64Url) {
    return apiRequest(
        API_BASE + "/messages/send",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ raw: rawBase64Url })
        },
        QUOTA_COST.send
    );
}

/* --------------------------------------------------------------------------
 * Forwarding
 * ------------------------------------------------------------------------ */

function encodeHeaderValue(value) {
    var text = String(value || "").replace(/[\r\n]+/g, " ").trim();

    if (/^[\x20-\x7e]*$/.test(text)) {
        return text;
    }

    return "=?UTF-8?B?" + utf8ToBase64(text) + "?=";
}

/*
 * Builds "Fwd:" mail. The original message is attached verbatim as a
 * message/rfc822 part, so every header and attachment survives untouched and
 * no MIME surgery is needed on the source.
 */
function buildForwardMime(rawBase64Url, data, toAddress) {
    var boundary = "mailmaid-" + Date.now().toString(36) + "-" +
        Math.random().toString(36).slice(2, 10);

    var subject = data.subject || "";
    var forwardSubject = /^fwd:/i.test(subject.trim())
        ? subject
        : "Fwd: " + subject;

    var note = [
        "---------- Forwarded message ----------",
        "From: " + (data.from || ""),
        "To: " + (data.to || ""),
        "Subject: " + subject,
        "",
        (data.body || "").trim()
    ].join("\r\n") + "\r\n";

    var lines = [
        "To: " + encodeHeaderValue(toAddress),
        "Subject: " + encodeHeaderValue(forwardSubject),
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="' + boundary + '"',
        "",
        "--" + boundary,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(utf8ToBase64(note)),
        "",
        "--" + boundary,
        "Content-Type: message/rfc822",
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(base64UrlToBase64(rawBase64Url)),
        "",
        "--" + boundary + "--",
        ""
    ];

    return lines.join("\r\n");
}

async function forwardMessage(originalRaw, data, toAddress) {
    if (!originalRaw) {
        throw new Error("Original message source unavailable for forwarding");
    }

    var mime = buildForwardMime(originalRaw, data, toAddress);

    return sendRawMessage(base64ToBase64Url(utf8ToBase64(mime)));
}

/* --------------------------------------------------------------------------
 * Progress reporting
 * ------------------------------------------------------------------------ */

function safeSendMessage(message) {
    try {
        chrome.runtime.sendMessage(message, function () {
            /*
             * Read lastError so Chrome does not log "Unchecked runtime.lastError".
             * The popup is normally closed, or its listener does not answer
             * broadcasts - both close the port without a response, which is
             * expected and harmless here.
             */
            void chrome.runtime.lastError;
        });
    } catch (error) {
        /* A closed popup is not an error worth surfacing. */
    }
}

var progressMeter = {
    lastSentAt: 0
};

/* Messages per second for the current run. */
function computeRate() {
    if (scanStatus.startedAt <= 0) {
        return 0;
    }

    var elapsed = (Date.now() - scanStatus.startedAt) / 1000;

    if (elapsed <= 0) {
        return 0;
    }

    return scanStatus.processed / elapsed;
}

function progressPayload() {
    return {
        action: "progress",
        processed: scanStatus.processed,
        matched: scanStatus.matched,
        total: scanStatus.total,
        rate: scanStatus.rate,
        goal: scanStatus.goalRate,
        phase: scanStatus.phase,
        forwarding: scanStatus.forwarding
    };
}

/*
 * Throttled progress. One runtime message per processed message was harmless
 * for a sequential scanner but would flood the channel with 25 requests in
 * flight, so the UI is refreshed at most every CONFIG.PROGRESS_THROTTLE_MS.
 */
function sendProgress(force) {
    var now = Date.now();

    if (!force && (now - progressMeter.lastSentAt) < CONFIG.PROGRESS_THROTTLE_MS) {
        return;
    }

    progressMeter.lastSentAt = now;
    scanStatus.rate = computeRate();

    safeSendMessage(progressPayload());
}

/* --------------------------------------------------------------------------
 * Run state + persistence
 *
 * scannedMessageIds, the pending queue and the live counters are flushed every
 * CONFIG.FLUSH_EVERY_MESSAGES messages (and at least every FLUSH_EVERY_MS) so
 * a worker that is killed mid scan resumes instead of starting over.
 * ------------------------------------------------------------------------ */

var scanState = {
    scannedIds: [],
    scanned: new Set(),
    pending: [],
    pendingForwards: [],
    previousProcessed: 0,
    previousMatched: 0
};

var flushMeter = {
    sinceLastFlush: 0,
    lastFlushAt: 0
};

async function flushRunState(force) {
    var now = Date.now();

    if (!force) {
        var byCount =
            flushMeter.sinceLastFlush >= CONFIG.FLUSH_EVERY_MESSAGES;
        var byTime =
            (now - flushMeter.lastFlushAt) >= CONFIG.FLUSH_EVERY_MS;

        if (!byCount && !byTime) {
            return;
        }
    }

    flushMeter.sinceLastFlush = 0;
    flushMeter.lastFlushAt = now;

    await chrome.storage.local.set({
        scannedMessageIds: scanState.scannedIds,
        pendingMessageIds: scanState.pending,
        scanProcessed: scanStatus.processed,
        scanMatched: scanStatus.matched,
        scanTotal: scanStatus.total,
        lastRunIncomplete: true
    });
}

/*
 * Keep the dedupe set bounded. Older ids cannot be needed because the scan
 * cursor only ever moves forward.
 */
function pruneScannedIds() {
    var max = CONFIG.MAX_SCANNED_IDS;

    if (scanState.scannedIds.length <= max) {
        return;
    }

    scanState.scannedIds =
        scanState.scannedIds.slice(scanState.scannedIds.length - max);
    scanState.scanned = new Set(scanState.scannedIds);
}

function signatureOf(add, remove) {
    return add.slice().sort().join(",") +
        "|" +
        remove.slice().sort().join(",");
}

/* --------------------------------------------------------------------------
 * Phase 1 - build the work list and classify messages in parallel
 * ------------------------------------------------------------------------ */

async function buildTargetList(lastScanTime) {
    var targets = [];
    var queued = new Set();
    var i;

    /* Anything left over from a capped or killed run is done first. */
    for (i = 0; i < scanState.pending.length; i++) {
        var entry = scanState.pending[i];
        var pendingId = typeof entry === "string" ? entry : (entry && entry.id);

        if (!pendingId || scanState.scanned.has(pendingId) || queued.has(pendingId)) {
            continue;
        }

        queued.add(pendingId);
        targets.push({
            id: pendingId,
            threadId: (entry && entry.threadId) || null
        });
    }

    var listed = await listMessages(lastScanTime);

    for (i = 0; i < listed.length; i++) {
        var message = listed[i];

        if (!message || !message.id) {
            continue;
        }

        if (scanState.scanned.has(message.id) || queued.has(message.id)) {
            continue;
        }

        queued.add(message.id);
        targets.push({
            id: message.id,
            threadId: message.threadId || null
        });
    }

    var overflow = [];

    /*
     * Everything past the cap is queued for the next alarm tick, so a run
     * always finishes inside the worker lifetime instead of being killed.
     */
    if (targets.length > CONFIG.MAX_PER_RUN) {
        overflow = targets.slice(CONFIG.MAX_PER_RUN);
        targets = targets.slice(0, CONFIG.MAX_PER_RUN);
    }

    return { targets: targets, overflow: overflow };
}

async function classifyMessages(targets, rules, fetchFormat) {
    var outcomes = [];

    await runPool(targets, CONFIG.CONCURRENCY, async function (target) {
        try {
            var message = await getMessage(target.id, fetchFormat);
            var data = extractMessageData(message, fetchFormat);
            var changes = buildLabelChanges(rules, data, message.labelIds);
            var needsSource = changes.forwards.length > 0;

            outcomes.push({
                id: target.id,
                threadId: target.threadId || message.threadId || null,
                add: changes.add,
                remove: changes.remove,
                forwards: changes.forwards,
                conversation: changes.conversation,
                /*
                 * The raw source can be hundreds of kilobytes, so it is kept
                 * only when the message is really going to be forwarded.
                 */
                raw: needsSource ? (message.raw || "") : "",
                data: needsSource ? data : null
            });

            if (changes.matched) {
                scanStatus.matched++;
            }

            /*
             * Only recorded once the fetch succeeded, so a failed fetch is
             * retried on the next run rather than being silently dropped.
             */
            scanState.scannedIds.push(target.id);
            scanState.scanned.add(target.id);
        } catch (messageError) {
            console.error(
                "Error processing message:",
                target.id,
                messageError
            );
        }

        scanStatus.processed++;
        flushMeter.sinceLastFlush++;

        sendProgress(false);
        await flushRunState(false);
    });

    return outcomes;
}

async function commitRunState(watermark) {
    pruneScannedIds();

    await chrome.storage.local.set({
        scannedMessageIds: scanState.scannedIds,
        pendingMessageIds: scanState.pending,
        pendingForwards: scanState.pendingForwards,
        lastScanTime: watermark,
        processedCount: scanState.previousProcessed + scanStatus.processed,
        filterCount: scanState.previousMatched + scanStatus.matched,
        scanProcessed: 0,
        scanMatched: 0,
        scanTotal: 0,
        lastRunIncomplete: false,
        lastRun: Date.now(),
        lastError: null
    });
}

/* --------------------------------------------------------------------------
 * Phase 2 - apply
 *
 * Messages are grouped by the exact change they need. A group of
 * CONFIG.BATCH_MODIFY_MIN or more becomes one batchModify covering up to
 * BATCH_MODIFY_MAX_IDS messages for 50 quota units. Smaller groups use plain
 * modify calls, because spending 50 units on two messages is a waste.
 * ------------------------------------------------------------------------ */

function groupBySignature(outcomes) {
    var groups = {};
    var keys = [];

    for (var i = 0; i < outcomes.length; i++) {
        var outcome = outcomes[i];

        if (outcome.add.length === 0 && outcome.remove.length === 0) {
            continue;
        }

        var key = signatureOf(outcome.add, outcome.remove);
        var group = groups[key];

        if (!group) {
            group = { add: outcome.add, remove: outcome.remove, ids: [] };
            groups[key] = group;
            keys.push(key);
        }

        group.ids.push(outcome.id);
    }

    return { groups: groups, keys: keys };
}

function mergeUnique(entry, field, values, seen) {
    for (var i = 0; i < values.length; i++) {
        if (!seen[values[i]]) {
            seen[values[i]] = true;
            entry[field].push(values[i]);
        }
    }
}

function collectThreadChanges(outcomes) {
    var changes = {};
    var threadIds = [];

    for (var i = 0; i < outcomes.length; i++) {
        var outcome = outcomes[i];

        if (!outcome.conversation || !outcome.threadId) {
            continue;
        }

        var entry = changes[outcome.threadId];

        if (!entry) {
            entry = { add: [], remove: [], seenAdd: {}, seenRemove: {} };
            changes[outcome.threadId] = entry;
            threadIds.push(outcome.threadId);
        }

        mergeUnique(entry, "add", outcome.conversation.add, entry.seenAdd);
        mergeUnique(
            entry,
            "remove",
            outcome.conversation.remove,
            entry.seenRemove
        );
    }

    return { changes: changes, threadIds: threadIds };
}

async function applyOutcomes(outcomes) {
    var grouped = groupBySignature(outcomes);
    var batchTasks = [];
    var singleTasks = [];
    var i, c;

    for (i = 0; i < grouped.keys.length; i++) {
        var group = grouped.groups[grouped.keys[i]];

        if (group.ids.length >= CONFIG.BATCH_MODIFY_MIN) {
            var chunks = chunkArray(group.ids, CONFIG.BATCH_MODIFY_MAX_IDS);

            for (c = 0; c < chunks.length; c++) {
                batchTasks.push({
                    ids: chunks[c],
                    add: group.add,
                    remove: group.remove
                });
            }

            continue;
        }

        for (c = 0; c < group.ids.length; c++) {
            singleTasks.push({
                id: group.ids[c],
                add: group.add,
                remove: group.remove
            });
        }
    }

    await runPool(batchTasks, 4, async function (task) {
        try {
            await batchModifyMessages(task.ids, task.add, task.remove);
        } catch (batchError) {
            console.error("batchModify failed:", batchError);
        }
    });

    await runPool(singleTasks, CONFIG.CONCURRENCY, async function (task) {
        try {
            await modifyMessage(task.id, task.add, task.remove);
        } catch (modifyError) {
            console.error("modify failed for", task.id, modifyError);
        }
    });

    var threads = collectThreadChanges(outcomes);

    await runPool(threads.threadIds, 10, async function (threadId) {
        var entry = threads.changes[threadId];

        if (entry.add.length === 0 && entry.remove.length === 0) {
            return;
        }

        try {
            await modifyThread(threadId, entry.add, entry.remove);
        } catch (threadError) {
            console.error("thread modify failed for", threadId, threadError);
        }
    });

    await drainForwards(outcomes);
}

/*
 * Forwarding has its own queue. users.messages.send costs 100 quota units,
 * which caps it at roughly two sends per second against the Gmail per-user
 * limit, so it can never run at scanning speed. Anything that does not go out
 * during this run is persisted and retried on the next one.
 */
async function drainForwards(outcomes) {
    var jobs = [];
    var seen = {};
    var i, j;

    for (i = 0; i < scanState.pendingForwards.length; i++) {
        var pending = scanState.pendingForwards[i];

        if (pending && pending.id && pending.to) {
            jobs.push({ id: pending.id, to: pending.to, raw: "", data: null });
        }
    }

    for (i = 0; i < outcomes.length; i++) {
        for (j = 0; j < outcomes[i].forwards.length; j++) {
            jobs.push({
                id: outcomes[i].id,
                to: outcomes[i].forwards[j],
                raw: outcomes[i].raw,
                data: outcomes[i].data
            });
        }
    }

    var unique = [];

    for (i = 0; i < jobs.length; i++) {
        var key = jobs[i].id + "|" + String(jobs[i].to).toLowerCase();

        if (seen[key]) {
            continue;
        }

        seen[key] = true;
        unique.push(jobs[i]);
    }

    scanStatus.forwarding = unique.length;
    sendProgress(true);

    if (unique.length === 0) {
        return;
    }

    var failed = [];

    await runPool(unique, CONFIG.FORWARD_CONCURRENCY, async function (job) {
        try {
            var raw = job.raw;
            var data = job.data;

            if (!raw) {
                var message = await getMessage(job.id, "raw");
                raw = message.raw || "";
                data = extractMessageData(message, "raw");
            }

            await forwardMessage(raw, data, job.to);
        } catch (forwardError) {
            console.error("forward failed for", job.id, forwardError);
            failed.push({ id: job.id, to: job.to });
        }
    });

    scanState.pendingForwards = failed;
    scanStatus.forwarding = failed.length;

    if (failed.length > 0) {
        await chrome.storage.local.set({ pendingForwards: failed });
    }
}

/* --------------------------------------------------------------------------
 * The run itself
 * ------------------------------------------------------------------------ */

async function runRules() {
    if (scanStatus.running) {
        return;
    }

    scanStatus.running = true;
    scanStatus.processed = 0;
    scanStatus.matched = 0;
    scanStatus.total = 0;
    scanStatus.startedAt = Date.now();
    scanStatus.rate = 0;
    scanStatus.phase = "listing";
    scanStatus.forwarding = 0;

    flushMeter.sinceLastFlush = 0;
    flushMeter.lastFlushAt = Date.now();

    safeSendMessage({ action: "cleanStarted" });


    try {
        var stored = await chrome.storage.local.get([
            "cleanerRules",
            "scannedMessageIds",
            "pendingMessageIds",
            "pendingForwards",
            "lastScanTime",
            "processedCount",
            "filterCount",
            "scanProcessed",
            "scanMatched",
            "scanTotal",
            "lastRunIncomplete"
        ]);

        var rules = (stored.cleanerRules || []).filter(function (rule) {
            return rule && rule.enabled !== false;
        });

        scanState.scannedIds = (stored.scannedMessageIds || []).slice();
        scanState.scanned = new Set(scanState.scannedIds);
        scanState.pending = (stored.pendingMessageIds || []).slice();
        scanState.pendingForwards = (stored.pendingForwards || []).slice();
        scanState.previousProcessed = stored.processedCount || 0;
        scanState.previousMatched = stored.filterCount || 0;

        /*
         * Carry an interrupted run forward. processedCount only ever holds
         * finished work, so the popup can add the two without double counting.
         */
        if (stored.lastRunIncomplete) {
            scanStatus.processed = stored.scanProcessed || 0;
            scanStatus.matched = stored.scanMatched || 0;
            scanStatus.total = stored.scanTotal || 0;
        }

        if (rules.length === 0) {
            /*
             * No enabled rules. The cursor is deliberately left alone so that
             * existing mail is still cleaned once a rule is created.
             */
            safeSendMessage({
                action: "cleanFinished",
                processed: 0,
                matched: 0,
                rate: 0
            });

            return;
        }

        auth.token = await acquireToken();
        await loadLabelMap(rules);

        var fetchFormat = resolveFetchFormat(rules);

        /*
         * Watermark is taken BEFORE listing, so mail that arrives while the
         * run is in flight is picked up by the next run instead of being
         * skipped forever.
         */
        var watermark = Date.now();
        var plan = await buildTargetList(stored.lastScanTime || 0);

        scanState.pending = plan.overflow;
        scanStatus.total = scanStatus.processed + plan.targets.length;
        scanStatus.phase = "scanning";

        sendProgress(true);

        var outcomes = await classifyMessages(
            plan.targets,
            rules,
            fetchFormat
        );

        scanStatus.phase = "applying";
        sendProgress(true);

        await applyOutcomes(outcomes);
        await commitRunState(watermark);

        /*
         * The countdown restarts when the scan FINISHES, not when it starts.
         * nextScanTime is a finish timestamp plus one interval, so a long scan
         * can never push the countdown to zero mid run.
         */
        chrome.storage.local.set({
            nextScanTime: Date.now() +
                (Number(config.autoCleanInterval || 1) * 60 * 1000)
        });

        scanStatus.rate = computeRate();
        scanStatus.phase = "idle";

        safeSendMessage({
            action: "cleanFinished",
            processed: scanStatus.processed,
            matched: scanStatus.matched,
            rate: scanStatus.rate
        });
    } catch (error) {
        console.error("MailMaid scan error:", error);

        try {
            await chrome.storage.local.set({
                lastError: error.message || String(error),
                lastRunIncomplete: true
            });
        } catch (storageError) {
            /* Nothing more we can do about it here. */
        }

        safeSendMessage({
            action: "cleanError",
            error: error.message || String(error)
        });
    } finally {
        scanStatus.running = false;
        scanStatus.phase = "idle";
    }
}

/* --------------------------------------------------------------------------
 * Scheduling and messaging
 * ------------------------------------------------------------------------ */

function createAlarm(minutes) {
    var interval = Number(minutes);

    if (!interval || interval < 1) {
        interval = 1;
    }

    chrome.alarms.clear(
        "mailMaid",
        function () {
            chrome.alarms.create(
                "mailMaid",
                {
                    delayInMinutes: interval,
                    periodInMinutes: interval
                }
            );

            chrome.storage.local.set({
                autoCleanInterval: interval
            });
        }
    );
}

function restoreAlarm() {
    /*
     * The alarm was renamed from "gmailCleaner" to "mailMaid". Clear the old
     * name so a leftover alarm from an earlier build cannot keep firing.
     */
    chrome.alarms.clear("gmailCleaner");

    chrome.storage.local.get(
        ["autoClean", "autoCleanInterval"],
        function (data) {
            if (data.autoClean && data.autoCleanInterval) {
                createAlarm(data.autoCleanInterval);

                /*
                 * Re-arm the countdown as well. After a browser restart the
                 * alarm only fires again a full interval from now, so without
                 * this the popup would have nothing to count down to.
                 */
                chrome.storage.local.set({
                    nextScanTime: Date.now() +
                        (Number(data.autoCleanInterval) * 60 * 1000)
                });
            }
        }
    );
}

chrome.runtime.onInstalled.addListener(restoreAlarm);
chrome.runtime.onStartup.addListener(restoreAlarm);

chrome.alarms.onAlarm.addListener(
    function (alarm) {
        if (alarm.name !== "mailMaid") {
            return;
        }

        runRules().catch(function (error) {
            /* runRules reports its own failures; this is the last resort. */
            console.error("MailMaid scheduled scan failed:", error);

            scanStatus.running = false;
            scanStatus.phase = "idle";
        });
    }
);

chrome.runtime.onMessage.addListener(
    function (message, sender, sendResponse) {
        if (!message || !message.action) {
            return;
        }

        if (message.action === "cleanNow") {
            /*
             * runRules() sets scanStatus.running synchronously before its first
             * await, so this check cannot race with a run that is starting.
             */
            if (scanStatus.running) {
                sendResponse({
                    ok: false,
                    running: true,
                    reason: "busy"
                });

                return true;
            }

            runRules().catch(function (error) {
                /* runRules handles its own failures; this is the last resort. */
                console.error("MailMaid scan failed to start:", error);

                scanStatus.running = false;
                scanStatus.phase = "idle";

                safeSendMessage({
                    action: "cleanError",
                    error: error.message || String(error)
                });
            });

            sendResponse({ ok: true, running: true });

            return true;
        }

        if (message.action === "start") {
            createAlarm(message.interval || 1);

            chrome.storage.local.set({
                autoClean: true,
                autoCleanInterval: Number(message.interval || 1),
                nextScanTime: Date.now() +
                    (Number(message.interval || 1) * 60 * 1000)
            });

            sendResponse({ ok: true });

            return true;
        }

        if (message.action === "stop") {
            chrome.alarms.clear(
                "mailMaid",
                function () {
                    /* Drop the pre-rename alarm too, if one is still around. */
                    chrome.alarms.clear("gmailCleaner");

                    chrome.storage.local.set({
                        autoClean: false,
                        nextScanTime: null
                    });

                    sendResponse({ ok: true });
                }
            );

            return true;
        }

        if (message.action === "getStatus") {
            chrome.storage.local.get(
                [
                    "autoClean",
                    "autoCleanInterval",
                    "nextScanTime",
                    "lastRun",
                    "lastScanTime",
                    "processedCount",
                    "filterCount",
                    "scanProcessed",
                    "scanMatched",
                    "scanTotal",
                    "lastRunIncomplete",
                    "lastError"
                ],
                function (data) {
                    sendResponse({
                        ok: true,
                        running: scanStatus.running,
                        processed: scanStatus.processed,
                        matched: scanStatus.matched,
                        total: scanStatus.total,
                        rate: scanStatus.rate,
                        goal: scanStatus.goalRate,
                        phase: scanStatus.phase,
                        forwarding: scanStatus.forwarding,
                        autoClean: data.autoClean || false,
                        autoCleanInterval:
                            data.autoCleanInterval || 1,
                        nextScanTime:
                            data.nextScanTime || null,
                        lastRun:
                            data.lastRun || null,
                        lastScanTime:
                            data.lastScanTime || null,
                        processedCount:
                            data.processedCount || 0,
                        filterCount:
                            data.filterCount || 0,
                        scanProcessed:
                            data.scanProcessed || 0,
                        scanMatched:
                            data.scanMatched || 0,
                        scanTotal:
                            data.scanTotal || 0,
                        lastRunIncomplete:
                            data.lastRunIncomplete === true,
                        lastError:
                            data.lastError || null
                    });
                }
            );

            return true;
        }
    }
);

console.log(
    "MailMaid background loaded - " +
    CONFIG.CONCURRENCY + " in flight, " +
    CONFIG.BATCH_TARGET + " per " +
    (CONFIG.BATCH_WINDOW_MS / 1000) + "s target"
);
