// Small enhancements for the landing page. The planner itself lives in app.js.
// Every link still works without this file: it only adds focus handling and photo fallbacks.

const finePointer = window.matchMedia('(pointer: fine)');

// "Plan my trip" links are ordinary links to the form, so the browser scrolls there itself.
// This also moves keyboard focus: to the first field when a mouse or trackpad is in use, or to
// the form heading on touch screens, so no on-screen keyboard pops up. It never submits the form.
document.querySelectorAll('a[data-plan-cta]').forEach((link) => {
  link.addEventListener('click', () => {
    const target = document.getElementById(finePointer.matches ? 'city' : 'form-title');
    if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
  });
});

// If a landing photo cannot load, hide the broken image and keep its caption on a plain panel.
function markMissing(img) {
  img.closest('figure')?.classList.add('is-missing');
}

document.querySelectorAll('.photo img, .postcard img').forEach((img) => {
  if (img.complete && img.naturalWidth === 0) markMissing(img);
  else img.addEventListener('error', () => markMissing(img), { once: true });
});
