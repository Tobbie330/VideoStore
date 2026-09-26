(function () {
  'use strict';
  var csrf = document.querySelector('meta[name=csrf]');
  csrf = csrf ? csrf.content : '';

  // Close dropdowns when clicking elsewhere.
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.dropdown[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  // Like / dislike without reloading the page.
  var vote = document.querySelector('.vote');
  if (vote) {
    vote.querySelector('form').addEventListener('submit', function (e) {
      var btn = e.submitter;
      if (!btn || !window.fetch) return;
      e.preventDefault();
      var body = new URLSearchParams({ _csrf: csrf, value: btn.value });
      fetch(this.action, { method: 'POST', body: body, headers: { Accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual' })
        .then(function (r) {
          if (r.type === 'opaqueredirect' || r.status === 401 || r.status === 0) { location.href = '/login'; return null; }
          return r.json();
        })
        .then(function (s) {
          if (!s) return;
          vote.querySelector('.likes').textContent = s.likes;
          vote.querySelector('.dislikes').textContent = s.n - s.likes;
          vote.querySelectorAll('.vote-btn').forEach(function (b) {
            var v = b.dataset.v;
            var on = b === btn && btn.value !== '0';
            b.classList.toggle('active', on);
            b.value = on ? '0' : v;
          });
        });
    });
  }
})();
