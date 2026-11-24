// Shared context content renderer. description_html comes from the server sanitizer.
window.PdcvContextView = {
  render(context, activeId, onSelect) {
    const root = document.createElement("article");
    root.className = "client-context";
    if (context.image) {
      const image = document.createElement("img");
      image.src = context.image;
      image.alt = "";
      root.append(image);
    }
    const title = document.createElement("h4");
    title.textContent = context.title || "Contexte sans titre";
    const description = document.createElement("div");
    description.className = "client-description";
    description.innerHTML = context.description_html;
    root.append(title, description);
    const active =
      context.links.find((link) => link.id === activeId) || context.links[0];
    description.querySelectorAll("a").forEach((anchor) => {
      anchor.classList.add(
        anchor.href === active?.destination ? "current-link" : "other-link",
      );
    });
    const links = document.createElement("div");
    links.className = "client-context-links";
    context.links.forEach((link) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        link.id === active?.id ? "client-target" : "client-sibling";
      button.textContent = link.label || link.destination;
      button.addEventListener("click", () => onSelect?.(link.id));
      links.append(button);
    });
    root.append(links);
    return root;
  },
};
