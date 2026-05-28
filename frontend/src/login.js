const form = document.querySelector("#loginForm");
const errorText = document.querySelector("#loginError");

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorText.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;

  try {
    const formData = new FormData(form);
    const response = await fetch(`${BACKEND_URL}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password"),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Sign in failed");
    window.location.href = "/index.html";
  } catch (error) {
    errorText.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
