"use strict";
// AEGIS demo page logic. All screening is done by the bundled engine
// (window.AEGIS, assets/aegis.js) directly against public BSC RPC +
// Sourcify from the visitor's browser. This file only renders, plus
// one orchestrated motion moment (Anime.js): the screening sequence
// that ends with the verdict stamp. Recorded reports render static.

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
  const utc = (iso) => new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const errEl = $("error");
  function showError(html) {
    errEl.innerHTML = html;
    errEl.hidden = false;
  }
  function hideError() {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  if (!window.AEGIS) {
    showError(
      "<strong>Engine unavailable.</strong> The engine bundle (assets/aegis.js) failed to load, " +
      "so no screening can run on this page load. Please reload."
    );
    $("run").disabled = true;
    return;
  }
  const AEGIS = window.AEGIS;
  const FIELD_NAMES = ["reportVersion", "chainId", "walletHash", "contractHash", "simulationHash", "blockNumber"];
  const STAMP_SUB = ["NO RULE FIRED", "HUMAN CONFIRMATION REQUIRED", "DO NOT SIGN"];
  const REPLAY_FILE = {
    feg: "feg-claimfree-share.report.json",
    runinai: "runinai-claimfree.report.json",
    bnbbaby: "bnbbaby-mint0.report.json",
  };

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const anime = !reducedMotion && window.anime ? window.anime : null;
  const stageEls = Array.from(document.querySelectorAll("#pipeline .stage"));

  let selectedCase = null;
  let casePreviewJson = "";

  // --- case ledger -------------------------------------------------------
  const casesEl = $("cases");
  const caseOrder = Object.values(AEGIS.cases);
  for (const c of caseOrder) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "case";
    btn.id = "case-" + c.id;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.innerHTML =
      '<span class="ct">' + esc(c.title) + "</span>" +
      '<span class="cb">' + esc(c.blurb) + "</span>" +
      '<span class="cr"><span class="vtag v' + c.recorded.verdict + '">' + esc(c.recorded.verdictLabel) + "</span>" +
      " · recorded block " + c.recorded.blockNumber + "<br>" +
      "triggered " + esc(c.recorded.triggered.join(", ") || "none") + "<br>" +
      'commitment <span class="mono">' + esc(short(c.recorded.commitment, 26)) + "</span>" +
      (c.id === "runinai" ? "<br>verdict sealed on zkVerify" : "") +
      "</span>";
    btn.addEventListener("click", () => selectCase(c.id));
    casesEl.appendChild(btn);
  }
  casesEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const idx = caseOrder.findIndex((c) => selectedCase && c.id === selectedCase.id);
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const next = caseOrder[(idx + delta + caseOrder.length) % caseOrder.length];
    e.preventDefault();
    selectCase(next.id);
    $("case-" + next.id).focus();
  });

  function selectCase(id) {
    selectedCase = AEGIS.cases[id];
    casePreviewJson = JSON.stringify(selectedCase.preview, null, 2);
    $("preview").value = casePreviewJson;
    for (const c of caseOrder) {
      const el = $("case-" + c.id);
      el.classList.toggle("selected", c.id === id);
      el.setAttribute("aria-checked", c.id === id ? "true" : "false");
    }
    hideError();
    setStages("done");
    renderReport(selectedCase.recordedFull, "recorded");
  }

  // --- sealed proof panel --------------------------------------------------
  (function renderSealed() {
    const s = AEGIS.sealed;
    const k = s.kurier_job;
    const rows = [
      ["Status", '<span class="status-final">Finalized</span> <span class="sub">on zkVerify mainnet</span>'],
      ["Report", "RuninAI claimFree() — <span class='mono'>engine/replays/runinai-claimfree.report.json</span>"],
      ["Verdict sealed", "<strong>" + s.report_summary.verdict + " — " + esc(s.report_summary.verdict_label) + "</strong>"],
      ["Commitment", "<span class='mono break'>" + esc(s.report_summary.commitment) + "</span>"],
      ["Kurier job", "<span class='mono break'>" + esc(k.job_id) + "</span>"],
      ["Transaction", "<a href='" + esc(k.tx_explorer_url) + "'><span class='mono break'>" + esc(k.tx_hash) + "</span></a>"],
      ["Finalized", esc(utc(k.finalized_at_utc)) + " — 20 seconds after submission"],
      ["Proof", "Groth16 · VerdictCommit (<span class='mono'>circuits/verdict_commit.circom</span>) · verified locally with snarkjs before submission"],
      ["How it was sealed", "The operator ran <span class='mono'>seal-mainnet/seal-mainnet.js</span> on their own device with their Kurier mainnet key in a local file — the key never left the device."],
    ];
    $("sealedkv").innerHTML = rows
      .map((r) => "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>")
      .join("");
  })();

  // --- pipeline stages -----------------------------------------------------
  function setStages(state) {
    for (const el of stageEls) {
      el.classList.toggle("done", state === "done");
      el.classList.remove("active");
    }
  }
  let stageCycle = null;
  function startStageCycle() {
    setStages("idle");
    let i = 0;
    const tick = () => {
      stageEls.forEach((el, j) => el.classList.toggle("active", j === i % 4));
      i++;
    };
    tick();
    stageCycle = setInterval(tick, 850);
  }
  function stopStageCycle() {
    if (stageCycle) clearInterval(stageCycle);
    stageCycle = null;
    stageEls.forEach((el) => el.classList.remove("active"));
  }

  // --- run ------------------------------------------------------------------
  let timer = null;
  $("run").addEventListener("click", async () => {
    hideError();

    let preview;
    try {
      preview = JSON.parse($("preview").value);
    } catch (e) {
      showError("<strong>Not JSON.</strong> The preview box does not contain valid JSON: " + esc(e.message));
      return;
    }

    const runBtn = $("run");
    runBtn.disabled = true;
    runBtn.textContent = "Screening…";
    $("livestatus").textContent = "Screening in progress.";
    const t0 = Date.now();
    $("elapsed").textContent = "0.0 s";
    timer = setInterval(() => {
      $("elapsed").textContent = ((Date.now() - t0) / 1000).toFixed(1) + " s";
    }, 100);
    startStageCycle();

    try {
      const report = await AEGIS.screenPreview(preview);
      stopStageCycle();
      await renderReport(report, "live", true);
    } catch (e) {
      stopStageCycle();
      setStages("idle");
      $("livestatus").textContent = "Screening failed. No report was produced.";
      showError(
        "<strong>Screening failed.</strong> " + esc(e && e.message ? e.message : String(e)) +
        "\nThe engine fails closed in its verdicts, but a transport failure — a public RPC or Sourcify unreachable from your network — produces no report at all. Nothing was screened. Please retry."
      );
    } finally {
      clearInterval(timer);
      timer = null;
      runBtn.disabled = false;
      runBtn.textContent = "Screen it live";
    }
  });

  // --- the one motion moment --------------------------------------------------
  // After a live report lands: the pipeline stages tick off in sequence,
  // a highlight sweeps the fired rule rows, and the verdict stamp lands.
  // Recorded reports and reduced-motion visitors get the final state only.
  async function payoff(firedRows) {
    if (!anime) {
      setStages("done");
      return;
    }
    for (const el of stageEls) {
      el.classList.add("done");
      await anime.animate(el.querySelector(".snum"), {
        scale: [1, 1.35, 1],
        duration: 170,
        ease: "outQuad",
      });
      await sleep(24);
    }
    if (firedRows.length) {
      await anime.animate(firedRows, {
        backgroundColor: [
          { to: "rgba(233, 235, 237, 0.13)" },
          { to: "rgba(233, 235, 237, 0)" },
        ],
        duration: 550,
        delay: anime.stagger(45),
        ease: "outQuad",
      });
      for (const row of firedRows) row.style.backgroundColor = "";
    }
    const stamp = $("stamp");
    await anime.animate(stamp, {
      scale: [1.7, 1],
      rotate: ["-16deg", "-2.5deg"],
      opacity: [0, 1],
      duration: 430,
      ease: "outExpo",
    });
  }

  // --- render -------------------------------------------------------------------
  async function renderReport(r, mode, animateIt) {
    const stamp = $("stamp");
    stamp.className = "stamp v" + r.verdict;
    stamp.style.opacity = animateIt && anime ? "0" : "";
    $("stampword").textContent = r.verdictLabel;
    $("stampsub").textContent = STAMP_SUB[r.verdict];

    $("recordmode").innerHTML =
      mode === "recorded"
        ? "Recorded screening · <span class='mono'>engine/replays/" + REPLAY_FILE[selectedCase.id] + "</span>"
        : "Live screening · run in this browser just now";

    const dec = r.decoded || {};
    const callDesc = dec.signature
      ? dec.signature
      : (dec.name || dec.kind || "call") + " · data " + short(r.preview.data, 14);
    let detail =
      "<p class='call'>" + esc(callDesc) + " on <span class='mono'>" + esc(short(r.preview.to)) + "</span>" +
      (r.target && r.target.name ? " (" + esc(r.target.name) + ", " + esc(r.target.verification) + ")" : "") + "</p>" +
      "<p class='sub'>Screened against BSC block <strong>" + r.blockNumber + "</strong> · " + esc(utc(r.screenedAt)) + "</p>" +
      "<p class='sub'>Rules: " + r.ruleCounts.TRIGGERED + " triggered, " + r.ruleCounts.CLEAR + " clear, " +
      r.ruleCounts.NOT_IMPLEMENTED + " not implemented.</p>";

    if (mode === "recorded" && selectedCase && selectedCase.id === "runinai") {
      detail +=
        "<p class='sub sealedlink'>This report's verdict is sealed on zkVerify — <a href='#sealed'>see the seal record below</a>.</p>";
    }
    if (mode === "live" && selectedCase) {
      const edited = $("preview").value.trim() !== casePreviewJson.trim();
      detail +=
        "<p class='sub'>Recorded screening of this case (" + esc(utc(selectedCase.recorded.screenedAt)) +
        ", block " + selectedCase.recorded.blockNumber + "): <strong>" + esc(selectedCase.recorded.verdictLabel) + "</strong>" +
        " · triggered " + esc(selectedCase.recorded.triggered.join(", ") || "none") +
        " · commitment <span class='mono'>" + esc(short(selectedCase.recorded.commitment, 26)) + "</span></p>" +
        (edited ? "<p class='sub'>You edited the preview, so the live result is for your edited document; the recorded line is for the original committed preview.</p>" : "");
    }
    detail += "<p class='sub'>This verdict is anchored to block " + r.blockNumber + " and expires with it.</p>";
    $("vdetail").innerHTML = detail;

    // Canonical fields.
    let fh = "";
    r.fields.forEach((f, i) => {
      fh += "<dt>fields[" + i + "] · " + FIELD_NAMES[i] + "</dt><dd class='mono break'>" + esc(f) + "</dd>";
    });
    fh += "<dt>verdict (public)</dt><dd><strong>" + r.verdict + " — " + esc(r.verdictLabel) + "</strong></dd>";
    fh += "<dt>rulesBitmap</dt><dd class='mono break'>" + esc(r.rulesBitmap) + "</dd>";
    fh += "<dt>Poseidon commitment</dt><dd class='mono break'>" + esc(r.commitment) + "</dd>";
    $("fields").innerHTML = fh;

    // Effects.
    let eh = "";
    eh += "<dt>Simulation</dt><dd>" + esc(r.dataSources.simulation) + " — " + esc(simStatus(r)) + "</dd>";
    eh += "<dt>Wallet native delta (simulated)</dt><dd class='mono'>" + esc(r.effects.nativeDelta) + " wei</dd>";
    if (r.effects.tokenDeltas && r.effects.tokenDeltas.length) {
      eh += "<dt>Token deltas (simulated)</dt><dd class='mono'>" +
        r.effects.tokenDeltas.map((d) => short(d.token) + ": " + d.delta).join("<br>") + "</dd>";
    } else {
      eh += "<dt>Token deltas (simulated)</dt><dd>none</dd>";
    }
    if (r.effects.allowanceDeltas && r.effects.allowanceDeltas.length) {
      eh += "<dt>Allowance deltas</dt><dd class='mono'>" +
        r.effects.allowanceDeltas.map((a) => short(a.token) + " → " + short(a.spender) + ": " + a.amount).join("<br>") + "</dd>";
    }
    const sell = r.probes && r.probes.sell;
    if (sell) {
      let s;
      if (!sell.ran) s = "not run — " + (sell.reason || "probe unavailable");
      else if (!sell.transferOk) s = "sell path blocked — probe transfer failed" + (sell.error ? " (" + sell.error + ")" : "");
      else s = "sell path OK — pair received " + sell.received + " of " + sell.amount + " probed; effective sell fee " +
        (sell.feeBps == null ? "n/a" : (sell.feeBps / 100).toFixed(2) + "%");
      eh += "<dt>Sell / fee probe</dt><dd>" + esc(s) + "</dd>";
    }
    if (r.token) {
      eh += "<dt>Subject token</dt><dd><span class='mono'>" + esc(short(r.token.address)) + "</span>" +
        (r.token.name ? " (" + esc(r.token.name) + ")" : "") + " · " + esc(r.token.verification) +
        (r.token.capGetter && r.token.capGetter.present
          ? " · supply cap via " + esc(r.token.capGetter.name) + "(): " + esc(r.token.capGetter.value)
          : " · no supply cap found") + "</dd>";
    }
    if (r.warnings && r.warnings.length) {
      eh += "<dt>Engine warnings</dt><dd>" + r.warnings.map(esc).join("<br>") + "</dd>";
    }
    $("effects").innerHTML = eh;

    // Rules table.
    const sev = (id) => (id.startsWith("AEGIS-B") ? "block" : id.startsWith("AEGIS-W") ? "warn" : "allow");
    $("rules").innerHTML = r.rules.map((rule) => {
      let st, rowClass = "";
      if (rule.status === "TRIGGERED") {
        st = "<span class='st " + sev(rule.id) + "'>Triggered</span>";
        rowClass = sev(rule.id) === "block" ? " class='fired'" : sev(rule.id) === "warn" ? " class='fired-warn'" : "";
      } else if (rule.status === "CLEAR") {
        st = "<span class='st clear'>Clear</span>";
      } else {
        st = "<span class='st ni'>Not implemented</span>";
        rowClass = " class='ni'";
      }
      return "<tr" + rowClass + ">" +
        "<td class='mono'>" + esc(rule.id) + "</td>" +
        "<td>" + esc(rule.name) + "</td>" +
        "<td>" + st + "</td>" +
        "<td class='reason'>" + esc(rule.reason) + "</td></tr>";
    }).join("");

    $("livestatus").textContent =
      (mode === "recorded" ? "Recorded screening loaded. " : "Screening complete. ") +
      "Verdict " + r.verdictLabel + ". " + r.ruleCounts.TRIGGERED + " rules triggered.";

    if (animateIt) {
      const firedRows = Array.from($("rules").querySelectorAll("tr.fired, tr.fired-warn"));
      $("results").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
      await payoff(firedRows);
    }
  }

  function simStatus(r) {
    // The report carries no top-level simulation status; derive the
    // display from the B04 rule + dataSources.
    const b04 = (r.rules || []).find((x) => x.id === "AEGIS-B04");
    if (b04 && b04.status === "TRIGGERED") return "reverted / un-completable (AEGIS-B04 fired)";
    return "completed";
  }

  // Initial view: the sealed case, with its recorded report on the page.
  selectCase("runinai");
})();
