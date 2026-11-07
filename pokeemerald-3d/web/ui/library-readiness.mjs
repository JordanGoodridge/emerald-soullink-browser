/* Call AFTER rendering the library into a hidden, layout-preserving root. */
export async function revealLibrary({ root, loader, dataReady = Promise.resolve(), timeout = 10000 }) {
  if (!root || !loader) throw new Error('Provide library root and loader elements.');
  root.style.visibility = 'hidden';
  root.inert = true;
  root.setAttribute('aria-busy', 'true');
  let timeoutId;
  let failure;
  try {
    await Promise.race([
      (async () => {
        await dataReady;
        // Give lazy images permission to load before waiting for decode.
        const images = [...root.querySelectorAll('img[data-loading-critical]')];
        images.forEach(img => { img.loading = 'eager'; });
        await Promise.all(images.map(img => img.decode().catch(() => {
          img.classList.add('image-unavailable');
          img.dispatchEvent(new CustomEvent('library-image-error', { bubbles: true }));
        })));
        if (document.fonts) await document.fonts.ready;
      })(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Library readiness timed out')), timeout);
      })
    ]);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timeoutId);
  }
  // No forced minimum wait. The app supplies fallback/error content if needed.
  if (failure) root.dispatchEvent(new CustomEvent('library-loading-error', { detail: failure, bubbles: true }));
  root.style.visibility = '';
  root.inert = false;
  root.setAttribute('aria-busy', 'false');
  loader.classList.add('is-leaving');
  const hide = () => { loader.hidden = true; };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) hide();
  else {
    loader.addEventListener('transitionend', hide, { once: true });
    setTimeout(hide, 220); // Cleanup fallback, not an artificial loading delay.
  }
  return { ok: !failure, error: failure };
}
