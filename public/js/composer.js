// The composer: a message to Claude, folded into its running turn or waking the session.
export function composer({ form, field, button, send }) {
  const grow = () => {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 220)}px`;
  };
  field.addEventListener("input", grow);
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = field.value.trim();
    if (!text) return;
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      await send(text);
      field.value = "";
      grow();
    } finally {
      button.disabled = false;
      button.textContent = "Send";
      field.focus();
    }
  });
}
