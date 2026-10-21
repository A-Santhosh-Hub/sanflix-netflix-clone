(function () {
  "use strict";
  const { requestJSON, csrfHeaders } = Sanflix;
  document.addEventListener("DOMContentLoaded", setupAdmin);
  function setupAdmin() {
    const loginLink = document.getElementById("admin-login-link");
    const loginModal = document.getElementById("admin-login-modal");
    const loginForm = document.getElementById("admin-login-form");
    const loginStatus = document.getElementById("admin-login-status");
    const password = document.getElementById("admin-password");
    const modal = document.getElementById("admin-modal");
    const form = document.getElementById("admin-upload-form");
    const status = document.getElementById("upload-status");
    const category = document.getElementById("upload-category");
    const show = document.getElementById("upload-show");
    const showField = document.getElementById("upload-show-field");
    const submit = document.getElementById("admin-submit-btn");
    const progress = document.getElementById("upload-progress-container");
    if (!loginLink) return;

    function updateShowField() {
      const required = category.value === "series";
      showField.classList.toggle("hidden", !required);
      show.required = required;
      show.disabled = !required;
    }
    category.addEventListener("change", updateShowField);
    updateShowField();
    loginLink.addEventListener("click", (event) => {
      event.preventDefault();
      password.value = "";
      loginStatus.textContent = "";
      loginModal.classList.remove("hidden");
      password.focus();
    });
    const close = (panel) => {
      panel.classList.add("hidden");
      loginLink.focus();
    };
    document
      .getElementById("admin-login-close")
      .addEventListener("click", () => close(loginModal));
    document
      .getElementById("admin-close")
      .addEventListener("click", () => close(modal));
    [loginModal, modal].forEach((panel) =>
      panel.addEventListener("click", (e) => {
        if (e.target === panel) close(panel);
      }),
    );
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        (!loginModal.classList.contains("hidden") ||
          !modal.classList.contains("hidden"))
      ) {
        close(loginModal);
        close(modal);
      }
    });
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = document.getElementById("admin-login-btn");
      button.disabled = true;
      loginStatus.textContent = "";
      try {
        await requestJSON("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: password.value }),
        });
        password.value = "";
        loginModal.classList.add("hidden");
        modal.classList.remove("hidden");
        document.getElementById("admin-close").focus();
        form.reset();
        updateShowField();
        status.textContent = "";
        progress.classList.add("hidden");
      } catch (error) {
        loginStatus.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });

    async function waitForCatalog(id) {
      for (let attempt = 0; attempt < 120; attempt++) {
        const scan = await requestJSON("/api/admin/scan-status", {
          cache: "no-store",
        });
        if (scan.error) throw new Error(scan.error);
        const library = await requestJSON("/api/media", { cache: "no-store" });
        if (library.some((item) => item.id === id)) {
          window.location.reload();
          return;
        }
        if (!scan.running)
          throw new Error(
            "The scan finished without this file. Check the server log.",
          );
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      throw new Error(
        "Your upload is saved. Scanning is still running; refresh the library later.",
      );
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      submit.disabled = true;
      status.textContent = "Uploading...";
      status.style.color = "var(--text-secondary)";
      progress.classList.remove("hidden");
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/admin/upload");
      Object.entries(csrfHeaders()).forEach(([key, value]) =>
        xhr.setRequestHeader(key, value),
      );
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100) + "%";
        document.getElementById("upload-percent").textContent = percent;
        document.getElementById("upload-bar").style.width = percent;
      };
      xhr.onload = async () => {
        try {
          const result = JSON.parse(xhr.responseText);
          if (xhr.status < 200 || xhr.status >= 300 || !result.success) {
            throw new Error(result.error || "Upload failed.");
          }
          status.textContent =
            "Upload saved. Waiting for the library to finish updating...";
          await waitForCatalog(result.id);
        } catch (error) {
          status.textContent = error.message;
          status.style.color = "var(--red)";
        } finally {
          submit.disabled = false;
        }
      };
      xhr.onerror = () => {
        submit.disabled = false;
        status.textContent =
          "Connection lost. Check the library before retrying your upload.";
      };
      xhr.send(new FormData(form));
    });
  }
})();
