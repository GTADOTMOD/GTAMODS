// The download page: the links from site-config.js, the file's details, copy and share, and the sections
// rising in as they're reached. No 3D and no smooth-scroll library: this page is for reading.
import { SITE } from "./site-config.js";

const root = document.documentElement;
const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const file = SITE.download;

// ---- the links and marks, as on the home page ----
for (const link of document.querySelectorAll("[data-link]")) {
  const href = SITE.links[link.dataset.link];
  if (href) {
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
  } else {
    link.hidden = true;
  }
}

// ---- the file: where it is, its version, size and checksum ----
if (file) {
  const name = file.url.split("/").pop();
  const fill = {
    href: (el) => (el.href = file.url),
    version: (el) => (el.textContent = file.version),
    size: (el) => (el.textContent = file.size),
    file: (el) => (el.textContent = name),
    "sha-short": (el) => {
      el.textContent = `${file.sha256.slice(0, 8)}…${file.sha256.slice(-8)}`;
      el.title = file.sha256;
    },
  };
  for (const el of document.querySelectorAll("[data-download]")) fill[el.dataset.download]?.(el);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const done = await copy(button.dataset.copy === "sha256" ? file?.sha256 ?? "" : location.href);
    button.textContent = done ? "Copied" : "Select it";
    setTimeout(() => (button.textContent = "Copy"), 1800);
  });
}

// On a phone, the way to get RUGR is to send the page to the PC.
const share = document.querySelector("[data-share]");
share?.addEventListener("click", async () => {
  const url = location.href.split("#")[0];
  if (navigator.share) {
    try {
      await navigator.share({ title: "Download RUGR", text: "RUGR for GTA V on PC", url });
      return;
    } catch {
      // Closed the share sheet, or it isn't allowed here: copy instead.
    }
  }
  share.textContent = (await copy(url)) ? "Link copied" : url;
});

// ---- after the download starts, say what's next ----
const toast = document.getElementById("toast");
let toastTimer = 0;
for (const button of document.querySelectorAll('[data-download="href"]')) {
  button.addEventListener("click", () => {
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 12000);
  });
}
toast.querySelector("a").addEventListener("click", () => (toast.hidden = true));

// ---- sections rise in as they're reached ----
if (!calm && "IntersectionObserver" in window) {
  root.classList.add("motion");
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  document.querySelectorAll(".reveal").forEach((el) => seen.observe(el));
}

// A link from RUGR Setup to a help answer opens it.
function openFromHash() {
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target?.tagName === "DETAILS") target.open = true;
}
openFromHash();
window.addEventListener("hashchange", openFromHash);
