// The things you'll want to change without touching the page.
export const SITE = {
  // Where the buttons and the marks in the nav and footer send people. An empty link shows as "opening soon" on
  // a button, and hides the mark.
  links: {
    discord: "",
    x: "https://x.com/gtadotmod",
    github: "https://github.com/GTADOTMOD/GTAMODS",
  },
  // RUGR Setup, the one file players download, as the download page shows it. A new release means a new
  // installer\build-release.ps1 build, published on GitHub Releases and the site: change all four.
  download: {
    url: "https://gtamod.onrender.com/downloads/RUGR-Setup-0.1.0.exe",
    version: "0.1.0",
    size: "36.3 MB",
    sha256: "5880c822fe6d0e6dd8bff4fbaf8174a756b86803f72769b27cdf1928b937837b",
  },
  // Official game logos, shown at every mention of the names except in the legal small print. They aren't part
  // of this repository: add them to assets/brand/ and list them here (gtaV, gtaVLine, gtaVI, rockstar) to show
  // them. Empty, the names show as plain text.
  logos: {},
};
