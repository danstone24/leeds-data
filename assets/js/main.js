// Page bootstrap. Kept tiny on purpose — each topic page will import its own chart modules.
import { pingApi } from "./api.js";

const REPO_URL = "https://github.com/danstone24/leeds-data";

function setRepoLink() {
  const link = document.getElementById("repo-link");
  if (link) link.href = REPO_URL;
}

async function showApiStatus() {
  const status = document.getElementById("status");
  if (!status) return;

  try {
    const health = await pingApi();
    if (health?.ok) {
      status.innerHTML =
        '<span class="status-dot"></span> Live — last data refresh ' +
        new Date(health.updated).toLocaleString("en-GB");
    }
  } catch {
    // API not deployed yet — leave the default "under construction" message.
  }
}

setRepoLink();
showApiStatus();
