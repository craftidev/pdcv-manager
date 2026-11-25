const $ = (id) => document.getElementById(id);
const esc = (value) =>
    String(value ?? "").replace(
        /[&<>"']/g,
        (char) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[char],
    );
const categoryNames = {
    service: "Service",
    relais: "Relais",
    ignore: "Sans ID",
    held: "En attente d’un ID régional",
};
const reasonNames = {
    tribune: "Tribune",
    keyword: "Mot-clé local",
    mailto: "Lien email",
    tel: "Lien téléphone",
    internal: "Lien interne",
    region_hold: "Région sans ID",
};
let contexts = [],
    sources = {},
    rows = {},
    csrf = "",
    name = "",
    view = "manual",
    current = null,
    key = null;
let acting = false,
    selecting = false,
    stale = false,
    lastAction = null,
    noticeTimer,
    pollTimer,
    heartbeatTimer;
let treeBrowser = null,
    datasetVersion = "",
    returnToBrowse = false,
    currentOccurrenceId = null;
const filters = {
    search: "",
    audience: "",
    region: "",
    page: "",
    category: "",
    deferred: "hide",
};
const finished = (row) => row.category !== null && row.verified;
const regionKey = (context) => context.region.code || context.region.label;
const normalized = (value) =>
    value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("fr");
const safeHref = (value) => {
    try {
        return ["http:", "https:", "mailto:", "tel:"].includes(
            new URL(value, location.href).protocol,
        )
            ? value
            : "#";
    } catch {
        return "#";
    }
};
function updateBusyControls() {
    const busy = acting || selecting;
    document
        .querySelectorAll("[data-view],.client-context-links button")
        .forEach((button) => (button.disabled = busy));
    for (const field of [...Object.keys(filters), "show-verified", "logout"])
        $(field).disabled = busy;
    $("undo").disabled = !lastAction || busy;
}
function notify(message) {
    $("notice").textContent = message;
    $("notice").style.display = "block";
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => ($("notice").style.display = "none"), 6500);
}
async function api(path, body) {
    const response = await fetch(
        path,
        body === undefined
            ? {}
            : {
                  method: "POST",
                  headers: {
                      "Content-Type": "application/json",
                      "X-CSRF-Token": csrf,
                  },
                  body: JSON.stringify(body),
              },
    );
    const result = await response.json();
    if (!response.ok) {
        if (result.decisions) rows = result.decisions;
        const error = new Error(result.error || "Action indisponible.");
        error.status = response.status;
        throw error;
    }
    return result;
}
function visibleRow(row) {
    if (!row) return false;
    if (view === "manual" && row.category !== null) return false;
    if (
        view === "auto" &&
        (row.origin !== "auto" || (row.verified && !$("show-verified").checked))
    )
        return false;
    if (view === "done" && row.origin !== "manual") return false;
    if (filters.category === "pending" && row.category !== null) return false;
    if (
        filters.category &&
        filters.category !== "pending" &&
        row.category !== filters.category
    )
        return false;
    if (filters.deferred === "hide" && row.skipped) return false;
    if (filters.deferred === "only" && !row.skipped) return false;
    return true;
}
function visibleContext(context) {
    if (filters.audience && context.audience !== filters.audience) return false;
    if (filters.region && regionKey(context) !== filters.region) return false;
    if (filters.page && context.page_url !== filters.page) return false;
    const text = [
        context.title,
        context.page_title,
        context.description_html.replace(/<[^>]*>/g, " "),
        ...context.links.map((link) => link.label + " " + link.destination),
    ].join(" ");
    return (
        !filters.search || normalized(text).includes(normalized(filters.search))
    );
}
const contextKeys = (context) => [
    ...new Set(context.links.map((link) => link.key)),
];
const eligibleKeys = (context) =>
    contextKeys(context).filter((value) => visibleRow(rows[value]));
const activeOccurrence = () =>
    current?.links.find(
        (link) => link.id === currentOccurrenceId && link.key === key,
    ) || current?.links.find((link) => link.key === key);
function renderBrowse() {
    if (!treeBrowser)
        treeBrowser = new PdcvTreeBrowser($("browse-panel"), openFromTree);
    const items = [];
    for (const context of contexts)
        if (visibleContext(context))
            for (const link of context.links)
                if (visibleRow(rows[link.key])) items.push({ context, link });
    treeBrowser.update(items, rows, datasetVersion);
}
async function openFromTree(contextId, target, occurrenceId) {
    if (acting || selecting) return;
    const context = contexts.find((value) => value.id === contextId);
    if (!context) return;
    returnToBrowse = true;
    view = "all";
    current = null;
    key = null;
    refreshNavigation();
    await selectTarget(context, target, occurrenceId);
}
function refreshNavigation() {
    updateBusyControls();
    const browsing = view === "browse";
    document.querySelector("main").classList.toggle("browse-mode", browsing);
    $("context-panel").hidden = browsing;
    $("decision-panel").hidden = browsing;
    $("browse-panel").hidden = !browsing;
    $("context-list").hidden = browsing;
    const all = Object.values(rows),
        completed = all.filter(finished).length;
    $("global-progress").textContent =
        `${completed} / ${all.length} liens uniques traités`;
    const counts = {
        manual: all.filter((row) => row.category === null).length,
        auto: all.filter((row) => row.origin === "auto" && !row.verified)
            .length,
        done: all.filter((row) => row.origin === "manual").length,
        all: all.length,
        browse: all.length,
    };
    document.querySelectorAll("[data-view]").forEach((button) => {
        button.classList.toggle("active", button.dataset.view === view);
        button.querySelector("span").textContent = counts[button.dataset.view];
    });
    $("verified-filter").hidden = view !== "auto";
    $("export").textContent =
        completed === all.length
            ? "Exporter le résultat"
            : "Exporter (provisoire)";
    if (browsing) {
        $("list-count").textContent = "Navigation seule · aucun lien réservé";
        renderBrowse();
        return;
    }
    const visible = contexts.filter(
        (context) => visibleContext(context) && eligibleKeys(context).length,
    );
    $("list-count").textContent =
        `${visible.length} contextes dans cette sélection`;
    const scroll = $("context-list").scrollTop;
    $("context-list").innerHTML = visible
        .map((context) => {
            const available = eligibleKeys(context).filter(
                (value) => !rows[value].busy,
            ).length;
            return `<button class="context-choice ${current?.id === context.id ? "active" : ""}" data-context="${context.id}"><strong>${esc(context.region.label)} · ${esc(context.title)}</strong><small>${esc(context.page_title)}</small><small>${available} disponible(s) · ${eligibleKeys(context).length} lien(s) dans cette vue</small></button>`;
        })
        .join("");
    $("context-list").scrollTop = scroll;
    document.querySelectorAll("[data-context]").forEach((button) =>
        button.addEventListener("click", () => {
            const context = contexts.find(
                (value) => value.id === button.dataset.context,
            );
            const target =
                eligibleKeys(context).find((value) => !rows[value].busy) ||
                eligibleKeys(context)[0];
            selectTarget(context, target);
            if (matchMedia("(max-width:650px)").matches) {
                $("sidebar").classList.remove("open");
                $("toggle-filters").setAttribute("aria-expanded", "false");
            }
        }),
    );
    $("undo").disabled = !lastAction || acting;
}
function highlightHints(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const pattern =
        /(?<![\p{L}\p{N}_])(?:(relais?)|(dispositifs?|programmes?|ressources?|contacts?))(?![\p{L}\p{N}_])/giu;
    for (const node of nodes) {
        if (node.parentElement.closest("mark,script,style")) continue;
        const matches = [...node.textContent.matchAll(pattern)];
        if (!matches.length) continue;
        const fragment = document.createDocumentFragment();
        let position = 0;
        for (const hit of matches) {
            fragment.append(node.textContent.slice(position, hit.index));
            const mark = document.createElement("mark");
            mark.className = hit[1] ? "hint-relais" : "hint-service";
            mark.textContent = hit[0];
            fragment.append(mark);
            position = hit.index + hit[0].length;
        }
        fragment.append(node.textContent.slice(position));
        node.replaceWith(fragment);
    }
}
function renderContext() {
    $("context-panel").innerHTML =
        `<div class="context-header"><span class="eyebrow">${current.audience === "entreprises" ? "ENTREPRISES" : "COLLECTIVITÉS"} · ${esc(current.region.label)}</span><p>${esc(current.page_title)}</p><a href="${esc(current.page_url)}" target="_blank" rel="noopener noreferrer">Voir la page publique</a><p id="context-position" class="context-position"></p></div><div class="context-shell"><div id="context-body" class="context-body"></div></div>`;
    if (returnToBrowse) {
        const back = document.createElement("button");
        back.id = "back-to-tree";
        back.className = "quiet";
        back.textContent = "Retour à l’arborescence";
        back.onclick = () => changeView("browse");
        $("context-panel").querySelector(".context-header").prepend(back);
    }
    const first = activeOccurrence();
    const card = PdcvContextView.render(current, first?.id, (sourceId) => {
        const target = current.links.find((link) => link.id === sourceId);
        selectTarget(current, target.key, sourceId);
    });
    $("context-body").append(card);
    highlightHints(card.querySelector(".client-description"));
    highlightHints(card.querySelector("h4"));
}
function updateContext(same = false) {
    if (!current || !key) return;
    const keys = contextKeys(current),
        position = keys.indexOf(key) + 1;
    $("context-position").textContent =
        `${same ? "Même contexte · " : ""}Lien ${position} sur ${keys.length}`;
    const activeURL = sources[key].url;
    const anchors = [
        ...$("context-body").querySelectorAll(".client-description a[href]"),
    ];
    const exact = anchors.some(
        (anchor) => anchor.getAttribute("href") === activeURL,
    );
    anchors.forEach((anchor) => {
        const active = exact
            ? anchor.getAttribute("href") === activeURL
            : new URL(anchor.href, location.href).href ===
              new URL(activeURL, location.href).href;
        anchor.classList.toggle("current-link", active);
        anchor.classList.toggle("other-link", !active);
    });
    $("context-body")
        .querySelectorAll(".client-context-links button")
        .forEach((button, index) => {
            const link = current.links[index],
                row = rows[link.key],
                active = link.key === key;
            button.classList.toggle("client-target", active);
            button.classList.toggle("client-sibling", !active);
            button.classList.toggle("busy-link", row.busy);
            let status = button.querySelector("small");
            if (!status) {
                status = document.createElement("small");
                button.append(status);
            }
            status.textContent = row.busy
                ? `En cours · ${row.lease_name}`
                : row.category === null
                  ? row.skipped
                      ? "À reprendre"
                      : "À classer"
                  : `${categoryNames[row.category]} · ${row.origin === "auto" ? (row.verified ? "automatique vérifié" : "automatique à vérifier") : "décision manuelle"}`;
        });
}
function renderDecision() {
    updateBusyControls();
    if (!current || !key) return;
    const row = rows[key],
        link = activeOccurrence(),
        source = sources[key];
    const blocked = acting || selecting || row.busy || stale;
    const hardIgnored = row.evidence.some((item) =>
        ["mailto", "tel", "internal"].includes(item.kind),
    );
    const kinds = [...new Set(row.evidence.map((item) => item.kind))];
    const panel = $("decision-panel"),
        samePanel = panel.dataset.key === key;
    const openEvidence = samePanel && panel.querySelector(".evidence")?.open;
    const openHistory = samePanel && panel.querySelector("#history")?.open;
    panel.dataset.key = key;
    $("decision-panel").innerHTML =
        `<div class="decision-card"><span class="eyebrow">LIEN ÉTUDIÉ</span><p class="target-label">${esc(link.label || "Lien sans libellé")}</p><a class="target-url" href="${esc(safeHref(source.url))}" target="_blank" rel="noopener noreferrer">${esc(source.url)}</a>
    ${row.category ? `<span class="badge ${row.category}">${categoryNames[row.category]}</span>` : '<span class="badge ignore">À classer</span>'}
    ${row.conflict ? '<span class="badge conflict">Indices contradictoires</span>' : ""}
    ${row.origin === "auto" ? `<p class="muted">Classement automatique · ${row.verified ? "vérifié" : "à vérifier"}</p>` : row.origin === "manual" ? `<p class="muted">Décision manuelle · ${esc(row.actor_name)}</p>` : ""}
    ${link.integration_hold ? '<p class="hold-note">Cette occurrence reste sans ID : aucun ID régional n’est validé pour « Toutes les régions ». Les autres occurrences du même lien gardent leur région.</p>' : ""}
    ${row.busy ? `<p class="info">${esc(row.lease_name)} travaille sur ce lien. Choisissez un autre lien disponible.</p>` : ""}
    ${stale ? '<p class="error-note">Une autre personne a modifié ce choix. Le dernier résultat est affiché.</p><button id="reclaim" class="quiet">Reprendre ce lien</button>' : ""}
    <div class="reason-row">${kinds.map((kind) => `<span class="badge ${kind === "tribune" ? "reason-tribune" : kind === "keyword" ? "reason-keyword" : "ignore"}">${esc(reasonNames[kind] || kind)}</span>`).join("")}</div>
    ${row.conflict ? '<p class="muted">Les indices ne permettent pas une décision automatique. Votre choix s’appliquera à toutes les occurrences de cette destination.</p>' : ""}
    <details class="evidence" ${row.conflict ? "open" : ""}><summary>Voir les indices et leur origine</summary><div id="evidence"></div></details>
    ${row.origin === "auto" && !row.verified ? `<button id="verify" class="verify-action" ${blocked ? "disabled" : ""}>${row.category === "held" ? "Confirmer la mise en attente" : "Confirmer : " + categoryNames[row.category]}</button>` : ""}
    ${row.category!==null&&(!hardIgnored||row.verified)?`<button class="quiet correction-toggle" id="show-correction" ${blocked?'disabled':''}>${hardIgnored?'Annuler la vérification':'Corriger le classement'}</button>`:''}
    ${!hardIgnored ? `<div id="correction-actions" ${row.origin === "auto" ? "hidden" : ""}><div class="actions"><button class="service-action" data-category="service" ${blocked ? "disabled" : ""}>Service</button><button class="relais-action" data-category="relais" ${blocked ? "disabled" : ""}>Relais</button></div><div class="actions"><button class="ignore-action" data-category="ignore" ${blocked ? "disabled" : ""}>Sans ID</button></div></div>` : ""}
    <div class="actions">${finished(row) ? '<button id="next" class="quiet">Lien suivant</button>' : `<button id="skip" class="quiet" ${blocked ? "disabled" : ""}>Passer pour plus tard</button>`}</div>
    <p class="muted">${source.occurrence_count > 1 ? `Ce choix concerne ${source.occurrence_count} occurrences de cette destination.` : "Ce choix concerne cette destination."}</p><details id="history"><summary>Historique du choix</summary><div class="history-list" id="history-list"></div></details></div>`;
    const evidence = $("evidence");
    const groupedKeywords = new Map();
    for (const item of row.evidence.filter(
        (value) => value.kind === "keyword",
    )) {
        const id = [
            item.category,
            item.keyword.toLowerCase(),
            item.snippet.trim(),
        ].join("|");
        if (!groupedKeywords.has(id))
            groupedKeywords.set(id, { ...item, scopes: [] });
        if (!groupedKeywords.get(id).scopes.includes(item.scope))
            groupedKeywords.get(id).scopes.push(item.scope);
    }
    const keywords = [...groupedKeywords.values()];
    const tribune = row.evidence
        .filter((item) => item.kind === "tribune")
        .flatMap((item) => item.sources || []);
    if (keywords.length) {
        const scopeNames = {
            label: "libellé",
            p: "paragraphe à un seul lien",
            li: "élément de liste à un seul lien",
        };
        evidence.innerHTML = `<p>Déclencheurs locaux :</p>${keywords
            .slice(0, 6)
            .map(
                (item) =>
                    `<p><span class="badge ${item.category}">${esc(item.keyword)}</span> ${item.scopes.map((scope) => scopeNames[scope]).join(", ")}</p><blockquote>${esc(item.snippet)}</blockquote>${item.context_id !== current.id ? `<button class="quiet" data-source-context="${item.context_id}">Voir le contexte source</button>` : ""}`,
            )
            .join("")}`;
        highlightHints(evidence);
    }
    if (tribune.length) {
        const unique = [
            ...new Map(tribune.map((item) => [item.source_url, item])).values(),
        ];
        evidence.innerHTML += `<p>Destination trouvée dans Tribune :</p>${unique
            .slice(0, 3)
            .map(
                (item) =>
                    `<p><a href="${esc(item.source_url)}" target="_blank" rel="noopener noreferrer">${esc(item.source_title)} · ${item.source_url.includes("/entreprises/") ? "entreprises" : "collectivités"}</a></p>`,
            )
            .join("")}`;
    }
    if (hardIgnored)
        evidence.innerHTML =
            "<p>Les liens email, téléphone et internes au site restent sans ID. Cette règle reste à vérifier dans la liste des automatismes.</p>";
    if (!row.evidence.length)
        evidence.innerHTML =
            "<p>À vous de choisir. Les mots surlignés ailleurs dans le contexte sont seulement des indices.</p>";
    document
        .querySelectorAll("[data-category]")
        .forEach((button) =>
            button.addEventListener("click", () =>
                save("decide", button.dataset.category),
            ),
        );
    $("verify")?.addEventListener("click", () => save("verify"));
    $("skip")?.addEventListener("click", () => save("skip"));
    $("next")?.addEventListener("click", () => {
        if (!acting && !selecting) advance();
    });
    $("show-correction")?.addEventListener("click", () => save("reset"));
    if (openEvidence) panel.querySelector(".evidence").open = true;
    if (openHistory) $("history").open = true;
    document.querySelectorAll("[data-source-context]").forEach((button) =>
        button.addEventListener("click", () => {
            const context = contexts.find(
                (value) => value.id === button.dataset.sourceContext,
            );
            if (context) selectTarget(context, key);
        }),
    );
    $("reclaim")?.addEventListener("click", () => selectTarget(current, key));
    const historyKey = key;
    $("history").addEventListener("toggle", async (event) => {
        if (!event.target.open) return;
        try {
            const data = await api("/api/history/" + historyKey);
            if (key !== historyKey) return;
            $("history-list").innerHTML = data.events.length
                ? data.events
                      .map(
                          (item) =>
                              `<p>${esc(item.actor_name)} · ${esc({ decide: "choix", verify: "vérification", skip: "report", undo: "annulation", reset: "remise à traiter" }[item.action])} · ${esc(categoryNames[item.after.category] || "Non classé")}<br>${new Date(item.at * 1000).toLocaleString("fr-FR")}</p>`,
                      )
                      .join("")
                : "Aucune modification manuelle.";
        } catch (error) {
            notify(error.message);
        }
    });
}
async function selectTarget(context, target, occurrenceId = null) {
    if (acting || selecting || !context || !target) return false;
    selecting = true;
    const previous = key,
        same = current?.id === context.id;
    try {
        if (current && key) renderDecision();
        if (previous && previous !== target)
            await api("/api/release", { key: previous });
        current = context;
        key = target;
        stale = false;
        currentOccurrenceId =
            occurrenceId ||
            context.links.find((link) => link.key === target)?.id;
        if (!same) renderContext();
        renderDecision();
        try {
            rows = (await api("/api/claim", { key: target })).decisions;
        } catch (error) {
            notify(error.message);
        }
        updateContext(same);
        refreshNavigation();
        const container = $("context-body"),
            anchor = container.querySelector(".current-link");
        if (anchor) {
            const box = container.getBoundingClientRect(),
                targetBox = anchor.getBoundingClientRect();
            if (targetBox.top < box.top || targetBox.bottom > box.bottom)
                container.scrollBy({
                    top: targetBox.top - box.top - 24,
                    behavior: "smooth",
                });
        }
        if (matchMedia("(max-width:980px)").matches)
            $("context-panel").scrollIntoView({
                block: "start",
                behavior: "smooth",
            });
        return !rows[target].busy;
    } finally {
        selecting = false;
        renderDecision();
    }
}
async function advance() {
    if (view === "browse") {
        refreshNavigation();
        return;
    }
    const ordered = [];
    if (current) {
        const list = contextKeys(current),
            index = list.indexOf(key);
        for (const value of [...list.slice(index + 1), ...list.slice(0, index)])
            ordered.push([current, value]);
    }
    for (const context of contexts) {
        if (context.id !== current?.id)
            for (const value of contextKeys(context))
                ordered.push([context, value]);
    }
    const seen = new Set([key]);
    for (const [context, value] of ordered) {
        if (
            seen.has(value) ||
            !visibleContext(context) ||
            !visibleRow(rows[value])
        )
            continue;
        seen.add(value);
        if (!rows[value].busy) {
            if (await selectTarget(context, value)) return;
        }
    }
    if (key) await api("/api/release", { key }).catch(() => {});
    current = null;
    key = null;
    refreshNavigation();
    const skipped = Object.values(rows).filter(
        (row) => row.skipped && !finished(row),
    ).length;
    $("context-panel").innerHTML =
        `<div class="empty"><h2>Cette sélection est terminée</h2><p>${skipped ? "Des liens ont été passés pour plus tard. Utilisez le filtre « Reprendre les liens passés » pour les retrouver." : "Choisissez une autre vue ou modifiez les filtres pour continuer."}</p></div>`;
    $("decision-panel").innerHTML = "";
}
async function save(action, category) {
    if (acting || selecting || !key || rows[key].busy || stale) return;
    acting = true;
    renderDecision();
    const target = key,
        context = current,
        version = rows[key].version;
    try {
        const result = await api("/api/decision", {
            key: target,
            version,
            action,
            category,
        });
        rows = result.decisions;
        lastAction = {
            key: target,
            event_id: result.event_id,
            context,
            version: rows[target].version,
        };
        stale = false;
        notify(
            action === "reset"
                ? "Classement annulé. Choisissez maintenant ou passez pour plus tard."
                : action === "verify"
                ? "Automatisme vérifié et enregistré."
                : action === "skip"
                  ? "Lien conservé pour plus tard."
                  : `Choix enregistré pour ${sources[target].occurrence_count} occurrence(s).`,
        );
        acting = false;
        if (action === "reset") {
            await selectTarget(context, target, currentOccurrenceId);
            refreshNavigation();
        } else if (returnToBrowse) await changeView("browse");
        else await advance();
    } catch (error) {
        acting = false;
        stale = error.status === 409;
        notify(error.message);
        refreshNavigation();
        renderDecision();
    }
}
async function changeView(next) {
    if (acting || selecting) return;
    selecting = true;
    if (current && key) renderDecision();
    else updateBusyControls();
    try {
        if (key) await api("/api/release", { key }).catch(() => {});
        view = next;
        current = null;
        key = null;
        stale = false;
        returnToBrowse = false;
        currentOccurrenceId = null;
    } finally {
        selecting = false;
    }
    refreshNavigation();
    await advance();
}
async function refresh() {
    if (acting || selecting || document.hidden) return;
    try {
        const requestedKey = key,
            old = key ? { ...rows[key] } : null;
        const result = await api("/api/decisions");
        if (acting || selecting || key !== requestedKey) return;
        rows = result.decisions;
        if (key && rows[key].version !== old.version) stale = true;
        refreshNavigation();
        if (current) {
            updateContext();
            if (
                ["version", "busy", "mine", "lease_name"].some(
                    (field) => old[field] !== rows[key][field],
                )
            )
                renderDecision();
        }
    } catch (error) {
        if (error.status === 401) showLogin();
        else notify(error.message);
    }
}
function showLogin() {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    $("application").hidden = true;
    $("login-screen").hidden = false;
}
async function start() {
    const data = await api("/api/bootstrap");
    contexts = data.contexts;
    sources = data.destinations;
    rows = data.decisions;
    datasetVersion = data.version;
    current = null;
    key = null;
    lastAction = null;
    stale = false;
    view = "manual";
    returnToBrowse = false;
    currentOccurrenceId = null;
    for (const field of Object.keys(filters)) {
        filters[field] = field === "deferred" ? "hide" : "";
        $(field).value = filters[field];
    }
    $("show-verified").checked = false;
    $("login-screen").hidden = true;
    $("application").hidden = false;
    $("reviewer").textContent = name;
    const regions = [
        ...new Map(
            contexts.map((context) => [
                regionKey(context),
                context.region.canonical || context.region.label,
            ]),
        ).entries(),
    ].sort((a, b) => a[1].localeCompare(b[1], "fr"));
    $("region").innerHTML =
        '<option value="">Toutes</option>' +
        regions
            .map(
                ([value, label]) =>
                    `<option value="${esc(value)}">${esc(label)}</option>`,
            )
            .join("");
    $("page").innerHTML =
        '<option value="">Toutes les pages</option>' +
        [
            ...new Map(
                contexts.map((context) => [
                    context.page_url,
                    context.page_title,
                ]),
            ).entries(),
        ]
            .map(
                ([url, title]) =>
                    `<option value="${esc(url)}">${esc(title)}</option>`,
            )
            .join("");
    refreshNavigation();
    await advance();
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 6000);
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
        if (!key || acting || selecting || stale || document.hidden) return;
        const target = key;
        try {
            const result = await api("/api/heartbeat", { key: target });
            if (key === target && !acting && !selecting)
                rows = result.decisions;
        } catch (error) {
            if (key === target) {
                notify(error.message);
                stale = true;
                renderDecision();
            }
        }
    }, 40000);
}
document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
        button.addEventListener("click", () => changeView(button.dataset.view)),
    );
for (const field of Object.keys(filters))
    $(field).addEventListener("change", () => {
        filters[field] = $(field).value;
        changeView(view);
    });
$("show-verified").addEventListener("change", () => changeView(view));
$("toggle-filters").addEventListener("click", () => {
    const open = $("sidebar").classList.toggle("open");
    $("toggle-filters").setAttribute("aria-expanded", String(open));
});
$("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("login-error").textContent = "";
    try {
        const result = await api("/api/login", {
            name: $("name").value,
            code: $("code").value,
        });
        name = result.name;
        csrf = result.csrf;
        await start();
    } catch (error) {
        $("login-error").textContent = error.message;
    }
});
$("logout").addEventListener("click", async () => {
    if (acting || selecting) return;
    await api("/api/logout", {});
    showLogin();
});
$("undo").addEventListener("click", async () => {
    if (!lastAction || acting || selecting) return;
    const action = lastAction;
    acting = true;
    try {
        const result = await api("/api/decision", {
            key: action.key,
            version: action.version,
            action: "undo",
            event_id: action.event_id,
        });
        rows = result.decisions;
        lastAction = null;
        acting = false;
        if (view === "browse") refreshNavigation();
        else await selectTarget(action.context, action.key);
        notify("Votre dernière action a été annulée.");
    } catch (error) {
        acting = false;
        lastAction = null;
        notify(error.message);
        refreshNavigation();
        renderDecision();
    }
});
(async () => {
    try {
        const info = await api("/api/session");
        $("code-label").hidden = !info.needs_code;
        if (info.authenticated) {
            name = info.name;
            csrf = info.csrf;
            await start();
        }
    } catch (error) {
        $("login-error").textContent = error.message;
    }
})();
