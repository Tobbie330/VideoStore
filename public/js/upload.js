(function () {
  'use strict';

  // ---- tag chips ----
  document.querySelectorAll('[data-tag-input]').forEach(function (box) {
    var hidden = box.querySelector('input[type=hidden]');
    var entry = box.querySelector('.tag-entry');
    var tags = hidden.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);

    function sync() {
      hidden.value = tags.join(', ');
      box.querySelectorAll('.chip').forEach(function (c) { c.remove(); });
      tags.forEach(function (t, i) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = '#' + t + ' ';
        var x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.setAttribute('aria-label', 'Remove ' + t);
        x.onclick = function () { tags.splice(i, 1); sync(); };
        chip.appendChild(x);
        box.insertBefore(chip, entry);
      });
    }
    function add(raw) {
      raw.split(',').forEach(function (t) {
        t = t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ');
        if (t && t.length <= 40 && tags.indexOf(t) === -1 && tags.length < 25) tags.push(t);
      });
      sync();
    }
    entry.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        add(entry.value);
        entry.value = '';
      } else if (e.key === 'Backspace' && !entry.value && tags.length) {
        tags.pop();
        sync();
      }
    });
    entry.addEventListener('blur', function () { if (entry.value) { add(entry.value); entry.value = ''; } });
    document.querySelectorAll('[data-add-tag]').forEach(function (b) {
      b.addEventListener('click', function () { add(b.dataset.addTag); });
    });
    box.addEventListener('click', function () { entry.focus(); });
    sync();
  });

  // ---- drag & drop + upload progress ----
  var form = document.getElementById('upload-form');
  if (!form) return;
  var dz = document.getElementById('dropzone');
  var input = document.getElementById('video-input');
  var label = dz.querySelector('.dz-file');
  var title = form.querySelector('input[name=title]');

  ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function () { dz.classList.add('drag'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function () { dz.classList.remove('drag'); }); });
  input.addEventListener('change', function () {
    var f = input.files[0];
    if (!f) { label.hidden = true; return; }
    label.hidden = false;
    label.textContent = f.name + ' · ' + (f.size / 1048576).toFixed(1) + ' MB';
    if (!title.value) title.value = f.name.replace(/\.[^.]+$/, '').replace(/[_.-]+/g, ' ').trim();
  });

  form.addEventListener('submit', function (e) {
    if (!window.XMLHttpRequest || !window.FormData) return;
    e.preventDefault();
    var entry = form.querySelector('.tag-entry');
    if (entry && entry.value) entry.dispatchEvent(new Event('blur'));
    var btn = document.getElementById('upload-btn');
    var bar = form.querySelector('.progress');
    var fill = bar.querySelector('.progress-bar');
    var text = bar.querySelector('.progress-text');
    btn.disabled = true;
    bar.hidden = false;

    var xhr = new XMLHttpRequest();
    xhr.open('POST', form.action);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = function (ev) {
      if (!ev.lengthComputable) return;
      var pct = Math.round(ev.loaded / ev.total * 100);
      fill.style.width = pct + '%';
      text.textContent = pct < 100 ? 'Uploading ' + pct + '%' : 'Finishing…';
    };
    xhr.onload = function () {
      var res = {};
      try { res = JSON.parse(xhr.responseText); } catch (err) { /* not JSON */ }
      if (xhr.status === 200 && res.ok) {
        text.textContent = 'Uploaded! Scanning for viruses…';
        location.href = res.redirect || '/studio';
      } else {
        btn.disabled = false;
        fill.style.width = '0';
        text.textContent = res.error || 'Upload failed (' + xhr.status + ')';
        alert(res.error || 'Upload failed. Please try again.');
      }
    };
    xhr.onerror = function () {
      btn.disabled = false;
      text.textContent = 'Network error — please try again.';
    };
    xhr.send(new FormData(form));
  });
})();
