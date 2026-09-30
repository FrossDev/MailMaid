var savedChecked = 0;
var savedMatched = 0;

var currentScanProcessed = 0;
var currentScanMatched = 0;
var currentScanTotal = 0;

var isRunning = false;

/*
 * Clean Now disables the button as soon as it is clicked, before the
 * background confirms the start. This timestamp keeps the periodic status
 * poll from re-enabling the button during that short window.
 */
var cleanGuardUntil = 0;

/*
 * Same idea for the Auto Clean switch: the periodic poll must not fight the
 * user's toggle while the start/stop request is still in flight.
 */
var toggleGuardUntil = 0;

/* Last running state this popup saw, used to notice a run ending silently. */
var wasRunning = false;

/* True until the first status response has been applied. */
var firstSync = true;

function $(id) {
    return document.getElementById(id);
}

function updateDisplayedCounters() {
    if (isRunning) {
        $("checked").textContent =
            savedChecked + currentScanProcessed;

        $("matched").textContent =
            savedMatched + currentScanMatched;
    } else {
        $("checked").textContent = savedChecked;
        $("matched").textContent = savedMatched;
    }
}

function formatTime(timestamp) {
    if (!timestamp) {
        return "Never";
    }

    return new Date(timestamp).toLocaleTimeString();
}

/*
 * Throughput readout. "goal" is the configured target (25 messages per
 * 2 seconds = 12.5 msg/s); hitting it turns the line green.
 */
function updateRateDisplay(rate, goal, forwarding) {
    var element = $("rate");

    if (!element) {
        return;
    }

    var speed = Number(rate) || 0;
    var target = Number(goal) || 0;
    var queued = Number(forwarding) || 0;
    var text;

    if (speed <= 0) {
        text = "Rate: —";
    } else {
        text = "Rate: " + speed.toFixed(1) + " msg/s";

        if (target > 0) {
            text += " (goal " + target + ")";
        }
    }

    if (queued > 0) {
        /* Forwarding is capped by Gmail quota, so surface the backlog. */
        text += " · " + queued + " to forward";
    }

    element.textContent = text;

    element.className = (target > 0 && speed >= target)
        ? "rate-line on-goal"
        : "rate-line";
}

/*
 * Keeps Clean Now in step with the real scan state reported by the status
 * poll. A run started elsewhere (alarm or another window) disables the button,
 * and a worker that died mid scan re-enables it instead of leaving the panel
 * stuck on "Scanning".
 */
function syncCleanButton() {
    if (isRunning) {
        cleanGuardUntil = 0;
        $("clean").disabled = true;

        return;
    }

    if (Date.now() >= cleanGuardUntil) {
        $("clean").disabled = false;
    }
}

function updateStatus() {
    chrome.runtime.sendMessage(
        { action: "getStatus" },
        function(response) {
            if (chrome.runtime.lastError) {
                return;
            }

            if (!response) {
                return;
            }

            isRunning =
                response.running === true;

            savedChecked =
                Number(response.processedCount || 0);

            savedMatched =
                Number(response.filterCount || 0);

            /*
             * An interrupted run is not folded into processedCount yet, so its
             * live counters are added here. A run that is still going reports
             * through processed/matched below instead, so the two are never
             * counted twice.
             */
            if (!isRunning && response.lastRunIncomplete) {
                savedChecked +=
                    Number(response.scanProcessed || 0);

                savedMatched +=
                    Number(response.scanMatched || 0);
            }

            if (!isRunning && response.lastRunIncomplete &&
                    (wasRunning || firstSync) &&
                    Date.now() >= cleanGuardUntil) {
                /*
                 * The run ended without a cleanFinished broadcast, which is
                 * what happens when the service worker is torn down mid scan.
                 * Recover a truthful state instead of leaving the last
                 * "Scanning N of M" line on screen, and say so once when the
                 * popup is opened after such a run.
                 */
                $("progressText").textContent =
                    "Last scan was interrupted";
            } else if (wasRunning && !isRunning) {
                $("progress").style.width = "100%";

                $("progressText").textContent =
                    "Scan complete";
            }

            firstSync = false;
            wasRunning = isRunning;

            if (isRunning) {
                currentScanProcessed =
                    Number(response.processed || 0);

                currentScanMatched =
                    Number(response.matched || 0);

                currentScanTotal =
                    Number(response.total || 0);
            }

            updateDisplayedCounters();

            if (response.autoClean) {
                if (Date.now() >= toggleGuardUntil) {
                    $("autoClean").checked = true;
                }

                $("statusTitle").textContent =
                    "Auto Clean ON";

                $("statusDot").className =
                    "dot on";

                if (response.nextScanTime) {
                    updateCountdown(
                        response.nextScanTime
                    );
                } else {
                    /*
                     * Enabled but no alarm scheduled yet: do not keep showing
                     * a countdown from a scan that has already been replaced.
                     */
                    $("countdown").textContent = "—";

                    $("countdownLabel").textContent =
                        "Waiting to schedule...";
                }
            } else {
                if (Date.now() >= toggleGuardUntil) {
                    $("autoClean").checked = false;
                }

                $("statusTitle").textContent =
                    "Auto Clean OFF";

                $("statusDot").className =
                    "dot";

                $("countdown").textContent = "—";

                $("countdownLabel").textContent =
                    "Auto Clean is off";
            }

            if (isRunning) {
                $("statusDot").className =
                    "dot scanning";

                $("progressText").textContent =
                    "Scanning " +
                    currentScanProcessed +
                    " of " +
                    currentScanTotal;

                if (currentScanTotal > 0) {
                    var percent =
                        (
                            currentScanProcessed /
                            currentScanTotal
                        ) * 100;

                    $("progress").style.width =
                        percent + "%";
                } else {
                    $("progress").style.width =
                        "0%";
                }
            }

            $("lastScan").textContent =
                "Last scan: " +
                formatTime(
                    response.lastScanTime
                ) +
                (
                    !isRunning && response.lastRunIncomplete
                        ? " (incomplete)"
                        : ""
                );

            updateRateDisplay(
                response.rate,
                response.goal,
                response.forwarding
            );

            syncCleanButton();
        }
    );
}

function updateCountdown(nextScanTime) {
    var remaining =
        nextScanTime - Date.now();

    if (remaining <= 0) {
        $("countdown").textContent = "NOW";

        $("countdownLabel").textContent =
            "Starting scan...";

        return;
    }

    var seconds =
        Math.ceil(remaining / 1000);

    var minutes =
        Math.floor(seconds / 60);

    var secs =
        seconds % 60;

    $("countdown").textContent =
        minutes +
        ":" +
        (secs < 10 ? "0" : "") +
        secs;

    $("countdownLabel").textContent =
        "Next scan";
}

$("autoClean").addEventListener(
    "change",
    function() {
        var enabled =
            $("autoClean").checked;

        /* Hold this switch steady until the background answers. */
        toggleGuardUntil = Date.now() + 2000;

        var interval =
            Number($("interval").value);

        if (!interval || interval < 1) {
            interval = 1;
            $("interval").value = 1;
        }

        if (enabled) {
            chrome.runtime.sendMessage(
                {
                    action: "start",
                    interval: interval
                },
                function() {
                    void chrome.runtime.lastError;
                    updateStatus();
                }
            );
        } else {
            chrome.runtime.sendMessage(
                {
                    action: "stop"
                },
                function() {
                    void chrome.runtime.lastError;
                    updateStatus();
                }
            );
        }
    }
);

$("interval").addEventListener(
    "change",
    function() {
        var interval =
            Number($("interval").value);

        if (!interval || interval < 1) {
            interval = 1;
            $("interval").value = 1;
        }

        if ($("autoClean").checked) {
            toggleGuardUntil = Date.now() + 2000;

            chrome.runtime.sendMessage(
                {
                    action: "start",
                    interval: interval
                },
                function() {
                    void chrome.runtime.lastError;
                    updateStatus();
                }
            );
        }
    }
);

$("clean").addEventListener(
    "click",
    function() {
        $("clean").disabled = true;

        /* Keep the button disabled while the start request is in flight. */
        cleanGuardUntil = Date.now() + 5000;

        /*
         * IMPORTANT:
         * Do NOT reset savedChecked or savedMatched here.
         * The current scan is added on top of the old totals.
         */

        currentScanProcessed = 0;
        currentScanMatched = 0;
        currentScanTotal = 0;

        isRunning = true;

        updateDisplayedCounters();

        $("progress").style.width = "0%";

        $("progressText").textContent =
            "Starting scan...";

        chrome.runtime.sendMessage(
            {
                action: "cleanNow"
            },
            function(response) {
                if (chrome.runtime.lastError) {
                    cleanGuardUntil = 0;
                    isRunning = false;

                    $("clean").disabled = false;

                    $("progressText").textContent =
                        "Error: " +
                        chrome.runtime.lastError.message;

                    return;
                }

                /*
                 * The background refuses to start a second scan. Fall back to
                 * whatever it reports instead of leaving the button disabled
                 * and the panel stuck on "Starting scan...".
                 */
                if (!response || response.ok !== true) {
                    cleanGuardUntil = 0;
                    isRunning = false;

                    $("clean").disabled = false;

                    $("progressText").textContent =
                        "A scan is already running";

                    updateStatus();

                    return;
                }

                updateStatus();
            }
        );
    }
);

$("settings").addEventListener(
    "click",
    function() {
        chrome.runtime.openOptionsPage();
    }
);

chrome.runtime.onMessage.addListener(
    function(message) {
        if (!message || !message.action) {
            return;
        }

        if (message.action === "cleanStarted") {
            isRunning = true;

            currentScanProcessed = 0;
            currentScanMatched = 0;
            currentScanTotal = 0;

            $("progress").style.width = "0%";

            $("progressText").textContent =
                "Starting scan...";

            $("clean").disabled = true;

            updateRateDisplay(0, 0, 0);
            updateDisplayedCounters();
        }

        if (message.action === "progress") {
            isRunning = true;

            currentScanProcessed =
                Number(message.processed || 0);

            currentScanMatched =
                Number(message.matched || 0);

            currentScanTotal =
                Number(message.total || 0);

            updateDisplayedCounters();

            $("progressText").textContent =
                "Scanning " +
                currentScanProcessed +
                " of " +
                currentScanTotal;

            if (currentScanTotal > 0) {
                var percent =
                    (
                        currentScanProcessed /
                        currentScanTotal
                    ) * 100;

                $("progress").style.width =
                    percent + "%";
            }

            updateRateDisplay(
                message.rate,
                message.goal,
                message.forwarding
            );
        }

        if (message.action === "cleanFinished") {
            isRunning = false;
            wasRunning = false;
            cleanGuardUntil = 0;

            $("progress").style.width = "100%";

            $("progressText").textContent =
                "Scan complete";

            $("clean").disabled = false;

            /*
             * Get the actual cumulative totals
             * from storage through the background.
             */
            setTimeout(
                function() {
                    updateStatus();
                },
                300
            );
        }

        if (message.action === "cleanError") {
            isRunning = false;
            wasRunning = false;
            cleanGuardUntil = 0;

            $("clean").disabled = false;

            $("progressText").textContent =
                "Error: " +
                (message.error || "Unknown error");

            updateStatus();
        }
    }
);

/*
 * Full status poll. Every field the panel shows is refreshed from here, so the
 * popup stays in sync with runs started by the alarm or from another window,
 * and a button left disabled by a worker that died mid scan recovers.
 */
setInterval(
    function() {
        updateStatus();
    },
    1000
);

updateStatus();