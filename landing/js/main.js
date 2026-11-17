import { SITE } from "./site-config.js";

// The same question as the stylesheet link in index.html. Phones get their own version and never load the desktop's 3D.
const PHONE = window.matchMedia("(max-width: 899px), (max-height: 500px)");

// ---- what you can change in site-config.js ---------------------------------

for (const mark of document.querySelectorAll("[data-logo]")) {
  const src = SITE.logos[mark.dataset.logo];
  if (!src) continue;
  const img = new Image();
  // Until the file is there, the name stays as text. Rockstar's mark has no words in it, so it keeps them.
  const keepName = "logoName" in mark.dataset;
  img.alt = keepName ? "" : mark.textContent.trim();
  img.onload = () => (keepName ? mark.prepend(img) : mark.replaceChildren(img));
  img.src = PHONE.matches ? src.replace("assets/brand/", "assets/mobile/brand-").replace(".png", ".webp") : src;
}

for (const link of document.querySelectorAll("[data-link]")) {
  const href = SITE.links[link.dataset.link];
  if (href) {
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
  } else if (link.classList.contains("social")) {
    link.hidden = true;
  } else {
    link.textContent = `${link.dataset.name}: opening soon`;
    link.setAttribute("aria-disabled", "true");
    link.classList.add("btn-soon");
    link.addEventListener("click", (e) => e.preventDefault());
  }
}

// ---- which version ----------------------------------------------------------

import(PHONE.matches ? "./mobile.js" : "./desktop.js");

// A window dragged across the line, or a tablet turned, changes version.
PHONE.addEventListener("change", () => window.location.reload());
