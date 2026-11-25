window.PdcvTreeBrowser = class {
    constructor(container, onOpen) {
        this.container = container;
        this.onOpen = onOpen;
        this.dimensions = [
            ["audience", "Public"],
            ["page", "Page source"],
            ["status", "Avancement"],
            ["origin", "Origine du choix"],
            ["region", "Région"],
            ["category", "Classement"],
            ["reason", "Raison automatique"],
        ];
        this.levels = ["audience", "page", "status", "region"];
        try {
            const saved = JSON.parse(localStorage.getItem("pdcv-tree-levels"));
            if (Array.isArray(saved))
                this.levels = [...new Set(saved)].filter((key) =>
                    this.dimensions.some(([id]) => id === key),
                );
        } catch (_) {}
        this.expanded = new Set();
        this.items = [];
        this.rows = {};
        this.version = "";
        this.signature = "";
        this.pendingFocus = null;
        this.recentOccurrence = null;
        this.container.innerHTML =
            '<div class="browse-heading"><div><span class="eyebrow">EXPLORATION</span><h2>Arborescence des liens</h2><p id="tree-count" class="muted"></p></div></div><details class="tree-settings"><summary>Personnaliser les niveaux <span id="tree-path"></span></summary><div id="tree-levels"></div><button class="quiet" id="tree-add">Ajouter un niveau</button></details><p class="muted">Les filtres à gauche s’appliquent à cette arborescence. Ouvrez un lien pour consulter son contexte ou modifier son choix.</p><div class="tree-result-actions actions"><button class="quiet" id="tree-expand" aria-controls="browse-tree">Tout déplier</button><button class="quiet" id="tree-collapse" aria-controls="browse-tree">Tout replier</button></div><nav id="browse-tree" aria-label="Arborescence des PDCV"></nav>';
        this.container.querySelector("#tree-expand").onclick = () => {
            this.body.querySelectorAll("details").forEach((details) => {
                details.open = true;
                this.expanded.add(details.dataset.path);
            });
            this.persistExpansion();
        };
        this.container.querySelector("#tree-collapse").onclick = () => {
            this.pendingFocus = null;
            this.expanded.clear();
            this.body
                .querySelectorAll("details")
                .forEach((details) => (details.open = false));
            this.persistExpansion();
        };
        this.container.querySelector("#tree-add").onclick = () => {
            const next = this.dimensions.find(
                ([key]) => !this.levels.includes(key),
            );
            if (next) {
                this.levels.push(next[0]);
                this.layoutChanged();
            }
        };
        this.body = this.container.querySelector("#browse-tree");
        this.renderControls();
    }

    write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {}
    }
    persistExpansion() {
        this.write("pdcv-tree-expanded:" + this.version, [...this.expanded]);
    }
    layoutChanged() {
        this.write("pdcv-tree-levels", this.levels);
        this.expanded.clear();
        this.persistExpansion();
        this.signature = "";
        this.renderControls();
        this.renderTree();
    }
    renderControls() {
        const target = this.container.querySelector("#tree-levels");
        target.replaceChildren();
        this.levels.forEach((key, index) => {
            const row = document.createElement("div");
            row.className = "tree-level-row";
            const label = document.createElement("label");
            label.textContent = `Niveau ${index + 1}`;
            const select = document.createElement("select");
            select.className = "tree-level";
            select.setAttribute("aria-label", `Niveau ${index + 1}`);
            for (const [id, name] of this.dimensions) {
                const option = new Option(name, id, false, id === key);
                option.disabled = id !== key && this.levels.includes(id);
                select.append(option);
            }
            select.onchange = () => {
                this.levels[index] = select.value;
                this.layoutChanged();
            };
            label.append(select);
            row.append(label);
            for (const [text, offset] of [
                ["Monter", -1],
                ["Descendre", 1],
            ]) {
                const button = document.createElement("button");
                button.className = "quiet";
                button.textContent = text;
                button.setAttribute(
                    "aria-label",
                    `${text} le niveau ${this.dimensions.find(([id]) => id === key)[1]}`,
                );
                button.disabled =
                    index + offset < 0 || index + offset >= this.levels.length;
                button.onclick = () => {
                    [this.levels[index], this.levels[index + offset]] = [
                        this.levels[index + offset],
                        this.levels[index],
                    ];
                    this.layoutChanged();
                };
                row.append(button);
            }
            const remove = document.createElement("button");
            remove.className = "quiet";
            remove.textContent = "Retirer";
            remove.setAttribute("aria-label", `Retirer le niveau ${index + 1}`);
            remove.onclick = () => {
                this.levels.splice(index, 1);
                this.layoutChanged();
            };
            row.append(remove);
            target.append(row);
        });
        this.container.querySelector("#tree-add").disabled =
            this.levels.length === this.dimensions.length;
        this.container.querySelector("#tree-path").textContent = this.levels
            .length
            ? this.levels
                  .map((key) => this.dimensions.find(([id]) => id === key)[1])
                  .join(" / ")
            : "Liste simple";
    }
    reason(row) {
        if (row.origin === "manual") return "Décision manuelle";
        if (row.conflict) return "Indices contradictoires";
        const labels = {
            tribune: "Tribune",
            keyword: "Mot-clé local",
            mailto: "Email",
            tel: "Téléphone",
            internal: "Lien interne",
            region_hold: "Région sans ID",
        };
        return (
            [
                ...new Set(
                    row.evidence.map((item) => labels[item.kind] || item.kind),
                ),
            ]
                .sort()
                .join(" + ") || "Sans automatisme"
        );
    }
    value(item, dimension) {
        const row = this.rows[item.link.key],
            context = item.context;
        switch (dimension) {
            case "audience":
                return context.audience === "entreprises"
                    ? "Entreprises"
                    : "Collectivités";
            case "page":
                return context.page_title;
            case "status":
                return row.category !== null && row.verified
                    ? "Traité"
                    : "À traiter";
            case "origin":
                return {
                    auto: "Automatique",
                    manual: "Manuel",
                    unresolved: "Non classé",
                }[row.origin];
            case "region":
                return context.region.canonical || context.region.label;
            case "category":
                return (
                    {
                        service: "Service",
                        relais: "Relais",
                        ignore: "Sans ID",
                        held: "En attente d’un ID régional",
                    }[row.category] || "Non classé"
                );
            case "reason":
                return this.reason(row);
        }
    }
    update(items, rows, version) {
        if (this.version !== version) {
            this.version = version;
            try {
                this.expanded = new Set(
                    JSON.parse(
                        localStorage.getItem("pdcv-tree-expanded:" + version),
                    ) || [],
                );
            } catch (_) {
                this.expanded = new Set();
            }
        }
        const signature = JSON.stringify([
            items.map((item) => item.link.id),
            [...new Set(items.map((item) => item.link.key))].map((key) => [
                key,
                rows[key].version,
                rows[key].busy,
                rows[key].lease_name,
            ]),
        ]);
        this.items = items;
        this.rows = rows;
        if (signature === this.signature) return;
        this.signature = signature;
        this.renderTree();
    }
    renderTree() {
        const scroll = this.body.scrollTop;
        const focused = this.body.contains(document.activeElement)
            ? document.activeElement.dataset.occurrence
            : null;
        this.body.replaceChildren();
        this.container.querySelector("#tree-count").textContent =
            `${this.items.length} occurrences · ${new Set(this.items.map((item) => item.link.key)).size} destinations uniques`;
        if (!this.items.length) {
            const empty = document.createElement("p");
            empty.textContent = "Aucun lien avec ces filtres.";
            this.body.append(empty);
            return;
        }
        const build = (items, depth, path, parent) => {
            if (depth === this.levels.length) {
                const list = document.createElement("div");
                list.className = "tree-leaves";
                items.forEach((item) => list.append(this.leaf(item)));
                parent.append(list);
                return;
            }
            const dimension = this.levels[depth],
                groups = new Map();
            for (const item of items) {
                // Page URLs remain distinct even if two public pages share a title.
                const value =
                    dimension === "page"
                        ? item.context.page_url
                        : this.value(item, dimension);
                if (!groups.has(value)) groups.set(value, []);
                groups.get(value).push(item);
            }
            const sorted = [...groups.entries()].sort((a, b) =>
                this.value(a[1][0], dimension).localeCompare(
                    this.value(b[1][0], dimension),
                    "fr",
                ),
            );
            for (const [value, children] of sorted) {
                const details = document.createElement("details");
                details.className = "tree-branch";
                const branchPath = [...path, [dimension, value]],
                    id = JSON.stringify(branchPath);
                details.dataset.path = id;
                details.open = this.expanded.has(id);
                if (
                    this.pendingFocus &&
                    children.some((item) => item.link.id === this.pendingFocus)
                ) {
                    details.open = true;
                    this.expanded.add(id);
                }
                const summary = document.createElement("summary");
                const label = document.createElement("span");
                label.className = "tree-branch-label";
                label.textContent = this.value(children[0], dimension);
                const count = document.createElement("span");
                count.className = "tree-branch-count";
                count.textContent = String(children.length);
                summary.append(label, count);
                details.append(summary);
                build(children, depth + 1, branchPath, details);
                details.addEventListener("toggle", () => {
                    if (details.open) this.expanded.add(id);
                    else this.expanded.delete(id);
                    this.persistExpansion();
                });
                parent.append(details);
            }
        };
        build(this.items, 0, [], this.body);
        this.body.scrollTop = scroll;
        if (this.pendingFocus) {
            const button = this.body.querySelector(
                `[data-occurrence="${CSS.escape(this.pendingFocus)}"]`,
            );
            if (button) {
                button.focus({ preventScroll: true });
                this.body.scrollTop +=
                    button.getBoundingClientRect().top -
                    this.body.getBoundingClientRect().top -
                    30;
            }
            this.pendingFocus = null;
            this.persistExpansion();
        }
        if (focused)
            this.body
                .querySelector(`[data-occurrence="${CSS.escape(focused)}"]`)
                ?.focus({ preventScroll: true });
    }
    leaf(item) {
        const { context, link } = item,
            row = this.rows[link.key];
        const button = document.createElement("button");
        button.className = "tree-leaf";
        button.dataset.occurrence = link.id;
        if (link.id === this.recentOccurrence) button.classList.add("recent");
        const title = document.createElement("strong");
        title.textContent = link.label || "Lien sans libellé";
        const url = document.createElement("span");
        url.className = "tree-url";
        url.textContent = link.destination;
        const caption = document.createElement("span");
        caption.className = "tree-caption";
        caption.textContent = context.title;
        const tags = document.createElement("span");
        tags.className = "tree-tags";
        const tag = (text, kind, css = "") => {
            const span = document.createElement("span");
            span.className = `tree-tag tag-${kind} ${css}`;
            span.textContent = text;
            tags.append(span);
        };
        if (!this.levels.includes("audience"))
            tag(this.value(item, "audience"), "audience");
        if (!this.levels.includes("page"))
            tag(this.value(item, "page"), "page");
        if (!this.levels.includes("region"))
            tag(this.value(item, "region"), "region");
        if (!this.levels.includes("origin"))
            tag(this.value(item, "origin"), "origin");
        if (!this.levels.includes("status"))
            tag(this.value(item, "status"), "status");
        if (!this.levels.includes("category"))
            tag(
                this.value(item, "category"),
                "category",
                row.category || "ignore",
            );
        if (!this.levels.includes("reason") && row.origin === "auto") {
            const labels = {
                tribune: "Tribune",
                keyword: "Mot-clé local",
                mailto: "Email",
                tel: "Téléphone",
                internal: "Lien interne",
                region_hold: "Région sans ID",
            };
            for (const kind of new Set(
                row.evidence.map((evidence) => evidence.kind),
            ))
                tag(
                    labels[kind] || kind,
                    "reason",
                    kind === "tribune"
                        ? "reason-tribune"
                        : kind === "keyword"
                          ? "reason-keyword"
                          : "ignore",
                );
        }
        if (row.conflict)
            tag("Indices contradictoires", "conflict", "conflict");
        if (row.skipped) tag("Passé pour plus tard", "skipped");
        if (link.integration_hold) tag("ID régional en attente", "hold");
        if (row.busy) tag(`En cours : ${row.lease_name}`, "busy");
        button.append(title, url, caption, tags);
        button.setAttribute(
            "aria-label",
            `Ouvrir ${link.label || link.destination}, ${context.region.label}`,
        );
        button.onclick = () => {
            this.pendingFocus = link.id;
            this.recentOccurrence = link.id;
            this.onOpen(context.id, link.key, link.id);
        };
        return button;
    }
};
