const rulesContainer = document.getElementById("rules");
const addRuleButton = document.getElementById("addRule");

let rules = [];

async function loadRules() {
    const data = await chrome.storage.local.get("cleanerRules");
    rules = data.cleanerRules || [];

    renderRules();
}

async function saveRules() {
    await chrome.storage.local.set({
        cleanerRules: rules
    });
}

function createEmptyRule() {
    return {
        enabled: true,

        fromContains: "",
        fromNotContains: "",

        toContains: "",
        toNotContains: "",

        subjectContains: "",
        subjectNotContains: "",

        messageContains: "",
        messageNotContains: "",

        actions: {
            archive: false,
            markRead: false,
            star: false,
            label: "",
            forward: "",
            delete: false,
            neverSpam: false,
            important: false,
            notImportant: false,
            category: "",
            applyToConversations: false
        }
    };
}


function renderRules() {

    rulesContainer.innerHTML = "";

    if (rules.length === 0) {
        rulesContainer.innerHTML = `
            <div class="rule">
                <div class="rule-title">No rules yet</div>
                <p class="subtitle">
                    Click "+ Add Rule" to create your first rule.
                </p>
            </div>
        `;
        return;
    }

    rules.forEach((rule, index) => {

        const element = document.createElement("div");
        element.className = "rule";

        element.innerHTML = `

            <div class="rule-header">

                <div class="rule-title">
    		   Rule ${index + 1}
		</div>

		<label class="enabled-rule">
    		  <input
        	      type="checkbox"
                      data-enabled
                      ${rule.enabled !== false ? "checked" : ""}
    		  >
   		  Enabled
</label>

                <button
                    class="delete-rule"
                    data-index="${index}">
                    Delete
                </button>

            </div>


            <div class="section-title">
                Conditions
            </div>
            
            <input
                type="text"
    		class="comma-note"
    		value="Comma separated"
    		readonly
	    >

            <div class="condition">
                <div class="condition-label">From</div>

                <input
                    type="text"
                    data-field="fromContains"
                    value="${escapeHtml(rule.fromContains)}"
                    placeholder="Contains"
                >

                <input
                    type="text"
                    data-field="fromNotContains"
                    value="${escapeHtml(rule.fromNotContains)}"
                    placeholder="Doesn't contain"
                >
            </div>


            <div class="condition">
                <div class="condition-label">To</div>

                <input
                    type="text"
                    data-field="toContains"
                    value="${escapeHtml(rule.toContains)}"
                    placeholder="Contains"
                >

                <input
                    type="text"
                    data-field="toNotContains"
                    value="${escapeHtml(rule.toNotContains)}"
                    placeholder="Doesn't contain"
                >
            </div>


            <div class="condition">
                <div class="condition-label">Subject</div>

                <input
                    type="text"
                    data-field="subjectContains"
                    value="${escapeHtml(rule.subjectContains)}"
                    placeholder="Contains"
                >

                <input
                    type="text"
                    data-field="subjectNotContains"
                    value="${escapeHtml(rule.subjectNotContains)}"
                    placeholder="Doesn't contain"
                >
            </div>


            <div class="condition">
                <div class="condition-label">Message</div>

                <input
                    type="text"
                    data-field="messageContains"
                    value="${escapeHtml(rule.messageContains)}"
                    placeholder="Contains"
                >

                <input
                    type="text"
                    data-field="messageNotContains"
                    value="${escapeHtml(rule.messageNotContains)}"
                    placeholder="Doesn't contain"
                >
            </div>


            <div class="section-title">
                Actions
            </div>


            <div class="actions">

                <div class="action">
                    <label>
                        <input
                            type="checkbox"
                            data-action="archive"
                            ${rule.actions.archive ? "checked" : ""}
                        >
                        Skip the Inbox (Archive it)
                    </label>
                </div>


                <div class="action">
                    <label>
                        <input
                            type="checkbox"
                            data-action="markRead"
                            ${rule.actions.markRead ? "checked" : ""}
                        >
                        Mark as read
                    </label>
                </div>


                <div class="action">
                    <label>
                        <input
                            type="checkbox"
                            data-action="star"
                            ${rule.actions.star ? "checked" : ""}
                        >
                        Star it
                    </label>
                </div>


                <div class="action">

                    <label>
                        <input
                            type="checkbox"
                            data-action="useLabel"
                            ${rule.actions.label ? "checked" : ""}
                        >
                        Apply the label
                    </label>

                    <input
                        class="action-extra"
                        type="text"
                        data-action-value="label"
                        value="${escapeHtml(rule.actions.label)}"
                        placeholder="Label name"
                    >

                </div>


                <div class="action">

                    <label>
                        <input
                            type="checkbox"
                            data-action="useForward"
                            ${rule.actions.forward ? "checked" : ""}
                        >
                        Forward it
                    </label>

                    <input
                        class="action-extra"
                        type="email"
                        data-action-value="forward"
                        value="${escapeHtml(rule.actions.forward)}"
                        placeholder="Email address"
                    >

                </div>


                <div class="action">
                    <label>
                        <input
                            type="checkbox"
                            data-action="delete"
                            ${rule.actions.delete ? "checked" : ""}
                        >
                        Delete it
                    </label>
                </div>


                <div class="action">
                    <label>
                        <input
                            type="checkbox"
                            data-action="neverSpam"
                            ${rule.actions.neverSpam ? "checked" : ""}
                        >
                        Never send it to Spam
                    </label>
                </div>


                <div class="action">
                    <label>
                        <input
                            type="checkbox"
                            data-action="important"
                            ${rule.actions.important ? "checked" : ""}
                        >
                        Always mark it as important
                    </label>
                </div>


                <div class="action">
                    <label>
                        <input
                            type="checkbox"
                            data-action="notImportant"
                            ${rule.actions.notImportant ? "checked" : ""}
                        >
                        Never mark it as important
                    </label>
                </div>


                <div class="action">

                    <label>
                        <input
                            type="checkbox"
                            data-action="useCategory"
                            ${rule.actions.category ? "checked" : ""}
                        >
                        Categorize as
                    </label>

                    <select
                        class="action-extra"
                        data-action-value="category"
                    >

                        <option value="">
                            Select category
                        </option>

                        <option
                            value="primary"
                            ${rule.actions.category === "primary" ? "selected" : ""}
                        >
                            Primary
                        </option>

                        <option
                            value="social"
                            ${rule.actions.category === "social" ? "selected" : ""}
                        >
                            Social
                        </option>

                        <option
                            value="promotions"
                            ${rule.actions.category === "promotions" ? "selected" : ""}
                        >
                            Promotions
                        </option>

                        <option
                            value="updates"
                            ${rule.actions.category === "updates" ? "selected" : ""}
                        >
                            Updates
                        </option>

                        <option
                            value="forums"
                            ${rule.actions.category === "forums" ? "selected" : ""}
                        >
                            Forums
                        </option>

                    </select>

                </div>


                <div class="action">

                    <label>
                        <input
                            type="checkbox"
                            data-action="applyToConversations"
                            ${rule.actions.applyToConversations ? "checked" : ""}
                        >
                        Also apply to matching conversations
                    </label>

                </div>

            </div>


            <button
                class="save-rule"
                data-save="${index}">
                Save Rule
            </button>

        `;

        rulesContainer.appendChild(element);

        setupRule(element, index);
    });
}


function setupRule(element, index) {

    const rule = rules[index];

    // Show/hide extra fields
    element.querySelectorAll(
        'input[type="checkbox"][data-action]'
    ).forEach(checkbox => {

        const extra = checkbox
            .closest(".action")
            ?.querySelector(".action-extra");

        if (!extra) return;

        extra.classList.toggle(
            "show",
            checkbox.checked
        );

        checkbox.addEventListener("change", () => {

            extra.classList.toggle(
                "show",
                checkbox.checked
            );

        });
    });


// Enabled checkbox
const enabledCheckbox =
    element.querySelector("[data-enabled]");

enabledCheckbox.addEventListener("change", async () => {
    rule.enabled = enabledCheckbox.checked;
    await saveRules();
});

// Save rule
element
    .querySelector(".save-rule")
    .addEventListener("click", async () => {

        element
            .querySelectorAll("[data-field]")
            .forEach(input => {
                rule[input.dataset.field] =
                    input.value.trim();
            });

        element
            .querySelectorAll(
                'input[type="checkbox"][data-action]'
            )
            .forEach(checkbox => {

                const action =
                    checkbox.dataset.action;

                if (
                    action !== "useLabel" &&
                    action !== "useForward" &&
                    action !== "useCategory"
                ) {
                    rule.actions[action] =
                        checkbox.checked;
                }
            });

        const labelInput =
            element.querySelector(
                '[data-action-value="label"]'
            );

        const forwardInput =
            element.querySelector(
                '[data-action-value="forward"]'
            );

        const categoryInput =
            element.querySelector(
                '[data-action-value="category"]'
            );

        rule.actions.label =
            element.querySelector(
                '[data-action="useLabel"]'
            ).checked
                ? labelInput.value.trim()
                : "";

        rule.actions.forward =
            element.querySelector(
                '[data-action="useForward"]'
            ).checked
                ? forwardInput.value.trim()
                : "";

        rule.actions.category =
            element.querySelector(
                '[data-action="useCategory"]'
            ).checked
                ? categoryInput.value
                : "";

        await saveRules();

        const button =
            element.querySelector(".save-rule");

        button.textContent = "Saved ✓";

        setTimeout(() => {
            button.textContent = "Save Rule";
        }, 1200);
    });


    // Delete rule
    element
        .querySelector(".delete-rule")
        .addEventListener("click", async () => {

            rules.splice(index, 1);

            await saveRules();

            renderRules();
        });
}


addRuleButton.addEventListener("click", async () => {

    rules.push(createEmptyRule());

    await saveRules();

    renderRules();

    window.scrollTo({
        top: document.body.scrollHeight,
        behavior: "smooth"
    });
});


function escapeHtml(value) {

    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


loadRules();