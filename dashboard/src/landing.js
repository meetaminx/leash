// Landing page: hero animation, page viewer, payment simulator, walkthrough.

import "./intro.js";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------
// Hero: an agent reads a poisoned page, tries to pay the attacker, Wardly blocks it.
// ---------------------------------------------------------------------------

const scene = document.getElementById("scene");
const STAGES = [
  ["s1", 200],
  ["s2", 1300],
  ["s3", 2500],
  ["s4", 3700],
  ["s5", 5200],
  ["s6", 5900],
];
let heroTimers = [];

function playHero() {
  heroTimers.forEach(clearTimeout);
  heroTimers = [];
  scene.classList.remove(...STAGES.map(([s]) => s));
  if (reduceMotion) {
    scene.classList.add(...STAGES.map(([s]) => s));
    return;
  }
  // Restart CSS animations cleanly.
  void scene.offsetWidth;
  for (const [cls, at] of STAGES) heroTimers.push(setTimeout(() => scene.classList.add(cls), at));
}

document.querySelectorAll("[data-replay]").forEach((btn) =>
  btn.addEventListener("click", () => {
    scene.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    playHero();
  }),
);
// Play on load, hold the result, then replay, so it's running whenever someone looks.
const LOOP_MS = 10500;
let loopTimer;
function loopHero() {
  playHero();
  clearInterval(loopTimer);
  if (!reduceMotion) loopTimer = setInterval(() => {
    if (!document.hidden) playHero();
  }, LOOP_MS);
}
document.querySelectorAll("[data-replay]").forEach((btn) => btn.addEventListener("click", loopHero));
// Mobile menu: open and close the section links.
const menuBtn = document.querySelector(".lp-menu-btn");
const menu = document.getElementById("lp-links");
function setMenu(open) {
  menu.classList.toggle("open", open);
  menuBtn.setAttribute("aria-expanded", String(open));
}
menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(!menu.classList.contains("open"));
});
menu.addEventListener("click", (e) => {
  if (e.target.closest("a")) setMenu(false);
});
document.addEventListener("click", (e) => {
  if (menu.classList.contains("open") && !e.target.closest(".lp-nav")) setMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menu.classList.contains("open")) {
    setMenu(false);
    menuBtn.focus();
  }
});

// Start the hero once the intro (if any) has opened the page.
window.__introReveal.then(loopHero);

// ---------------------------------------------------------------------------
// "What a person sees" vs "What the agent reads"
// ---------------------------------------------------------------------------

const tabs = document.querySelectorAll(".viewer-tabs [data-view]");
tabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll(".viewer-body").forEach((p) => {
      p.hidden = p.dataset.panel !== tab.dataset.view;
    });
  }),
);

// ---------------------------------------------------------------------------
// Payment simulator: the contract's checks, in the contract's order.
// ---------------------------------------------------------------------------

const RULES = { allowlist: ["meetaminx-shop.testnet"], maxPerTx: 1, daily: 2, approveAbove: 0.5 };

export function evaluate({ receiver, amount, spent, paused }) {
  const steps = [];
  const stop = (label, reason) => {
    steps.push({ label, ok: false });
    return { steps, outcome: "blocked", message: `WARDLY: ${reason}` };
  };
  if (paused) return stop("Agent not paused", "wallet is paused by the owner");
  steps.push({ label: "Agent not paused", ok: true });
  if (!(amount > 0)) return stop("Amount above zero", "amount must be greater than zero");
  steps.push({ label: "Amount above zero", ok: true });
  if (!RULES.allowlist.includes(receiver)) return stop("Approved recipient", "recipient is not on the allowlist");
  steps.push({ label: "Approved recipient", ok: true });
  if (amount > RULES.maxPerTx) return stop(`At most ${RULES.maxPerTx} NEAR per payment`, "amount exceeds the per-transaction limit");
  steps.push({ label: `At most ${RULES.maxPerTx} NEAR per payment`, ok: true });
  if (amount > RULES.approveAbove) {
    steps.push({ label: `Above ${RULES.approveAbove} NEAR needs your approval`, ok: "held" });
    return { steps, outcome: "held", message: "Held for the owner. Nothing is sent until you approve it." };
  }
  steps.push({ label: `Under the ${RULES.approveAbove} NEAR approval limit`, ok: true });
  if (spent + amount > RULES.daily) return stop(`Within ${RULES.daily} NEAR today`, "payment would exceed the daily limit");
  steps.push({ label: `Within ${RULES.daily} NEAR today`, ok: true });
  return { steps, outcome: "sent", message: `Sent ${amount} NEAR to ${receiver}.` };
}

const simForm = document.getElementById("sim-form");
const simSteps = document.getElementById("sim-steps");
const simVerdict = document.getElementById("sim-verdict");
let simTimers = [];

function runSim(e) {
  e?.preventDefault();
  const num = (id) => Number(String(document.getElementById(id).value).replace(",", ".").trim());
  const result = evaluate({
    receiver: document.getElementById("sim-to").value,
    amount: num("sim-amount"),
    spent: Math.max(0, num("sim-spent") || 0),
    paused: document.getElementById("sim-paused").checked,
  });

  simTimers.forEach(clearTimeout);
  simTimers = [];
  simSteps.innerHTML = "";
  simVerdict.hidden = true;
  const gap = reduceMotion ? 0 : 280;

  result.steps.forEach((step, i) => {
    simTimers.push(
      setTimeout(() => {
        const li = document.createElement("li");
        li.className = step.ok === true ? "ok" : step.ok === "held" ? "held" : "fail";
        li.textContent = step.label;
        simSteps.append(li);
      }, i * gap),
    );
  });
  simTimers.push(
    setTimeout(() => {
      simVerdict.className = `sim-verdict ${result.outcome}`;
      const title = { sent: "Sent", held: "Held for approval", blocked: "Blocked" }[result.outcome];
      simVerdict.innerHTML = `<strong>${title}</strong><span></span>`;
      simVerdict.querySelector("span").textContent =
        result.outcome === "blocked" ? `${result.message}. No money moved.` : result.message;
      simVerdict.hidden = false;
    }, result.steps.length * gap),
  );
}

simForm.addEventListener("submit", runSim);
document.getElementById("sim-to").addEventListener("change", runSim);
document.getElementById("sim-paused").addEventListener("change", runSim);
runSim();

// ---------------------------------------------------------------------------
// Walkthrough: steps advance on their own; click a step to jump to it.
// ---------------------------------------------------------------------------

const frames = document.querySelectorAll(".wt-frame");
const stepEls = document.querySelectorAll(".wt-steps [data-step]");
const toggle = document.getElementById("wt-toggle");
let current = 0;
let playing = !reduceMotion;
let wtTimer;

function show(i) {
  current = i;
  frames.forEach((f) => f.classList.toggle("active", Number(f.dataset.frame) === i));
  stepEls.forEach((s) => s.classList.toggle("active", Number(s.dataset.step) === i));
}
function schedule() {
  clearTimeout(wtTimer);
  if (playing) wtTimer = setTimeout(() => (show((current + 1) % frames.length), schedule()), 3800);
  toggle.textContent = playing ? "Pause" : "Play";
}
stepEls.forEach((s) => {
  s.tabIndex = 0;
  s.setAttribute("role", "button");
  const go = () => {
    show(Number(s.dataset.step));
    schedule();
  };
  s.addEventListener("click", go);
  s.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
});
toggle.addEventListener("click", () => {
  playing = !playing;
  schedule();
});
show(0);
schedule();
