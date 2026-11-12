// Intro: the W lead draws itself, "Wardly" appears, a full stop pops in,
// and the full stop floods the screen and opens the page through a circle.
//
// Plays once per visit (per browser tab session). Skipped when the visitor
// prefers reduced motion or arrives on a section link (e.g. /#proof).
// A click, tap or key press skips it. The decision to show it is made by a
// tiny inline script in index.html, so the page never flashes first.

const root = document.documentElement;
const overlay = document.getElementById("intro");

function finishInstantly(resolve) {
  root.classList.remove("intro-on");
  overlay?.remove();
  resolve();
}

window.__introDone = new Promise((resolve) => {
  if (!overlay || !root.classList.contains("intro-on")) return finishInstantly(resolve);

  try {
    sessionStorage.setItem("wardly.intro", "1");
  } catch {
    /* storage blocked: the intro just plays again next load */
  }

  const flood = overlay.querySelector(".intro-flood");
  const dot = overlay.querySelector(".intro-dot");
  const word = overlay.querySelector(".intro-word");
  const loop = overlay.querySelector(".intro-loop");
  const lead = overlay.querySelector(".intro-lead");
  const clip = overlay.querySelector(".intro-clip");

  let done = false;
  let raf = 0;
  const running = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const anim = (el, kf, opt) => {
    const a = el.animate(kf, { fill: "forwards", easing: "cubic-bezier(.2,.7,.2,1)", ...opt });
    running.push(a);
    return a.finished.catch(() => {});
  };

  function end() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    root.classList.remove("intro-on");
    overlay.remove();
    removeEventListener("pointerdown", skip, true);
    removeEventListener("keydown", skip, true);
    resolve();
  }

  // Skip: fade the overlay out quickly instead of cutting.
  function skip() {
    if (done) return;
    running.forEach((a) => a.pause());
    overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: "forwards" }).finished.then(end, end);
  }
  addEventListener("pointerdown", skip, true);
  addEventListener("keydown", skip, true);

  // Open a hole in the overlay that grows from (x, y) until the page shows.
  function openHole(x, y, ms) {
    return new Promise((r) => {
      const big = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 4;
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const t0 = performance.now();
      const step = (now) => {
        if (done) return r();
        const t = Math.min(1, (now - t0) / ms);
        const rad = ease(t) * big;
        const m = `radial-gradient(circle at ${x}px ${y}px, transparent ${rad}px, #000 ${rad + 1}px)`;
        overlay.style.webkitMaskImage = m;
        overlay.style.maskImage = m;
        if (t < 1) raf = requestAnimationFrame(step);
        else r();
      };
      raf = requestAnimationFrame(step);
    });
  }

  (async () => {
    // Wait briefly for the brand font so the wordmark doesn't swap mid-animation.
    await Promise.race([document.fonts?.ready, wait(700)]);
    if (done) return;
    await anim(loop, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 180 });
    await anim(lead, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 440, easing: "ease-in-out" });
    anim(clip, [{ transform: "scale(0)" }, { transform: "scale(1.2)" }, { transform: "scale(1)" }], { duration: 200 });
    await anim(word, [{ opacity: 0, transform: "translateX(-10px)" }, { opacity: 1, transform: "none" }], { duration: 300 });
    await wait(120);
    await anim(dot, [{ transform: "scale(0)" }, { transform: "scale(1.3)" }, { transform: "scale(1)" }], { duration: 240 });
    await wait(120);
    if (done) return;

    const r = dot.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const size = r.width;
    flood.style.left = `${x - size / 2}px`;
    flood.style.top = `${y - size / 2}px`;
    flood.style.width = flood.style.height = `${size}px`;
    const scale = (Math.hypot(innerWidth, innerHeight) * 2.1) / size;
    anim(flood, [{ transform: "scale(0)" }, { transform: `scale(${scale})` }], { duration: 620, easing: "cubic-bezier(.65,0,.35,1)" });
    await wait(200);
    await openHole(x, y, 650);
    end();
  })();
});
