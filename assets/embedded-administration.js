(function () {
  if (window.parent === window || new URLSearchParams(window.location.search).get('embedded') !== '1') return;
  document.documentElement.classList.add('embedded-administration');
  document.querySelectorAll('a[href]').forEach((link) => {
    link.target = link.id === 'audienceViewLink' ? '_blank' : '_top';
    if (link.target === '_blank') link.rel = 'noopener';
  });
})();
