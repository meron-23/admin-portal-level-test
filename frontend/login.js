const form = document.querySelector("#loginForm");
const errorText = document.querySelector("#loginError");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorText.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;

  try {
    const formData = new FormData(form);
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
