// READ-ONLY prestart check: paste into javascript_tool on the menu page.
// difficulty: the Nation difficulty button that looks selected (class or aria state), or null.
// nearest_nation_tiles: stub, null until the in-game object fields are confirmed.
(() => {
  const labels = ['Easy', 'Medium', 'Hard', 'Impossible'];
  const btns = [...document.querySelectorAll('button, [role=button], label')];
  const selected = btns.find(b => {
    const t = (b.textContent || '').trim();
    if (!labels.includes(t)) return false;
    const cls = b.className || '';
    return /selected|active|checked|chosen/i.test(cls) || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true';
  });
  const difficulty = selected ? selected.textContent.trim() : null;
  return { difficulty, nearest_nation_tiles: null, note: difficulty ? null : 'difficulty not readable; judge by eye on the highlighted button' };
})()
