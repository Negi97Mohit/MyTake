document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".copy-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const text = btn.getAttribute("data-copy");
      navigator.clipboard.writeText(text).then(() => {
        const old = btn.innerText;
        btn.innerText = "COPIED!";
        setTimeout(() => btn.innerText = old, 2000);
      });
    });
  });
});
