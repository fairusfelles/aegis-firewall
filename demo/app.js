"use strict";
// AEGIS demo page logic. All screening is done by the bundled engine
// (window.AEGIS, assets/aegis.js) directly against public BSC RPC +
// Sourcify from the visitor's browser. This file only renders.

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  const short = (s, n) => {
    s = String(s == null ? "" : s);
    return s.length > (n || 18) ? s.slice(0, 10) + "…" + s.slice(-6) : s;
  };

  if (!window.AEGIS) {
    $("error").style.display = "block";
    $("error").textContent =
      "The engine bundle (assets/aegis.js) failed to load, so screening is unavailable on this page load. Please reload.";
    $("run").disabled = true;
    return;
  }
  const AEGIS = window.AEGIS;
  const FIELD_NAMES = ["reportVersion", "chainId", "walletHash", "contractHash", "simulationHash", "blockNumber"];
  const VERDICT_CLASS = ["allow", "warn", "block"];

  let selectedCase = null;
  let casePreviewJson = "";

  // --- case cards ------------------------------------------------------
  const casesEl = $("cases");
  for (const c of Object.values(AEGIS.cases)) {
    const btn = document.createElement("button");
    btn.className = "case";
    btn.id = "case-" + c.id;
    btn.innerHTML =
      '<div class="ct">' + esc(c.title) + "</div>" +
      '<div class="cb">' + esc(c.blurb) + "</div>" +
      '<div class="cr">Recorded screening: ' +
      '<span class="chip ' + VERDICT_CLASS[c.recorded.verdict] + '">' + esc(c.recorded.verdictLabel) + "</span> " +
      "block " + c.recorded.blockNumber + " · triggered " +
      esc(c.recorded.triggered.join(", ") || "none") +
      '<br>commitment <span class="mono">' + esc(short(c.recorded.commitment, 26)) + "</span></div>";
    btn.addEventListener("click", () => selectCase(c.id, true));
    casesEl.appendChild(btn);
  }

  function selectCase(id, scroll) {
    selectedCase = AEGIS.cases[id];
    casePreviewJson = JSON.stringify(selectedCase.preview, null, 2);
    $("preview").value = casePreviewJson;
    for (const c of Object.values(AEGIS.cases)) {
      $("case-" + c.id).classList.toggle("selected", c.id === id);
    }
    if (scroll) $("preview").focus();
  }
  selectCase("feg", false);

  // --- run --------------------------------------------------------------
  let timer = null;
  $("run").addEventListener("click", async () => {
    const errEl = $("error");
    errEl.style.display = "none";
    $("results").style.display = "none";

    let preview;
    try {
      preview = JSON.parse($("preview").value);
    } catch (e) {
      errEl.style.display = "block";
      errEl.textContent = "The preview box does not contain valid JSON: " + e.message;
      return;
    }

    const runBtn = $("run");
    runBtn.disabled = true;
    runBtn.textContent = "Screening…";
    const prog = $("progress");
    prog.style.display = "block";
    prog.querySelectorAll(".step").forEach((s) => s.classList.remove("done"));
    const t0 = Date.now();
    $("elapsed").textContent = "0.0 s";
    timer = setInterval(() => {
      $("elapsed").textContent = ((Date.now() - t0) / 1000).toFixed(1) + " s";
    }, 100);

    try {
      const report = await AEGIS.screenPreview(preview);
      prog.querySelectorAll(".step").forEach((s) => s.classList.add("done"));
      render(report);
    } catch (e) {
      errEl.style.display = "block";
      errEl.textContent =
        "Screening failed: " + (e && e.message ? e.message : String(e)) +
        "\nThe engine fails closed in its verdicts, but a transport failure (public RPC / Sourcify unreachable from your network) produces no report at all. Please retry.";
    } finally {
      clearInterval(timer);
      timer = null;
      runBtn.disabled = false;
      runBtn.textContent = "Run screening";
      setTimeout(() => { prog.style.display = "none"; }, 1200);
    }
  });

  // --- render -------------------------------------------------------------
  function render(r) {
    $("results").style.display = "block";

    const card = $("verdict-card");
    card.className = "verdict-card v" + r.verdict;
    $("vlabel").textContent = r.verdictLabel;
    const dec = r.decoded || {};
    const callDesc = dec.signature
      ? dec.signature
      : (dec.name || dec.kind || "call") + " · data " + short(r.preview.data, 14);
    $("vsub").innerHTML =
      esc(callDesc) + " on <span class='mono'>" + esc(short(r.preview.to)) + "</span>" +
      (r.target && r.target.name ? " (" + esc(r.target.name) + ", " + esc(r.target.verification) + ")" : "") +
      "<br>Screened against BSC block <strong>" + r.blockNumber + "</strong> · " +
      esc(new Date(r.screenedAt).toLocaleString()) +
      " · rules: " + r.ruleCounts.TRIGGERED + " triggered, " + r.ruleCounts.CLEAR + " clear, " +
      r.ruleCounts.NOT_IMPLEMENTED + " not implemented" +
      "<br><span class='small'>This verdict is anchored to block " + r.blockNumber + " and expires with it.</span>";

    // Recorded-vs-live comparison for the committed field cases.
    const rec = $("vrecorded");
    if (selectedCase) {
      const edited = $("preview").value.trim() !== casePreviewJson.trim();
      rec.innerHTML =
        "Recorded screening of this case (" + esc(new Date(selectedCase.recorded.screenedAt).toLocaleDateString()) +
        ", block " + selectedCase.recorded.blockNumber + "): <strong>" + esc(selectedCase.recorded.verdictLabel) + "</strong>" +
        " · triggered " + esc(selectedCase.recorded.triggered.join(", ") || "none") +
        " · commitment <span class='mono'>" + esc(short(selectedCase.recorded.commitment, 26)) + "</span>" +
        (edited ? "<br><span class='small'>Note: you edited the preview, so the live result above is for your edited document; the recorded line is for the original committed preview.</span>" : "");
    } else {
      rec.textContent = "";
    }

    // Canonical fields.
    let fh = "";
    r.fields.forEach((f, i) => {
      fh += "<div class='k'>fields[" + i + "] · " + FIELD_NAMES[i] + "</div><div class='mono break'>" + esc(f) + "</div>";
    });
    fh += "<div class='k'>verdict (public)</div><div><strong>" + r.verdict + " — " + esc(r.verdictLabel) + "</strong></div>";
    fh += "<div class='k'>rulesBitmap</div><div class='mono break'>" + esc(r.rulesBitmap) + "</div>";
    fh += "<div class='k'>Poseidon commitment</div><div class='mono break'>" + esc(r.commitment) + "</div>";
    $("fields").innerHTML = fh;

    // Effects.
    let eh = "";
    eh += "<div class='k'>Simulation</div><div>" + esc(r.dataSources.simulation) + " — " + esc(simStatus(r)) + "</div>";
    eh += "<div class='k'>Wallet native delta (simulated)</div><div class='mono'>" + esc(r.effects.nativeDelta) + " wei</div>";
    if (r.effects.tokenDeltas && r.effects.tokenDeltas.length) {
      eh += "<div class='k'>Token deltas (simulated)</div><div class='mono'>" +
        r.effects.tokenDeltas.map((d) => short(d.token) + ": " + d.delta).join("<br>") + "</div>";
    } else {
      eh += "<div class='k'>Token deltas (simulated)</div><div>none</div>";
    }
    if (r.effects.allowanceDeltas && r.effects.allowanceDeltas.length) {
      eh += "<div class='k'>Allowance deltas</div><div class='mono'>" +
        r.effects.allowanceDeltas.map((a) => short(a.token) + " → " + short(a.spender) + ": " + a.amount).join("<br>") + "</div>";
    }
    const sell = r.probes && r.probes.sell;
    if (sell) {
      let s;
      if (!sell.ran) s = "not run — " + (sell.reason || "probe unavailable");
      else if (!sell.transferOk) s = "sell path BLOCKED — probe transfer failed" + (sell.error ? " (" + sell.error + ")" : "");
      else s = "sell path OK — pair received " + sell.received + " of " + sell.amount + " probed; effective sell fee " +
        (sell.feeBps == null ? "n/a" : (sell.feeBps / 100).toFixed(2) + "%");
      eh += "<div class='k'>Sell / fee probe</div><div>" + esc(s) + "</div>";
    }
    if (r.token) {
      eh += "<div class='k'>Subject token</div><div><span class='mono'>" + esc(short(r.token.address)) + "</span>" +
        (r.token.name ? " (" + esc(r.token.name) + ")" : "") + " · " + esc(r.token.verification) +
        (r.token.capGetter && r.token.capGetter.present
          ? " · supply cap via " + esc(r.token.capGetter.name) + "(): " + esc(r.token.capGetter.value)
          : " · no supply cap found") + "</div>";
    }
    if (r.warnings && r.warnings.length) {
      eh += "<div class='k'>Engine warnings</div><div>" + r.warnings.map(esc).join("<br>") + "</div>";
    }
    $("effects").innerHTML = eh;

    // Rules table.
    const sev = (id) => (id.startsWith("AEGIS-B") ? "block" : id.startsWith("AEGIS-W") ? "warn" : "allow");
    $("rules").innerHTML = r.rules.map((rule) => {
      let chip;
      if (rule.status === "TRIGGERED") chip = "<span class='chip " + sev(rule.id) + "'>TRIGGERED</span>";
      else if (rule.status === "CLEAR") chip = "<span class='chip clear'>CLEAR</span>";
      else chip = "<span class='chip ni'>NOT_IMPLEMENTED</span>";
      return "<tr" + (rule.status === "NOT_IMPLEMENTED" ? " class='ni'" : "") + ">" +
        "<td class='mono'>" + esc(rule.id) + "</td>" +
        "<td>" + esc(rule.name) + "</td>" +
        "<td>" + chip + "</td>" +
        "<td class='reason'>" + esc(rule.reason) + "</td></tr>";
    }).join("");

    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function simStatus(r) {
    // The report does not carry a top-level simulation status field;
    // derive the display from the B04 rule + dataSources.
    const b04 = (r.rules || []).find((x) => x.id === "AEGIS-B04");
    if (b04 && b04.status === "TRIGGERED") return "reverted / un-completable (AEGIS-B04 fired)";
    return "completed";
  }
})();
