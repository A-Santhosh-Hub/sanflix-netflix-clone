(function (root) {
  "use strict";
  document.addEventListener("DOMContentLoaded", () => {
    const { requestJSON } = root.Sanflix;
    const $ = (id) => document.getElementById(id);
    const modal = $("share-modal");
    if (!modal) return;
    const manage = $("shares-modal");
    let target = null,
      returnFocus = null;

    const show = (element, visible) => element.classList.toggle("hidden", !visible);
    function openPanel(panel, focusId) {
      returnFocus = document.activeElement;
      show(panel, true);
      $(focusId).focus();
    }
    function closePanel(panel) {
      show(panel, false);
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    }
    async function copyText(text, field) {
      try {
        if (navigator.clipboard && root.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_) {}
      field.focus();
      field.select();
      field.setSelectionRange(0, text.length);
      try {
        return document.execCommand("copy");
      } catch (_) {
        return false;
      }
    }
    const when = (seconds) => new Date(seconds * 1000).toLocaleString();

    function resetForm() {
      show($("share-form"), true);
      show($("share-result"), false);
      $("share-url").value = "";
      $("share-status").textContent = "";
      $("share-copy-status").textContent = "";
    }

    async function open(item) {
      if (!item) return;
      target = item;
      resetForm();
      show($("share-blocked"), false);
      $("share-target").textContent = [item.show, item.display_title || item.title].filter(Boolean).join(" — ");
      openPanel(modal, "share-close");
      try {
        const policy = await requestJSON("/api/shares/me");
        const select = $("share-duration");
        select.replaceChildren(
          ...policy.durations.map((option) => {
            const element = document.createElement("option");
            element.value = option.key;
            element.textContent = option.label;
            return element;
          }),
        );
        select.value = policy.default;
        if (!policy.can_create) {
          show($("share-form"), false);
          $("share-blocked-text").textContent =
            "Creating private links needs admin sign-in. Use Manage library in the footer, then try again.";
          show($("share-blocked"), true);
        }
      } catch (error) {
        $("share-status").textContent = error.message;
      }
    }

    $("share-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = $("share-create");
      const allowStream = $("share-stream").checked,
        allowDownload = $("share-download").checked;
      if (!allowStream && !allowDownload) {
        $("share-status").textContent = "Allow streaming, downloading, or both.";
        return;
      }
      button.disabled = true;
      $("share-status").textContent = "Creating link…";
      try {
        const created = await requestJSON("/api/shares", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media_id: target.id,
            duration: $("share-duration").value,
            allow_stream: allowStream,
            allow_download: allowDownload,
          }),
        });
        $("share-url").value = root.location.origin + created.path;
        $("share-result-note").textContent =
          "Anyone with this link can " +
          [created.allow_stream && "watch", created.allow_download && "download"].filter(Boolean).join(" and ") +
          " this title until " + when(created.expires_at) + ". It will not be shown again.";
        show($("share-form"), false);
        show($("share-result"), true);
        $("share-url").focus();
        $("share-url").select();
      } catch (error) {
        $("share-status").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });

    $("share-copy").addEventListener("click", async () => {
      const ok = await copyText($("share-url").value, $("share-url"));
      $("share-copy-status").textContent = ok ? "Link copied." : "Copy failed. Select the link and copy it manually.";
    });
    $("share-another").addEventListener("click", resetForm);
    $("share-signin").addEventListener("click", () => {
      closePanel(modal);
      const link = $("admin-login-link");
      if (link) link.click();
    });
    $("share-close").addEventListener("click", () => closePanel(modal));

    function statusLabel(row) {
      const parts = [row.status === "active" ? "Active" : row.status === "revoked" ? "Revoked" : "Expired"];
      parts.push([row.allow_stream && "Stream", row.allow_download && "Download"].filter(Boolean).join(" + "));
      parts.push((row.status === "active" ? "Expires " : "Expired ") + when(row.expires_at));
      parts.push(row.access_count + (row.access_count === 1 ? " visit" : " visits"));
      return parts.join(" · ");
    }

    async function loadShares() {
      const status = $("shares-status"),
        list = $("shares-list");
      status.textContent = "Loading…";
      try {
        const data = await requestJSON("/api/shares");
        status.textContent = data.shares.length
          ? data.admin
            ? "As admin you can see and revoke every link."
            : ""
          : "No links yet. Use Share on any title.";
        list.replaceChildren(
          ...data.shares.map((row) => {
            const item = document.createElement("article");
            item.className = "share-row share-" + row.status;
            const copy = document.createElement("div");
            const title = document.createElement("strong");
            title.textContent = row.title;
            const meta = document.createElement("span");
            meta.textContent = statusLabel(row) + (data.admin && !row.mine ? " · other browser" : "");
            copy.append(title, meta);
            item.append(copy);
            if (row.status === "active") {
              const revoke = document.createElement("button");
              revoke.type = "button";
              revoke.className = "btn-info";
              revoke.textContent = "Revoke";
              revoke.setAttribute("aria-label", "Revoke link to " + row.title);
              revoke.addEventListener("click", async () => {
                revoke.disabled = true;
                try {
                  await requestJSON("/api/shares/" + encodeURIComponent(row.id) + "/revoke", { method: "POST" });
                  await loadShares();
                } catch (error) {
                  status.textContent = error.message;
                  revoke.disabled = false;
                }
              });
              item.append(revoke);
            }
            return item;
          }),
        );
      } catch (error) {
        status.textContent = error.message;
      }
    }

    const sharesLink = $("shares-link");
    if (sharesLink)
      sharesLink.addEventListener("click", (event) => {
        event.preventDefault();
        openPanel(manage, "shares-close");
        loadShares();
      });
    $("shares-close").addEventListener("click", () => closePanel(manage));
    [modal, manage].forEach((panel) =>
      panel.addEventListener("click", (event) => {
        if (event.target === panel) closePanel(panel);
      }),
    );
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      [modal, manage].forEach((panel) => {
        if (!panel.classList.contains("hidden")) closePanel(panel);
      });
    });

    root.SanflixShare = { open };
  });
})(window);
