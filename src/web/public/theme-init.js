// Apply the saved (or OS-preferred) theme before first paint to avoid a flash.
// Loaded as a blocking classic script from index.html; kept out of the bundle
// (and out of the HTML) so the Content-Security-Policy can forbid inline script.
try {
  var t = localStorage.getItem("pos-theme");
  if (t !== "dark" && t !== "light")
    t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
} catch (e) {}
