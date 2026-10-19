// Progressive enhancements. Every form works without JavaScript.
(function () {
  'use strict';

  // Prevent double submission (the server is also idempotent).
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) { e.preventDefault(); return; }
    if (form.dataset.geo !== undefined && !form.dataset.geoDone && navigator.geolocation) {
      // Capture GPS if the device permits; submit regardless after a short timeout.
      e.preventDefault();
      var done = function () { form.dataset.geoDone = '1'; form.requestSubmit ? form.requestSubmit() : form.submit(); };
      var timer = setTimeout(done, 6000);
      navigator.geolocation.getCurrentPosition(function (pos) {
        clearTimeout(timer);
        setVal(form, 'lat', pos.coords.latitude); setVal(form, 'lng', pos.coords.longitude); setVal(form, 'accuracy', Math.round(pos.coords.accuracy));
        done();
      }, function () { clearTimeout(timer); done(); }, { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 });
      return;
    }
    var buttons = form.querySelectorAll('button[type=submit], button:not([type])');
    setTimeout(function () { buttons.forEach(function (b) { b.disabled = true; }); }, 0);
  });

  function setVal(form, name, value) {
    var input = form.querySelector('input[name="' + name + '"]');
    if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = name; form.appendChild(input); }
    input.value = value;
  }

  // Device-reported capture time from the selected file (stored separately from server timestamps).
  document.addEventListener('change', function (e) {
    var input = e.target;
    if (input.type === 'file' && input.dataset.deviceTime !== undefined && input.files && input.files[0]) {
      setVal(input.form, 'device_captured_at', new Date(input.files[0].lastModified).toISOString());
    }
    if (input.name === 'site_id' && input.form && input.form.dataset.booking !== undefined) filterBySite(input.form);
    if (input.name === 'method' && input.form && input.form.dataset.rule !== undefined) toggleRuleFields(input.form);
  });

  // Repeating line rows (invoice lines, materials).
  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-add-row]');
    if (add) {
      e.preventDefault();
      var container = document.getElementById(add.dataset.addRow);
      var tpl = container.querySelector('[data-row]');
      var clone = tpl.cloneNode(true);
      clone.querySelectorAll('input').forEach(function (i) { i.value = ''; });
      container.appendChild(clone);
    }
    var remove = e.target.closest('[data-remove-row]');
    if (remove) {
      e.preventDefault();
      var row = remove.closest('[data-row]');
      if (row.parentNode.querySelectorAll('[data-row]').length > 1) row.remove();
    }
  });

  function filterBySite(form) {
    var site = form.querySelector('[name=site_id]').value;
    form.querySelectorAll('[name=facility_id] option, [name=unit_id] option').forEach(function (o) {
      if (!o.value) return;
      var match = o.dataset.site === site;
      o.hidden = !match; o.disabled = !match;
      if (!match && o.selected) o.parentNode.value = '';
    });
  }

  function toggleRuleFields(form) {
    var method = form.querySelector('[name=method]').value;
    form.querySelectorAll('[data-method]').forEach(function (el) { el.hidden = el.dataset.method.split(' ').indexOf(method) === -1; });
  }

  document.querySelectorAll('form[data-booking]').forEach(filterBySite);
  document.querySelectorAll('form[data-rule]').forEach(toggleRuleFields);
})();
