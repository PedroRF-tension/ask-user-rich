/* global marked, DOMPurify */
// Markdown, sanitised, and a small element builder: shared by the Thread page and the index.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function md(text, className = "md") {
  const div = document.createElement("div");
  div.className = className;
  div.innerHTML = DOMPurify.sanitize(marked.parse(text ?? "", { gfm: true, breaks: false }));
  return div;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function themeToggle(button) {
  const apply = (theme) => {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    button.textContent = `Theme: ${theme}`;
  };
  let theme = localStorage.getItem("aur:theme") || "auto";
  apply(theme);
  button.addEventListener("click", () => {
    theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    localStorage.setItem("aur:theme", theme);
    apply(theme);
  });
}

export function timeOf(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
